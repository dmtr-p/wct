import { basename } from "node:path";
import { Effect } from "effect";
import { loadConfig, resolveProfile } from "../config/loader";
import type { WctRuntimeServices } from "../effect/services";
import { commandError, toWctError, type WctError } from "../errors";
import {
  IdeService,
  type IdeService as IdeServiceApi,
} from "../services/ide-service";
import {
  type CreateSessionResult,
  formatSessionName,
  TmuxService,
} from "../services/tmux";
import { WorktreeService } from "../services/worktree-service";
import type { WctEnv } from "../types/env";
import {
  type ResolveWorktreePathOptions,
  resolveWorktreePath,
} from "./resolve-worktree-path";

export type OperationAttempt<T> =
  | { attempted: false }
  | { attempted: true; ok: true; value: T }
  | { attempted: true; ok: false; error: WctError };

export interface StartWorktreeSessionOptions
  extends ResolveWorktreePathOptions {
  noIde?: boolean;
  profile?: string;
}

export interface StartWorktreeSessionResult {
  worktreePath: string;
  mainRepoPath: string;
  branch: string;
  sessionName: string;
  projectName: string;
  profileName?: string;
  env: WctEnv;
  tmux: OperationAttempt<CreateSessionResult>;
  ide: OperationAttempt<void>;
}

export interface StopWorktreeSessionOptions
  extends ResolveWorktreePathOptions {}

export interface StopWorktreeSessionResult {
  worktreePath: string;
  sessionName: string;
  existed: boolean;
}

function skippedAttempt<T>(): OperationAttempt<T> {
  return { attempted: false };
}

function captureAttempt<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<OperationAttempt<A>, never, R> {
  return Effect.match(effect, {
    onFailure: (error) => ({
      attempted: true as const,
      ok: false as const,
      error: toWctError(error),
    }),
    onSuccess: (value) => ({
      attempted: true as const,
      ok: true as const,
      value,
    }),
  });
}

export function startWorktreeSession(
  options: StartWorktreeSessionOptions = {},
): Effect.Effect<
  StartWorktreeSessionResult,
  WctError,
  WctRuntimeServices | IdeServiceApi
> {
  return Effect.gen(function* () {
    const { noIde, profile, path, branch: branchOption } = options;
    const worktreePath = yield* resolveWorktreePath({
      path,
      branch: branchOption,
    });

    const repo = yield* WorktreeService.use((service) =>
      service.isGitRepo(worktreePath),
    );
    if (!repo) {
      return yield* Effect.fail(
        commandError("not_git_repo", "Not a git repository"),
      );
    }

    const [mainRepoPath, branch] = yield* Effect.all([
      WorktreeService.use((service) => service.getMainRepoPath(worktreePath)),
      WorktreeService.use((service) => service.getCurrentBranch(worktreePath)),
    ]);

    if (!mainRepoPath) {
      return yield* Effect.fail(
        commandError("worktree_error", "Could not determine repository root"),
      );
    }
    if (!branch) {
      return yield* Effect.fail(
        commandError(
          "detached_head",
          "Could not determine current branch (detached HEAD is not supported)",
        ),
      );
    }

    const { config, errors } = yield* Effect.tryPromise({
      try: () => loadConfig(mainRepoPath),
      catch: (error) =>
        commandError("config_error", "Failed to load configuration", error),
    });
    if (!config) {
      return yield* Effect.fail(
        commandError("config_error", errors.join("\n")),
      );
    }

    const { config: resolved, profileName } = yield* Effect.try({
      try: () => resolveProfile(config, branch, profile),
      catch: (error) =>
        commandError(
          "config_error",
          error instanceof Error ? error.message : String(error),
        ),
    });

    const sessionName = formatSessionName(basename(worktreePath));
    const env: WctEnv = {
      WCT_WORKTREE_DIR: worktreePath,
      WCT_MAIN_DIR: mainRepoPath,
      WCT_BRANCH: branch,
      WCT_PROJECT: config.project_name,
    };

    const [tmux, ide] = yield* Effect.all(
      [
        resolved.tmux
          ? captureAttempt(
              TmuxService.use((service) =>
                service.createSession(
                  sessionName,
                  worktreePath,
                  resolved.tmux,
                  env,
                ),
              ),
            )
          : Effect.succeed(skippedAttempt<CreateSessionResult>()),
        resolved.ide?.command && !noIde
          ? captureAttempt(
              IdeService.use((service) =>
                service.openIDE(resolved.ide?.command ?? "", env),
              ),
            )
          : Effect.succeed(skippedAttempt<void>()),
      ],
      { concurrency: "unbounded" },
    );

    return {
      worktreePath,
      mainRepoPath,
      branch,
      sessionName,
      projectName: config.project_name,
      profileName,
      env,
      tmux,
      ide,
    };
  });
}

export function stopWorktreeSession(
  options: StopWorktreeSessionOptions = {},
): Effect.Effect<StopWorktreeSessionResult, WctError, WctRuntimeServices> {
  return Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(options);

    const isRepo = yield* WorktreeService.use((service) =>
      service.isGitRepo(worktreePath),
    );
    if (!isRepo) {
      return yield* Effect.fail(
        commandError("not_git_repo", "Not a git repository"),
      );
    }

    const sessionName = formatSessionName(basename(worktreePath));
    const existed = yield* TmuxService.use((service) =>
      service.sessionExists(sessionName),
    );

    if (existed) {
      yield* TmuxService.use((service) => service.killSession(sessionName));
    }

    return {
      worktreePath,
      sessionName,
      existed,
    };
  });
}
