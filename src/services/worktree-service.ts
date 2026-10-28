import { dirname, isAbsolute, resolve } from "node:path";
import type { BunServices } from "@effect/platform-bun";
import { Context, Effect, FileSystem } from "effect";
import {
  captureBunService,
  type ServiceImplementation,
} from "../effect/service-context";
import { commandError, type WctError } from "../errors";
import * as logger from "../utils/logger";
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

export interface WorktreeStatusOptions {
  logWarnings?: boolean;
}

export interface WorktreeService {
  getWorktreeRoot: (cwd: string) => Effect.Effect<string, WctError>;
  getMainRepoPath: (cwd?: string) => Effect.Effect<string | null, WctError>;
  getCurrentBranch: (cwd?: string) => Effect.Effect<string | null, WctError>;
  getMainWorktreePath: (cwd?: string) => Effect.Effect<string | null, WctError>;
  isGitRepo: (cwd?: string) => Effect.Effect<boolean, WctError>;
  listWorktrees: (cwd?: string) => Effect.Effect<Worktree[], WctError>;
  fetchRemotes: (cwd: string) => Effect.Effect<void, WctError>;
  createWorktree: (
    path: string,
    branch: string,
    useExisting: boolean,
    base?: string,
    cwd?: string,
    pushRemote?: string,
  ) => Effect.Effect<CreateWorktreeResult, WctError>;
  branchExists: (
    branch: string,
    cwd?: string,
  ) => Effect.Effect<boolean, WctError>;
  removeWorktree: (
    path: string,
    force?: boolean,
    cwd?: string,
  ) => Effect.Effect<RemoveWorktreeResult, WctError>;
  findWorktreeByBranch: (
    branch: string,
    cwd?: string,
  ) => Effect.Effect<Worktree | null, WctError>;
  getChangedFileCount: (
    cwd: string,
    options?: WorktreeStatusOptions,
  ) => Effect.Effect<number, WctError>;
  getAheadBehind: (
    cwd: string,
    ref: string,
    options?: WorktreeStatusOptions,
  ) => Effect.Effect<{ ahead: number; behind: number } | null, WctError>;
  getDefaultBranch: (cwd: string) => Effect.Effect<string | null, WctError>;
  listBranches: (cwd: string) => Effect.Effect<string[], WctError>;
}

export const WorktreeService = Context.Service<WorktreeService>(
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

function pendingPushRemoteKey(branch: string): string {
  return `branch.${branch}.wctPushRemotePending`;
}

function finishPendingPushRemote(branch: string, cwd?: string) {
  return Effect.gen(function* () {
    const options = cwd ? { cwd } : undefined;
    const pending = yield* runProcess(
      "git",
      ["config", "--local", "--get", pendingPushRemoteKey(branch)],
      options,
    );
    if (!pending.success) {
      if (pending.exitCode === 1) return;
      return yield* commandError(
        "worktree_error",
        `Failed to read pending push remote for '${branch}': ${pending.stderr.trim()}`,
      );
    }

    const remote = pending.stdout.trim();
    yield* execProcess("git", ["remote", "get-url", "--", remote], options);
    yield* execProcess(
      "git",
      ["config", "--local", `branch.${branch}.pushRemote`, remote],
      options,
    );
    yield* execProcess(
      "git",
      ["config", "--local", "--unset-all", pendingPushRemoteKey(branch)],
      options,
    );
  });
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

export function formatChanges(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

export function formatSync(
  sync: { ahead: number; behind: number } | null,
): string {
  if (!sync) return "?";
  const { ahead, behind } = sync;
  if (ahead === 0 && behind === 0) return "\u2713";
  const parts: string[] = [];
  if (ahead > 0) parts.push(`\u2191${ahead}`);
  if (behind > 0) parts.push(`\u2193${behind}`);
  return parts.join(" ");
}

function getChangedFileCountImpl(
  cwd: string,
  options: WorktreeStatusOptions = {},
) {
  const logWarnings = options.logWarnings ?? true;
  return Effect.catch(
    execProcess("git", ["status", "--porcelain"], { cwd }).pipe(
      Effect.map((result) => parseGitStatusCount(result.stdout)),
    ),
    (error) => {
      if (!logWarnings) {
        return Effect.succeed(0);
      }

      return logger
        .warn(
          `Failed to get changes for ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .pipe(Effect.as(0));
    },
  );
}

function getAheadBehindImpl(
  cwd: string,
  ref: string,
  options: WorktreeStatusOptions = {},
) {
  const logWarnings = options.logWarnings ?? true;
  return Effect.catch(
    execProcess(
      "git",
      ["rev-list", "--left-right", "--count", `HEAD...${ref}`],
      { cwd },
    ).pipe(Effect.map((result) => parseAheadBehind(result.stdout))),
    (error) => {
      if (!logWarnings) {
        return Effect.succeed(null);
      }

      return logger
        .warn(
          `Failed to get sync status for ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .pipe(Effect.as(null));
    },
  );
}

function getDefaultBranchImpl(cwd: string) {
  return Effect.gen(function* () {
    const symbolicRef = yield* Effect.orElseSucceed(
      execProcess(
        "git",
        ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
        { cwd },
      ).pipe(Effect.map((result) => result.stdout.trim())),
      () => "",
    );
    if (symbolicRef) return symbolicRef;

    for (const candidate of [
      "origin/main",
      "origin/master",
      "main",
      "master",
    ]) {
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
  return Effect.orElseSucceed(
    execProcess("git", ["branch", "--format=%(refname:short)"], { cwd }).pipe(
      Effect.map((result) => result.stdout.split("\n").filter(Boolean)),
    ),
    () => [] as string[],
  );
}

export type WorktreeServiceImplementation = ServiceImplementation<
  WorktreeService,
  BunServices.BunServices
>;

export const liveWorktreeService: WorktreeServiceImplementation = {
  getWorktreeRoot: (cwd) =>
    execProcess("git", ["rev-parse", "--show-toplevel"], { cwd }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.mapError((error) =>
        commandError(
          "worktree_error",
          "Failed to resolve checkout root",
          error,
        ),
      ),
    ),
  getMainRepoPath: (cwd) =>
    Effect.gen(function* () {
      const worktrees = yield* Effect.orElseSucceed(
        listWorktreesImpl(cwd),
        () => [],
      );
      const mainWorktreePath = worktrees[0]?.path ?? null;
      if (mainWorktreePath) {
        return mainWorktreePath;
      }

      const [topLevelPath, gitCommonDir] = yield* Effect.all([
        Effect.orElseSucceed(
          execProcess(
            "git",
            ["rev-parse", "--show-toplevel"],
            cwd ? { cwd } : undefined,
          ).pipe(Effect.map((result) => result.stdout.trim())),
          () => null,
        ),
        Effect.orElseSucceed(
          execProcess(
            "git",
            ["rev-parse", "--git-common-dir"],
            cwd ? { cwd } : undefined,
          ).pipe(Effect.map((result) => result.stdout.trim())),
          () => null,
        ),
      ]);

      return resolveMainRepoPathFromGitDirs(topLevelPath, gitCommonDir);
    }),
  getCurrentBranch: (cwd) =>
    Effect.gen(function* () {
      const branch = yield* Effect.orElseSucceed(
        execProcess(
          "git",
          ["rev-parse", "--abbrev-ref", "HEAD"],
          cwd ? { cwd } : undefined,
        ).pipe(Effect.map((result) => result.stdout.trim())),
        () => null,
      );
      if (!branch || branch === "HEAD") {
        return null;
      }
      return branch;
    }),
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
    ).pipe(Effect.map((result) => result.success)),
  listWorktrees: (cwd) =>
    listWorktreesImpl(cwd).pipe(
      Effect.mapError((error) =>
        commandError("worktree_error", "Failed to list worktrees", error),
      ),
    ),
  fetchRemotes: (cwd) =>
    execProcess("git", ["fetch", "--all"], { cwd }).pipe(
      Effect.asVoid,
      Effect.mapError((error) =>
        commandError(
          "worktree_error",
          `Failed to fetch remotes: ${extractShellError(error)}`,
          error,
        ),
      ),
    ),
  createWorktree: (path, branch, useExisting, base, cwd, pushRemote) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exists = yield* fs.exists(path);

      if (exists) {
        const worktrees = yield* listWorktreesImpl(cwd);
        const existing = worktrees.find((worktree) => worktree.path === path);
        if (existing?.branch === branch) {
          yield* finishPendingPushRemote(branch, cwd);
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

      if (!useExisting && pushRemote) {
        yield* execProcess(
          "git",
          ["remote", "get-url", "--", pushRemote],
          cwd ? { cwd } : undefined,
        );
        yield* execProcess(
          "git",
          ["check-ref-format", "--branch", branch],
          cwd ? { cwd } : undefined,
        );
        const localBranch = yield* runProcess(
          "git",
          ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
          cwd ? { cwd } : undefined,
        );
        if (localBranch.success) {
          return yield* commandError(
            "worktree_error",
            `A branch named '${branch}' already exists`,
          );
        }
        if (localBranch.exitCode !== 1) {
          return yield* commandError(
            "worktree_error",
            `Failed to check branch '${branch}': ${localBranch.stderr.trim()}`,
          );
        }
        // Record the intent before creation so a later config-write failure can resume.
        yield* execProcess(
          "git",
          ["config", "--local", pendingPushRemoteKey(branch), pushRemote],
          cwd ? { cwd } : undefined,
        );
      }

      const args = useExisting
        ? ["worktree", "add", path, branch]
        : ["worktree", "add", "-b", branch, path, ...(base ? [base] : [])];
      yield* execProcess("git", args, cwd ? { cwd } : undefined).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (!useExisting && pushRemote) {
              const localBranch = yield* runProcess(
                "git",
                ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
                cwd ? { cwd } : undefined,
              );
              if (!localBranch.success && localBranch.exitCode === 1) {
                yield* execProcess(
                  "git",
                  [
                    "config",
                    "--local",
                    "--unset-all",
                    pendingPushRemoteKey(branch),
                  ],
                  cwd ? { cwd } : undefined,
                );
              }
            }
            return yield* Effect.fail(error);
          }),
        ),
      );

      yield* finishPendingPushRemote(branch, cwd);

      return { _tag: "Created" as const, path };
    }).pipe(
      Effect.mapError((error) =>
        commandError("worktree_error", extractShellError(error), error),
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
    ).pipe(Effect.map((result) => result.success)),
  removeWorktree: (path, force = false, cwd) =>
    Effect.gen(function* () {
      const args = force
        ? ["worktree", "remove", "--force", path]
        : ["worktree", "remove", path];
      yield* execProcess("git", args, cwd ? { cwd } : undefined);
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
  getChangedFileCount: getChangedFileCountImpl,
  getAheadBehind: getAheadBehindImpl,
  getDefaultBranch: getDefaultBranchImpl,
  listBranches: listBranchesImpl,
};

export function makeWorktreeService(
  implementation: WorktreeServiceImplementation = liveWorktreeService,
) {
  return captureBunService<WorktreeService>(implementation);
}
