import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { getGlobalConfigPath, loadConfig } from "../config/loader";
import { commandError } from "../errors";
import { gitCommonDirectory } from "./git-directory";
import {
  canonicalSessionTarget,
  type WorkspaceSession,
  type WorkspaceSessionTarget,
} from "./session-identity";
import { TmuxService } from "./tmux";
import { WorktreeService } from "./worktree-service";

/** Retained across confirmation, lock waits and removal-only retries. */
export interface WorkspaceTargetEvidence {
  target: WorkspaceSessionTarget;
  path: string;
  repoPath: string;
  coordinationBranch: string;
  checkout: string | null;
  registration: {
    entry: string;
    directory: string;
    generation: string | null;
  } | null;
  config: string;
  session: WorkspaceSession | null;
}

function stamp(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

function registration(
  path: string,
  mainRepoPath: string,
): WorkspaceTargetEvidence["registration"] {
  const git = join(path, ".git");
  const id = stamp(git);
  if (!id) {
    const worktrees = join(gitCommonDirectory(mainRepoPath), "worktrees");
    if (!stamp(worktrees)) return null;
    const matches = readdirSync(worktrees).flatMap((name) => {
      const directory = join(worktrees, name);
      let pointer: string;
      try {
        pointer = readFileSync(join(directory, "gitdir"), "utf8");
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [];
        throw error;
      }
      if (resolve(pointer.trim()) !== join(path, ".git")) return [];
      const generation = stamp(directory);
      return [{ entry: "missing", directory, generation }];
    });
    if (matches.length > 1)
      throw new Error("Ambiguous missing worktree registration");
    return matches[0] ?? null;
  }
  if (lstatSync(git).isDirectory())
    return { entry: id, directory: git, generation: id };
  const pointer = readFileSync(git, "utf8");
  if (!pointer.startsWith("gitdir: "))
    throw new Error("Invalid worktree Git registration");
  const dir = resolve(path, pointer.slice(8).trim());
  return { entry: id, directory: dir, generation: stamp(dir) };
}

export interface WorkspaceConfirmation {
  target: WorkspaceSessionTarget;
  checkout: string | null;
  registration: WorkspaceTargetEvidence["registration"];
  configFiles: string;
  session: { name: string; id?: string; server?: string } | null;
}

export function captureWorkspaceConfirmation(
  target: WorkspaceSessionTarget,
  session: WorkspaceSession | null,
): WorkspaceConfirmation {
  const config = new Bun.CryptoHasher("sha256");
  for (const path of [
    getGlobalConfigPath(),
    join(target.mainRepoPath, ".wct.yaml"),
  ]) {
    try {
      config.update("file\0").update(readFileSync(path));
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
      config.update("missing\0");
    }
  }
  return {
    target,
    checkout: stamp(target.worktreePath),
    registration: registration(target.worktreePath, target.mainRepoPath),
    configFiles: config.digest("hex"),
    session: session
      ? { name: session.name, id: session.id, server: session.server }
      : null,
  };
}

export function assertWorkspaceConfirmation(
  confirmed: WorkspaceConfirmation,
  current: WorkspaceTargetEvidence,
) {
  return Effect.gen(function* () {
    const target = yield* canonicalSessionTarget(confirmed.target);
    const latest = yield* Effect.try({
      try: () => captureWorkspaceConfirmation(current.target, current.session),
      catch: (error) =>
        commandError(
          "worktree_error",
          "Cannot revalidate confirmed Workspace",
          error,
        ),
    });
    if (
      JSON.stringify(target) !== JSON.stringify(current.target) ||
      confirmed.checkout !== latest.checkout ||
      JSON.stringify(confirmed.registration) !==
        JSON.stringify(latest.registration) ||
      confirmed.configFiles !== latest.configFiles ||
      JSON.stringify(confirmed.session) !== JSON.stringify(latest.session)
    )
      return yield* commandError(
        "worktree_error",
        "Confirmed Workspace target, session or configuration changed; confirm the action again",
      );
  });
}

export function inspectWorkspaceTarget(worktreePath: string, cwd?: string) {
  return Effect.gen(function* () {
    const worktree = yield* WorktreeService;
    const exists = yield* worktree.isGitRepo(worktreePath);
    const root = exists
      ? yield* worktree.getWorktreeRoot(worktreePath)
      : resolve(worktreePath);
    const mainRepoPath = yield* worktree.getMainRepoPath(exists ? root : cwd);
    if (!mainRepoPath)
      return yield* commandError(
        "worktree_error",
        "Cannot determine Main Repository for Workspace target",
      );
    let branch = exists ? yield* worktree.getCurrentBranch(root) : null;
    if (!exists) {
      const trees = yield* worktree.listWorktrees(mainRepoPath);
      const tree = trees.find(
        (tree) => resolve(tree.path) === root && !tree.isBare,
      );
      if (!tree)
        return yield* commandError(
          "worktree_not_found",
          `No registered Workspace at '${root}'`,
        );
      branch = tree.branch === "(detached)" ? null : tree.branch;
    }
    const target = yield* canonicalSessionTarget({
      mainRepoPath,
      branch: branch ?? "",
      worktreePath: root,
    });
    const session = yield* TmuxService.use((service) =>
      service.resolveSession(target, undefined, { readOnly: true }),
    );
    // Detached HEAD uses the empty branch consistently, including after its session stops.
    const coordinationBranch = target.branch;
    if (exists)
      yield* loadConfig(target.mainRepoPath).pipe(
        Effect.mapError((error) =>
          commandError("config_error", error.message, error),
        ),
      );
    const evidence = yield* Effect.try({
      try: () => ({
        target,
        path: root,
        repoPath: mainRepoPath,
        coordinationBranch,
        checkout: stamp(target.worktreePath),
        registration: registration(target.worktreePath, target.mainRepoPath),
        config: captureWorkspaceConfirmation(target, session).configFiles,
        session: session
          ? {
              name: session.name,
              id: session.id,
              server: session.server,
              ownership: session.ownership,
            }
          : null,
      }),
      catch: (error) =>
        commandError(
          "worktree_error",
          "Cannot inspect Workspace target evidence",
          error,
        ),
    });
    return evidence;
  });
}

export function assertWorkspaceTarget(
  expected: WorkspaceTargetEvidence,
  options: { removalOnly?: boolean; afterScripts?: boolean } = {},
) {
  return Effect.gen(function* () {
    const current = yield* inspectWorkspaceTarget(
      expected.path,
      expected.repoPath,
    );
    const missing = options.removalOnly && current.checkout === null;
    if (
      JSON.stringify(current.target) !== JSON.stringify(expected.target) ||
      (!missing &&
        (current.checkout !== expected.checkout ||
          JSON.stringify(current.registration) !==
            JSON.stringify(expected.registration))) ||
      (!options.afterScripts && current.config !== expected.config) ||
      JSON.stringify(
        current.session
          ? [current.session.id, current.session.server, current.session.name]
          : null,
      ) !==
        JSON.stringify(
          expected.session
            ? [
                expected.session.id,
                expected.session.server,
                expected.session.name,
              ]
            : null,
        )
    ) {
      return yield* commandError(
        "worktree_error",
        "Workspace target, session or configuration changed; inspect it and confirm the action again",
      );
    }
    if (missing && expected.registration) {
      const retained = expected.registration;
      const generation = yield* Effect.try({
        try: () => stamp(retained.directory),
        catch: (error) =>
          commandError(
            "worktree_error",
            "Cannot inspect retained worktree registration",
            error,
          ),
      });
      if (
        generation !== retained.generation ||
        current.registration?.directory !== retained.directory ||
        current.registration?.generation !== retained.generation
      )
        return yield* commandError(
          "worktree_error",
          "Retained worktree registration changed; confirm Close again",
        );
      current.registration = retained;
    }
    return current;
  });
}
