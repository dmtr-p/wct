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
  | { _tag: "PathConflict"; path: string; existingBranch: string };

export type RemoveWorktreeResult =
  | { _tag: "Removed"; path: string }
  | { _tag: "BlockedByChanges"; path: string };

export interface WorktreeService {
  getMainRepoPath: () => Effect.Effect<string | null, WctError, WctServices>;
  getCurrentBranch: () => Effect.Effect<string | null, WctError, WctServices>;
  getMainWorktreePath: () => Effect.Effect<
    string | null,
    WctError,
    WctServices
  >;
  isGitRepo: () => Effect.Effect<boolean, WctError, WctServices>;
  listWorktrees: () => Effect.Effect<Worktree[], WctError, WctServices>;
  createWorktree: (
    path: string,
    branch: string,
    useExisting: boolean,
    base?: string,
  ) => Effect.Effect<CreateWorktreeResult, WctError, WctServices>;
  branchExists: (
    branch: string,
  ) => Effect.Effect<boolean, WctError, WctServices>;
  remoteBranchExists: (
    branch: string,
  ) => Effect.Effect<boolean, WctError, WctServices>;
  removeWorktree: (
    path: string,
    force?: boolean,
  ) => Effect.Effect<RemoveWorktreeResult, WctError, WctServices>;
  findWorktreeByBranch: (
    branch: string,
  ) => Effect.Effect<Worktree | null, WctError, WctServices>;
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

function listWorktreesImpl() {
  return Effect.catch(
    execProcess("git", ["worktree", "list", "--porcelain"]).pipe(
      Effect.map((result) => parseWorktreeListOutput(result.stdout)),
    ),
    () => Effect.succeed([]),
  );
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

export const liveWorktreeService: WorktreeService = WorktreeService.of({
  getMainRepoPath: () =>
    Effect.gen(function* () {
      const worktrees = yield* listWorktreesImpl();
      const mainWorktreePath = worktrees[0]?.path ?? null;
      if (mainWorktreePath) {
        return mainWorktreePath;
      }

      return yield* Effect.catch(
        execProcess("git", ["rev-parse", "--show-toplevel"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
        () => Effect.succeed(null),
      );
    }).pipe(
      Effect.mapError((error) =>
        commandError(
          "worktree_error",
          "Failed to determine main repository path",
          error,
        ),
      ),
    ),
  getCurrentBranch: () =>
    Effect.gen(function* () {
      const branch = yield* Effect.catch(
        execProcess("git", ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
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
  getMainWorktreePath: () =>
    Effect.gen(function* () {
      const worktrees = yield* listWorktreesImpl();
      return worktrees[0]?.path ?? null;
    }).pipe(
      Effect.mapError((error) =>
        commandError("worktree_error", "Failed to list worktrees", error),
      ),
    ),
  isGitRepo: () =>
    runProcess("git", ["rev-parse", "--git-dir"]).pipe(
      Effect.map((result) => result.success),
      Effect.mapError((error) =>
        commandError("not_git_repo", "Failed to inspect git repository", error),
      ),
    ),
  listWorktrees: () =>
    listWorktreesImpl().pipe(
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
        if (existing && existing.branch !== branch) {
          return {
            _tag: "PathConflict" as const,
            path,
            existingBranch: existing.branch,
          };
        }

        return {
          _tag: "AlreadyExists" as const,
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
        Effect.fail(commandError("worktree_error", extractShellError(error), error)),
      ),
      Effect.mapError((error) =>
        commandError(
          "worktree_error",
          `Failed to create worktree '${branch}' at '${path}'`,
          error,
        ),
      ),
    ),
  branchExists: (branch) =>
    runProcess("git", ["rev-parse", "--verify", branch]).pipe(
      Effect.map((result) => result.success),
      Effect.mapError((error) =>
        commandError(
          "worktree_error",
          `Failed to verify branch '${branch}'`,
          error,
        ),
      ),
    ),
  remoteBranchExists: (branch) =>
    runProcess("git", ["rev-parse", "--verify", `origin/${branch}`]).pipe(
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
  findWorktreeByBranch: (branch) =>
    Effect.gen(function* () {
      const worktrees = yield* listWorktreesImpl();
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
});
