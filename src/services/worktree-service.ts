import { dirname, isAbsolute, resolve } from "node:path";
import { Effect, ServiceMap } from "effect";
import type { WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import { pathExists } from "./filesystem";
import { execProcess, getProcessErrorMessage, runProcess } from "./process";

export interface Worktree {
  path: string;
  branch: string;
  commit: string;
  isBare: boolean;
}

export type CreateWorktreeResult =
  | { _tag: "Created"; path: string }
  | { _tag: "AlreadyExists"; path: string }
  | { _tag: "PathConflict"; path: string; existingBranch?: string };

export type RemoveWorktreeResult =
  | { _tag: "Removed"; path: string }
  | { _tag: "BlockedByChanges"; path: string };

export interface WorktreeService {
  getMainRepoPath: (
    cwd?: string,
  ) => Effect.Effect<string | null, WctError, WctServices>;
  getCurrentBranch: (
    cwd?: string,
  ) => Effect.Effect<string | null, WctError, WctServices>;
  getMainWorktreePath: (
    cwd?: string,
  ) => Effect.Effect<string | null, WctError, WctServices>;
  isGitRepo: (cwd?: string) => Effect.Effect<boolean, WctError, WctServices>;
  listWorktrees: (
    cwd?: string,
  ) => Effect.Effect<Worktree[], WctError, WctServices>;
  createWorktree: (
    path: string,
    branch: string,
    useExisting: boolean,
    base?: string,
  ) => Effect.Effect<CreateWorktreeResult, WctError, WctServices>;
  branchExists: (
    branch: string,
    cwd?: string,
  ) => Effect.Effect<boolean, WctError, WctServices>;
  remoteBranchExists: (
    branch: string,
    cwd?: string,
  ) => Effect.Effect<boolean, WctError, WctServices>;
  removeWorktree: (
    path: string,
    force?: boolean,
  ) => Effect.Effect<RemoveWorktreeResult, WctError, WctServices>;
  findWorktreeByBranch: (
    branch: string,
    cwd?: string,
  ) => Effect.Effect<Worktree | null, WctError, WctServices>;
  getChangedFileCount: (
    cwd: string,
  ) => Effect.Effect<number, WctError, WctServices>;
  getAheadBehind: (
    cwd: string,
    ref: string,
  ) => Effect.Effect<
    { ahead: number; behind: number } | null,
    WctError,
    WctServices
  >;
  getDefaultBranch: (
    cwd: string,
  ) => Effect.Effect<string | null, WctError, WctServices>;
  listBranches: (cwd: string) => Effect.Effect<string[], WctError, WctServices>;
}

export const WorktreeService = ServiceMap.Service<WorktreeService>(
  "wct/WorktreeService",
);

function extractShellError(error: unknown): string {
  const message = getProcessErrorMessage(error);
  const errorLines = message
    .split("\n")
    .filter((line) => /^(fatal|error):/.test(line));

  if (errorLines.length > 0) {
    return errorLines.join("\n");
  }

  return message;
}

function listWorktreesImpl(cwd?: string) {
  return execProcess(
    "git",
    ["worktree", "list", "--porcelain"],
    cwd ? { cwd } : undefined,
  ).pipe(Effect.map((result) => parseWorktreeListOutput(result.stdout)));
}

function resolveMainRepoPathFromGitDirs(
  topLevelPath: string | null,
  gitCommonDir: string | null,
): string | null {
  if (!gitCommonDir) {
    return topLevelPath;
  }

  const commonDir = gitCommonDir;
  if (commonDir === ".git") {
    return topLevelPath;
  }

  const absoluteCommonDir =
    topLevelPath && !isAbsolute(commonDir)
      ? resolve(topLevelPath, commonDir)
      : commonDir;

  return absoluteCommonDir.endsWith("/.git")
    ? dirname(absoluteCommonDir)
    : topLevelPath;
}

export function parseWorktreeListOutput(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Partial<Worktree> = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) {
        worktrees.push(current as Worktree);
      }
      current = { path: line.slice(9), isBare: false };
    } else if (line.startsWith("HEAD ")) {
      current.commit = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.isBare = true;
    } else if (line === "detached") {
      current.branch = "(detached)";
    }
  }

  if (current.path) {
    worktrees.push(current as Worktree);
  }

  return worktrees;
}

export function parseGitStatusCount(output: string): number {
  const trimmed = output.trim();
  return trimmed ? trimmed.split("\n").length : 0;
}

export function parseAheadBehind(
  output: string,
): { ahead: number; behind: number } | null {
  const parts = output.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const ahead = Number.parseInt(parts[0] ?? "0", 10);
  const behind = Number.parseInt(parts[1] ?? "0", 10);
  return {
    ahead: Number.isNaN(ahead) ? 0 : ahead,
    behind: Number.isNaN(behind) ? 0 : behind,
  };
}

function getChangedFileCountImpl(cwd: string) {
  return Effect.catch(
    execProcess("git", ["status", "--porcelain"], { cwd }).pipe(
      Effect.map((result) => parseGitStatusCount(result.stdout)),
    ),
    () => Effect.succeed(0),
  );
}

function getAheadBehindImpl(cwd: string, ref: string) {
  return Effect.catch(
    execProcess(
      "git",
      ["rev-list", "--left-right", "--count", `HEAD...${ref}`],
      { cwd },
    ).pipe(Effect.map((result) => parseAheadBehind(result.stdout))),
    () => Effect.succeed(null),
  );
}

function getDefaultBranchImpl(cwd: string) {
  return Effect.gen(function* () {
    const symbolicRef = yield* Effect.catch(
      execProcess(
        "git",
        ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
        { cwd },
      ).pipe(Effect.map((result) => result.stdout.trim())),
      () => Effect.succeed(""),
    );
    if (symbolicRef) return symbolicRef;

    for (const candidate of ["main", "master"]) {
      const exists = yield* runProcess(
        "git",
        ["rev-parse", "--verify", candidate],
        { cwd },
      ).pipe(Effect.map((result) => result.success));
      if (exists) return candidate;
    }
    return null;
  });
}

function listBranchesImpl(cwd: string) {
  return Effect.catch(
    execProcess("git", ["branch", "--format=%(refname:short)"], { cwd }).pipe(
      Effect.map((result) => result.stdout.split("\n").filter(Boolean)),
    ),
    () => Effect.succeed([] as string[]),
  );
}

export const liveWorktreeService: WorktreeService = WorktreeService.of({
  getMainRepoPath: (cwd) =>
    Effect.gen(function* () {
      const worktrees = yield* Effect.catch(listWorktreesImpl(cwd), () =>
        Effect.succeed([]),
      );
      const mainWorktreePath = worktrees[0]?.path ?? null;
      if (mainWorktreePath) {
        return mainWorktreePath;
      }

      const [topLevelPath, gitCommonDir] = yield* Effect.all([
        Effect.catch(
          execProcess(
            "git",
            ["rev-parse", "--show-toplevel"],
            cwd ? { cwd } : undefined,
          ).pipe(Effect.map((result) => result.stdout.trim())),
          () => Effect.succeed(null),
        ),
        Effect.catch(
          execProcess(
            "git",
            ["rev-parse", "--git-common-dir"],
            cwd ? { cwd } : undefined,
          ).pipe(Effect.map((result) => result.stdout.trim())),
          () => Effect.succeed(null),
        ),
      ]);

      return resolveMainRepoPathFromGitDirs(topLevelPath, gitCommonDir);
    }).pipe(
      Effect.mapError((error) =>
        commandError(
          "worktree_error",
          "Failed to determine main repository path",
          error,
        ),
      ),
    ),
  getCurrentBranch: (cwd) =>
    Effect.gen(function* () {
      const branch = yield* Effect.catch(
        execProcess(
          "git",
          ["rev-parse", "--abbrev-ref", "HEAD"],
          cwd ? { cwd } : undefined,
        ).pipe(Effect.map((result) => result.stdout.trim())),
        () => Effect.succeed(null),
      );
      if (!branch || branch === "HEAD") {
        return null;
      }
      return branch;
    }).pipe(
      Effect.mapError((error) =>
        commandError(
          "worktree_error",
          "Failed to determine current branch",
          error,
        ),
      ),
    ),
  getMainWorktreePath: (cwd) =>
    Effect.gen(function* () {
      const worktrees = yield* listWorktreesImpl(cwd);
      return worktrees[0]?.path ?? null;
    }).pipe(
      Effect.mapError((error) =>
        commandError("worktree_error", "Failed to list worktrees", error),
      ),
    ),
  isGitRepo: (cwd) =>
    runProcess(
      "git",
      ["rev-parse", "--git-dir"],
      cwd ? { cwd } : undefined,
    ).pipe(
      Effect.map((result) => result.success),
      Effect.mapError((error) =>
        commandError("not_git_repo", "Failed to inspect git repository", error),
      ),
    ),
  listWorktrees: (cwd) =>
    listWorktreesImpl(cwd).pipe(
      Effect.mapError((error) =>
        commandError("worktree_error", "Failed to list worktrees", error),
      ),
    ),
  createWorktree: (path, branch, useExisting, base) =>
    Effect.gen(function* () {
      const exists = yield* pathExists(path);

      if (exists) {
        const worktrees = yield* listWorktreesImpl();
        const existing = worktrees.find((worktree) => worktree.path === path);
        if (existing?.branch === branch) {
          return {
            _tag: "AlreadyExists" as const,
            path,
          };
        }

        if (existing) {
          return {
            _tag: "PathConflict" as const,
            path,
            existingBranch: existing.branch,
          };
        }

        return {
          _tag: "PathConflict" as const,
          path,
        };
      }

      if (useExisting) {
        yield* execProcess("git", ["worktree", "add", path, branch]);
      } else if (base) {
        yield* execProcess("git", [
          "worktree",
          "add",
          "-b",
          branch,
          path,
          base,
        ]);
      } else {
        yield* execProcess("git", ["worktree", "add", "-b", branch, path]);
      }

      return { _tag: "Created" as const, path };
    }).pipe(
      Effect.catch((error) =>
        Effect.fail(
          commandError("worktree_error", extractShellError(error), error),
        ),
      ),
      Effect.mapError((error) =>
        commandError(
          "worktree_error",
          `Failed to create worktree '${branch}' at '${path}'`,
          error,
        ),
      ),
    ),
  branchExists: (branch, cwd) =>
    runProcess(
      "git",
      ["rev-parse", "--verify", branch],
      cwd ? { cwd } : undefined,
    ).pipe(
      Effect.map((result) => result.success),
      Effect.mapError((error) =>
        commandError(
          "worktree_error",
          `Failed to verify branch '${branch}'`,
          error,
        ),
      ),
    ),
  remoteBranchExists: (branch, cwd) =>
    runProcess(
      "git",
      ["rev-parse", "--verify", `origin/${branch}`],
      cwd ? { cwd } : undefined,
    ).pipe(
      Effect.map((result) => result.success),
      Effect.mapError((error) =>
        commandError(
          "worktree_error",
          `Failed to verify remote branch '${branch}'`,
          error,
        ),
      ),
    ),
  removeWorktree: (path, force = false) =>
    Effect.gen(function* () {
      const args = force
        ? ["worktree", "remove", "--force", path]
        : ["worktree", "remove", path];
      yield* execProcess("git", args);
      return { _tag: "Removed" as const, path };
    }).pipe(
      Effect.catch((error) => {
        const message = extractShellError(error);
        if (/contains modified or untracked files/i.test(message)) {
          return Effect.succeed({ _tag: "BlockedByChanges" as const, path });
        }
        return Effect.fail(
          commandError("worktree_remove_failed", message, error),
        );
      }),
      Effect.mapError((error) =>
        commandError(
          "worktree_remove_failed",
          `Failed to remove worktree '${path}'`,
          error,
        ),
      ),
    ),
  findWorktreeByBranch: (branch, cwd) =>
    Effect.gen(function* () {
      const worktrees = yield* listWorktreesImpl(cwd);
      return worktrees.find((worktree) => worktree.branch === branch) ?? null;
    }).pipe(
      Effect.mapError((error) =>
        commandError(
          "worktree_error",
          `Failed to find worktree for branch '${branch}'`,
          error,
        ),
      ),
    ),
  getChangedFileCount: (cwd) =>
    Effect.mapError(getChangedFileCountImpl(cwd), (error) =>
      commandError("worktree_error", "Failed to get changed file count", error),
    ),
  getAheadBehind: (cwd, ref) =>
    Effect.mapError(getAheadBehindImpl(cwd, ref), (error) =>
      commandError(
        "worktree_error",
        "Failed to get ahead/behind counts",
        error,
      ),
    ),
  getDefaultBranch: (cwd) =>
    Effect.mapError(getDefaultBranchImpl(cwd), (error) =>
      commandError(
        "worktree_error",
        "Failed to determine default branch",
        error,
      ),
    ),
  listBranches: (cwd) =>
    Effect.mapError(listBranchesImpl(cwd), (error) =>
      commandError("worktree_error", "Failed to list branches", error),
    ),
});
