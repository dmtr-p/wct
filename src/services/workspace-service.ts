import { basename, resolve } from "node:path";
import type { BunServices } from "@effect/platform-bun";
import { Context, Effect } from "effect";
import { loadConfig, resolveIdeLaunch, resolveProfile } from "../config/loader";
import { commandError, toWctError, type WctError } from "../errors";
import type { WctEnv } from "../types/env";
import { IdeService, type IdeService as IdeServiceApi } from "./ide-service";
import {
  type CreateSessionResult,
  formatSessionName,
  TmuxService,
  type TmuxService as TmuxServiceApi,
} from "./tmux";
import {
  WorktreeService,
  type WorktreeService as WorktreeServiceApi,
} from "./worktree-service";

export interface WorkspaceError {
  code: string;
  message: string;
}

export type WorkspaceOperation = "open" | "up" | "down" | "close";

export type WorkspaceAttempt<T> =
  | { attempted: false; reason: string }
  | { attempted: true; ok: true; value: T }
  | { attempted: true; ok: false; error: WorkspaceError };

export type WorkspaceWarning =
  | {
      _tag: "TmuxStartFailed";
      operation: "up";
      error: WorkspaceError;
    }
  | {
      _tag: "IdeOpenFailed";
      operation: "up";
      error: WorkspaceError;
    };

export type WorkspaceReporterEvent =
  | {
      operation: WorkspaceOperation;
      _tag: "TargetResolved";
      worktreePath: string;
    }
  | {
      operation: WorkspaceOperation;
      _tag: "ProfileResolved";
      profileName?: string;
    }
  | {
      operation: WorkspaceOperation;
      _tag: "AttemptStarted";
      attempt: "tmux" | "ide";
    }
  | {
      operation: WorkspaceOperation;
      _tag: "AttemptCompleted";
      attempt: "tmux" | "ide";
      ok: boolean;
    }
  | {
      operation: WorkspaceOperation;
      _tag: "SessionAbsent";
      sessionName: string;
    }
  | {
      operation: WorkspaceOperation;
      _tag: "SessionKilled";
      sessionName: string;
    };

export interface WorkspaceReporter {
  event: (event: WorkspaceReporterEvent) => Effect.Effect<void, unknown, never>;
}

export interface ResolveWorkspaceTargetOptions {
  path?: string;
  branch?: string;
}

export interface WorkspaceUpOptions extends ResolveWorkspaceTargetOptions {
  ide?: boolean;
  noIde?: boolean;
  profile?: string;
  reporter?: WorkspaceReporter;
}

export interface WorkspaceDownOptions extends ResolveWorkspaceTargetOptions {
  reporter?: WorkspaceReporter;
}

export interface WorkspaceUpResult {
  operation: "up";
  worktreePath: string;
  mainRepoPath: string;
  branch: string;
  sessionName: string;
  projectName: string;
  profileName?: string;
  env: WctEnv;
  warnings: WorkspaceWarning[];
  attempts: {
    tmux: WorkspaceAttempt<CreateSessionResult>;
    ide: WorkspaceAttempt<null>;
  };
}

export interface WorkspaceDownResult {
  operation: "down";
  worktreePath: string;
  sessionName: string;
  existed: boolean;
  status: "killed" | "absent";
  attempts: {
    kill: WorkspaceAttempt<null>;
  };
  warnings: [];
}

export interface WorkspaceService {
  up: (
    options?: WorkspaceUpOptions,
  ) => Effect.Effect<
    WorkspaceUpResult,
    WctError,
    | WorktreeServiceApi
    | TmuxServiceApi
    | IdeServiceApi
    | BunServices.BunServices
  >;
  down: (
    options?: WorkspaceDownOptions,
  ) => Effect.Effect<
    WorkspaceDownResult,
    WctError,
    WorktreeServiceApi | TmuxServiceApi | BunServices.BunServices
  >;
}

export const WorkspaceService = Context.Service<WorkspaceService>(
  "wct/WorkspaceService",
);

function toWorkspaceError(error: unknown): WorkspaceError {
  const wctError = toWctError(error);
  return {
    code: wctError.code,
    message: wctError.message,
  };
}

function skippedAttempt<T>(reason: string): WorkspaceAttempt<T> {
  return { attempted: false, reason };
}

function emitReporter(
  reporter: WorkspaceReporter | undefined,
  event: WorkspaceReporterEvent,
) {
  if (!reporter) return Effect.void;
  return Effect.try({
    try: () => reporter.event(event),
    catch: (error) => error,
  }).pipe(
    Effect.flatMap((reporterEffect) => reporterEffect),
    Effect.catchCause(() => Effect.void),
  );
}

function captureAttempt<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<WorkspaceAttempt<A>, never, R> {
  return Effect.match(effect, {
    onFailure: (error) => ({
      attempted: true as const,
      ok: false as const,
      error: toWorkspaceError(error),
    }),
    onSuccess: (value) => ({
      attempted: true as const,
      ok: true as const,
      value,
    }),
  });
}

function resolveTargetImpl(
  options: ResolveWorkspaceTargetOptions = {},
): Effect.Effect<
  string,
  WctError,
  WorktreeServiceApi | BunServices.BunServices
> {
  return Effect.gen(function* () {
    const { path, branch } = options;

    if (path && branch) {
      return yield* Effect.fail(
        commandError(
          "invalid_options",
          "--path and --branch are mutually exclusive",
        ),
      );
    }

    if (path) return resolve(path);

    if (branch) {
      const match = yield* WorktreeService.use((service) =>
        service.findWorktreeByBranch(branch),
      );

      if (!match) {
        return yield* Effect.fail(
          commandError(
            "worktree_not_found",
            `No worktree found for branch '${branch}'`,
          ),
        );
      }

      return match.path;
    }

    return yield* Effect.try({
      try: () => process.cwd(),
      catch: (err) =>
        commandError(
          "unexpected_error",
          "Failed to resolve current working directory",
          err,
        ),
    });
  });
}

function upImpl(
  options: WorkspaceUpOptions = {},
): Effect.Effect<
  WorkspaceUpResult,
  WctError,
  WorktreeServiceApi | TmuxServiceApi | IdeServiceApi | BunServices.BunServices
> {
  return Effect.gen(function* () {
    const { ide, noIde, profile, reporter } = options;

    if (ide && noIde) {
      return yield* Effect.fail(
        commandError(
          "invalid_options",
          "Options --ide and --no-ide cannot be used together",
        ),
      );
    }

    const worktreePath = yield* resolveTargetImpl(options);
    yield* emitReporter(reporter, {
      operation: "up",
      _tag: "TargetResolved",
      worktreePath,
    });

    const isRepo = yield* WorktreeService.use((service) =>
      service.isGitRepo(worktreePath),
    );
    if (!isRepo) {
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

    const config = yield* Effect.mapError(loadConfig(mainRepoPath), (error) =>
      commandError("config_error", error.message, error),
    );
    const { config: resolved, profileName } = yield* Effect.try({
      try: () => resolveProfile(config, branch, profile),
      catch: (error) =>
        commandError(
          "config_error",
          error instanceof Error ? error.message : String(error),
        ),
    });
    yield* emitReporter(reporter, {
      operation: "up",
      _tag: "ProfileResolved",
      ...(profileName ? { profileName } : {}),
    });

    const ideLaunch = resolveIdeLaunch(resolved.ide, { ide, noIde });
    const sessionName = formatSessionName(basename(worktreePath));
    const env: WctEnv = {
      WCT_WORKTREE_DIR: worktreePath,
      WCT_MAIN_DIR: mainRepoPath,
      WCT_BRANCH: branch,
      WCT_PROJECT: config.project_name,
    };

    if (resolved.tmux) {
      yield* emitReporter(reporter, {
        operation: "up",
        _tag: "AttemptStarted",
        attempt: "tmux",
      });
    }

    if (ideLaunch.open && ideLaunch.command) {
      yield* emitReporter(reporter, {
        operation: "up",
        _tag: "AttemptStarted",
        attempt: "ide",
      });
    }

    const startTmux = resolved.tmux
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
      : Effect.succeed(
          skippedAttempt<CreateSessionResult>("tmux_not_configured"),
        );

    const startIde =
      ideLaunch.open && ideLaunch.command
        ? captureAttempt(
            IdeService.use((service) =>
              service
                .openIDE(ideLaunch.command ?? "", env)
                .pipe(Effect.as(null)),
            ),
          )
        : Effect.succeed(skippedAttempt<null>("ide_not_configured"));

    const [tmux, ideResult] = yield* Effect.all([startTmux, startIde], {
      concurrency: "unbounded",
    });

    if (tmux.attempted) {
      yield* emitReporter(reporter, {
        operation: "up",
        _tag: "AttemptCompleted",
        attempt: "tmux",
        ok: tmux.ok,
      });
    }

    if (ideResult.attempted) {
      yield* emitReporter(reporter, {
        operation: "up",
        _tag: "AttemptCompleted",
        attempt: "ide",
        ok: ideResult.ok,
      });
    }

    const warnings: WorkspaceWarning[] = [];
    if (tmux.attempted && !tmux.ok) {
      warnings.push({
        _tag: "TmuxStartFailed",
        operation: "up",
        error: tmux.error,
      });
    }
    if (ideResult.attempted && !ideResult.ok) {
      warnings.push({
        _tag: "IdeOpenFailed",
        operation: "up",
        error: ideResult.error,
      });
    }

    return {
      operation: "up",
      worktreePath,
      mainRepoPath,
      branch,
      sessionName,
      projectName: config.project_name,
      ...(profileName ? { profileName } : {}),
      env,
      warnings,
      attempts: {
        tmux,
        ide: ideResult,
      },
    };
  });
}

function downImpl(
  options: WorkspaceDownOptions = {},
): Effect.Effect<
  WorkspaceDownResult,
  WctError,
  WorktreeServiceApi | TmuxServiceApi | BunServices.BunServices
> {
  return Effect.gen(function* () {
    const { reporter } = options;
    const worktreePath = yield* resolveTargetImpl(options);
    yield* emitReporter(reporter, {
      operation: "down",
      _tag: "TargetResolved",
      worktreePath,
    });

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

    if (!existed) {
      yield* emitReporter(reporter, {
        operation: "down",
        _tag: "SessionAbsent",
        sessionName,
      });
      return {
        operation: "down",
        worktreePath,
        sessionName,
        existed: false,
        status: "absent",
        attempts: {
          kill: skippedAttempt("session_absent"),
        },
        warnings: [],
      };
    }

    yield* TmuxService.use((service) => service.killSession(sessionName));
    yield* emitReporter(reporter, {
      operation: "down",
      _tag: "SessionKilled",
      sessionName,
    });

    return {
      operation: "down",
      worktreePath,
      sessionName,
      existed: true,
      status: "killed",
      attempts: {
        kill: {
          attempted: true,
          ok: true,
          value: null,
        },
      },
      warnings: [],
    };
  });
}

export const liveWorkspaceService: WorkspaceService = WorkspaceService.of({
  up: upImpl,
  down: downImpl,
});
