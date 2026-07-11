import { basename, resolve } from "node:path";
import type { BunServices } from "@effect/platform-bun";
import { Context, Effect } from "effect";
import {
  loadConfig,
  resolveIdeLaunch,
  resolveProfile,
  resolveWorktreePath,
} from "../config/loader";
import { commandError, toWctError, type WctError } from "../errors";
import type { WctEnv } from "../types/env";
import { type CopyResult, copyEntries } from "./copy";
import {
  GitHubService,
  type GitHubService as GitHubServiceApi,
  parsePrArg,
} from "./github-service";
import { IdeService, type IdeService as IdeServiceApi } from "./ide-service";
import {
  type SetupResult,
  SetupService,
  type SetupService as SetupServiceApi,
} from "./setup-service";
import {
  type CreateSessionResult,
  formatSessionName,
  TmuxService,
  type TmuxService as TmuxServiceApi,
} from "./tmux";
import {
  type SyncResult,
  VSCodeWorkspaceService,
  type VSCodeWorkspaceService as VSCodeWorkspaceServiceApi,
} from "./vscode-workspace";
import {
  type CreateWorktreeResult,
  type RemoveWorktreeResult,
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
      operation: "open" | "up";
      error: WorkspaceError;
    }
  | {
      _tag: "IdeOpenFailed";
      operation: "open" | "up";
      error: WorkspaceError;
    }
  | {
      _tag: "VSCodeSyncFailed";
      operation: "open";
      error: WorkspaceError;
    }
  | {
      _tag: "SetupFailed";
      operation: "open";
      name: string;
      optional: boolean;
      error: WorkspaceError;
    };

export type WorkspaceReporterEvent =
  | {
      operation: WorkspaceOperation;
      _tag: "TargetResolved";
      worktreePath: string;
      branch?: string;
      base?: string;
    }
  | {
      operation: WorkspaceOperation;
      _tag: "ProfileResolved";
      profileName?: string;
    }
  | {
      operation: WorkspaceOperation;
      _tag: "AttemptStarted";
      attempt: "worktree" | "vscode" | "copy" | "setup" | "tmux" | "ide";
    }
  | {
      operation: WorkspaceOperation;
      _tag: "AttemptCompleted";
      attempt: "worktree" | "vscode" | "copy" | "setup" | "tmux" | "ide";
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

export interface WorkspaceCloseOptions extends ResolveWorkspaceTargetOptions {
  cwd?: string;
  force?: boolean;
  reporter?: WorkspaceReporter;
}

export interface WorkspaceOpenOptions {
  branch?: string;
  existing?: boolean;
  base?: string;
  cwd?: string;
  ide?: boolean;
  noIde?: boolean;
  pr?: string;
  profile?: string;
  reporter?: WorkspaceReporter;
}

export interface WorkspaceOpenResult {
  operation: "open";
  worktreePath: string;
  mainRepoPath: string;
  branch: string;
  sessionName: string;
  projectName: string;
  profileName?: string;
  created: boolean;
  env: WctEnv;
  warnings: WorkspaceWarning[];
  attempts: {
    worktree: WorkspaceAttempt<CreateWorktreeResult>;
    vscode: WorkspaceAttempt<SyncResult>;
    copy: WorkspaceAttempt<CopyResult[]>;
    setup: WorkspaceAttempt<SetupResult[]>;
    tmux: WorkspaceAttempt<CreateSessionResult>;
    ide: WorkspaceAttempt<null>;
  };
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

export interface WorkspaceCloseResult {
  operation: "close";
  worktreePath: string;
  sessionName: string;
  existed: boolean;
  status: "removed" | "blocked_by_changes";
  attempts: {
    kill: WorkspaceAttempt<null>;
    remove: WorkspaceAttempt<RemoveWorktreeResult>;
  };
  warnings: [];
}

export interface WorkspaceService {
  open: (
    options: WorkspaceOpenOptions,
  ) => Effect.Effect<
    WorkspaceOpenResult,
    WctError,
    | WorktreeServiceApi
    | TmuxServiceApi
    | IdeServiceApi
    | SetupServiceApi
    | VSCodeWorkspaceServiceApi
    | GitHubServiceApi
    | BunServices.BunServices
  >;
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
  close: (
    options?: WorkspaceCloseOptions,
  ) => Effect.Effect<
    WorkspaceCloseResult,
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
    Effect.flatten,
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

function setupWarning(result: SetupResult): WorkspaceWarning | undefined {
  if (result._tag === "Succeeded") return undefined;
  return {
    _tag: "SetupFailed",
    operation: "open",
    name: result.name,
    optional: result._tag === "OptionalFailed",
    error: {
      code:
        result._tag === "OptionalFailed"
          ? "optional_setup_failed"
          : "setup_failed",
      message: result.error ?? "Unknown error",
    },
  };
}

function resolveOpenIntent(
  options: WorkspaceOpenOptions,
): Effect.Effect<
  Required<Pick<WorkspaceOpenOptions, "branch" | "existing">> &
    Omit<WorkspaceOpenOptions, "branch" | "existing" | "pr" | "reporter">,
  WctError,
  GitHubServiceApi | WorktreeServiceApi | BunServices.BunServices
> {
  return Effect.gen(function* () {
    const {
      branch,
      existing = false,
      base,
      cwd,
      ide = false,
      noIde = false,
      pr,
      profile,
    } = options;

    if (ide && noIde) {
      return yield* Effect.fail(
        commandError(
          "invalid_options",
          "Options --ide and --no-ide cannot be used together",
        ),
      );
    }

    if (pr && branch) {
      return yield* Effect.fail(
        commandError(
          "invalid_options",
          "Cannot use --pr together with a branch argument",
        ),
      );
    }

    if (pr && base) {
      return yield* Effect.fail(
        commandError("invalid_options", "Cannot use --pr together with --base"),
      );
    }

    if (pr && existing) {
      return yield* Effect.fail(
        commandError(
          "invalid_options",
          "Cannot use --pr together with --existing",
        ),
      );
    }

    if (pr) {
      const prNumber = parsePrArg(pr);
      if (prNumber === null) {
        return yield* Effect.fail(
          commandError(
            "pr_error",
            `Invalid --pr value: '${pr}'\n\nExpected a PR number or GitHub URL (e.g. 123 or https://github.com/user/repo/pull/123)`,
          ),
        );
      }

      const ghInstalled = yield* GitHubService.use((service) =>
        service.isGhInstalled(),
      );
      if (!ghInstalled) {
        return yield* Effect.fail(
          commandError(
            "gh_not_installed",
            "GitHub CLI (gh) is not installed.\n\nInstall it from https://cli.github.com/ and run 'gh auth login'",
          ),
        );
      }

      const resolvedPr = yield* GitHubService.use((service) =>
        service.resolvePr(prNumber, cwd),
      );
      const resolvedBranch = resolvedPr.branch;
      let remote = "origin";

      if (resolvedPr.headOwner && resolvedPr.headRepo) {
        const { headOwner, headRepo } = resolvedPr;
        const existingRemote = yield* GitHubService.use((service) =>
          service.findRemoteForRepo(headOwner, headRepo, cwd),
        );

        if (existingRemote) {
          remote = existingRemote;
        } else if (resolvedPr.isCrossRepository) {
          remote = headOwner;
          yield* GitHubService.use((service) =>
            service.addForkRemote(remote, headOwner, headRepo, cwd),
          );
        }
      }

      yield* GitHubService.use((service) =>
        service.fetchBranch(resolvedBranch, remote, cwd),
      );

      const localExists = yield* WorktreeService.use((service) =>
        service.branchExists(resolvedBranch, cwd),
      );

      return {
        branch: resolvedBranch,
        existing: localExists,
        base: localExists ? undefined : `${remote}/${resolvedBranch}`,
        cwd,
        ide,
        noIde,
        profile,
      };
    }

    if (!branch) {
      return yield* Effect.fail(
        commandError("missing_branch_arg", "Missing branch name"),
      );
    }

    return { branch, existing, base, cwd, ide, noIde, profile };
  });
}

function openImpl(
  options: WorkspaceOpenOptions,
): Effect.Effect<
  WorkspaceOpenResult,
  WctError,
  | WorktreeServiceApi
  | TmuxServiceApi
  | IdeServiceApi
  | SetupServiceApi
  | VSCodeWorkspaceServiceApi
  | GitHubServiceApi
  | BunServices.BunServices
> {
  return Effect.gen(function* () {
    const reporter = options.reporter;
    const resolvedOptions = yield* resolveOpenIntent(options);
    const { branch, existing, base, cwd, ide, noIde, profile } =
      resolvedOptions;

    const repo = yield* WorktreeService.use((service) =>
      service.isGitRepo(cwd),
    );
    if (!repo) {
      return yield* Effect.fail(
        commandError("not_git_repo", "Not a git repository"),
      );
    }

    const mainRepoPath = yield* WorktreeService.use((service) =>
      service.getMainRepoPath(cwd),
    );
    if (!mainRepoPath) {
      return yield* Effect.fail(
        commandError("worktree_error", "Could not determine repository root"),
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
      operation: "open",
      _tag: "ProfileResolved",
      ...(profileName ? { profileName } : {}),
    });
    const ideLaunch = resolveIdeLaunch(resolved.ide, { ide, noIde });

    if (existing && base) {
      return yield* Effect.fail(
        commandError(
          "invalid_options",
          "Options --existing and --base cannot be used together",
        ),
      );
    }

    if (base) {
      const baseExists = yield* WorktreeService.use((service) =>
        service.branchExists(base, cwd),
      );
      if (!baseExists) {
        return yield* Effect.fail(
          commandError(
            "base_branch_not_found",
            `Base branch '${base}' does not exist`,
          ),
        );
      }
    }

    const worktreePath = resolveWorktreePath(
      config.worktree_dir,
      branch,
      mainRepoPath,
      config.project_name,
    );
    yield* emitReporter(reporter, {
      operation: "open",
      _tag: "TargetResolved",
      worktreePath,
      branch,
      ...(base ? { base } : {}),
    });
    const sessionName = formatSessionName(basename(worktreePath));
    const workingDir = resolve(worktreePath, resolved.work_dir);
    const env: WctEnv = {
      WCT_WORKTREE_DIR: worktreePath,
      WCT_WORK_DIR: workingDir,
      WCT_MAIN_DIR: mainRepoPath,
      WCT_BRANCH: branch,
      WCT_PROJECT: config.project_name,
    };

    yield* emitReporter(reporter, {
      operation: "open",
      _tag: "AttemptStarted",
      attempt: "worktree",
    });
    const worktreeResult = yield* WorktreeService.use((service) =>
      service.createWorktree(worktreePath, branch, existing, base, cwd),
    );
    if (worktreeResult._tag === "PathConflict") {
      return yield* Effect.fail(
        commandError(
          "worktree_error",
          worktreeResult.existingBranch
            ? `Path already exists for branch '${worktreeResult.existingBranch}', not '${branch}'`
            : `Path '${worktreePath}' already exists and is not a registered worktree for '${branch}'`,
        ),
      );
    }
    yield* emitReporter(reporter, {
      operation: "open",
      _tag: "AttemptCompleted",
      attempt: "worktree",
      ok: true,
    });

    const shouldSyncVSCode =
      ideLaunch.open &&
      (ideLaunch.config?.name ?? "vscode") === "vscode" &&
      ideLaunch.config?.fork_workspace;
    if (shouldSyncVSCode) {
      yield* emitReporter(reporter, {
        operation: "open",
        _tag: "AttemptStarted",
        attempt: "vscode",
      });
    }
    const vscode = shouldSyncVSCode
      ? yield* captureAttempt(
          VSCodeWorkspaceService.use((service) =>
            service.syncWorkspaceState(mainRepoPath, worktreePath),
          ).pipe(
            Effect.flatMap((result) =>
              result.success
                ? Effect.succeed(result)
                : Effect.fail(
                    commandError(
                      "worktree_error",
                      result.error ?? "VS Code workspace sync failed",
                    ),
                  ),
            ),
          ),
        )
      : skippedAttempt<SyncResult>("vscode_sync_not_configured");
    if (vscode.attempted) {
      yield* emitReporter(reporter, {
        operation: "open",
        _tag: "AttemptCompleted",
        attempt: "vscode",
        ok: vscode.ok,
      });
    }

    if (resolved.copy && resolved.copy.length > 0) {
      yield* emitReporter(reporter, {
        operation: "open",
        _tag: "AttemptStarted",
        attempt: "copy",
      });
    }
    const copy =
      resolved.copy && resolved.copy.length > 0
        ? yield* Effect.mapError(
            copyEntries(resolved.copy, mainRepoPath, worktreePath),
            (error) =>
              commandError("worktree_error", "Failed to copy files", error),
          ).pipe(
            Effect.flatMap((results) => {
              const failed = results.find((result) => !result.success);
              return failed
                ? Effect.fail(
                    commandError(
                      "worktree_error",
                      `Failed to copy files: ${failed.file}: ${failed.error ?? "Unknown error"}`,
                    ),
                  )
                : Effect.succeed(results);
            }),
            Effect.map((value) => ({
              attempted: true as const,
              ok: true as const,
              value,
            })),
          )
        : skippedAttempt<CopyResult[]>("copy_not_configured");
    if (copy.attempted) {
      yield* emitReporter(reporter, {
        operation: "open",
        _tag: "AttemptCompleted",
        attempt: "copy",
        ok: copy.ok,
      });
    }

    if (resolved.setup && resolved.setup.length > 0) {
      yield* emitReporter(reporter, {
        operation: "open",
        _tag: "AttemptStarted",
        attempt: "setup",
      });
    }
    const setup =
      resolved.setup && resolved.setup.length > 0
        ? yield* captureAttempt(
            SetupService.use((service) =>
              service.runSetupCommands(resolved.setup ?? [], workingDir, env),
            ),
          )
        : skippedAttempt<SetupResult[]>("setup_not_configured");
    if (setup.attempted) {
      yield* emitReporter(reporter, {
        operation: "open",
        _tag: "AttemptCompleted",
        attempt: "setup",
        ok: setup.ok,
      });
    }

    if (resolved.tmux) {
      yield* emitReporter(reporter, {
        operation: "open",
        _tag: "AttemptStarted",
        attempt: "tmux",
      });
    }
    if (ideLaunch.open && ideLaunch.command) {
      yield* emitReporter(reporter, {
        operation: "open",
        _tag: "AttemptStarted",
        attempt: "ide",
      });
    }

    const startTmux = resolved.tmux
      ? captureAttempt(
          TmuxService.use((service) =>
            service.createSession(sessionName, workingDir, resolved.tmux, env),
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
        operation: "open",
        _tag: "AttemptCompleted",
        attempt: "tmux",
        ok: tmux.ok,
      });
    }
    if (ideResult.attempted) {
      yield* emitReporter(reporter, {
        operation: "open",
        _tag: "AttemptCompleted",
        attempt: "ide",
        ok: ideResult.ok,
      });
    }

    const warnings: WorkspaceWarning[] = [];
    if (vscode.attempted && !vscode.ok) {
      warnings.push({
        _tag: "VSCodeSyncFailed",
        operation: "open",
        error: vscode.error,
      });
    }
    if (setup.attempted && setup.ok) {
      warnings.push(
        ...setup.value.flatMap((result) => {
          const warning = setupWarning(result);
          return warning ? [warning] : [];
        }),
      );
    } else if (setup.attempted && !setup.ok) {
      warnings.push({
        _tag: "SetupFailed",
        operation: "open",
        name: "setup",
        optional: false,
        error: setup.error,
      });
    }
    if (tmux.attempted && !tmux.ok) {
      warnings.push({
        _tag: "TmuxStartFailed",
        operation: "open",
        error: tmux.error,
      });
    }
    if (ideResult.attempted && !ideResult.ok) {
      warnings.push({
        _tag: "IdeOpenFailed",
        operation: "open",
        error: ideResult.error,
      });
    }

    return {
      operation: "open",
      worktreePath,
      mainRepoPath,
      branch,
      sessionName,
      projectName: config.project_name,
      ...(profileName ? { profileName } : {}),
      created: worktreeResult._tag !== "AlreadyExists",
      env,
      warnings,
      attempts: {
        worktree: {
          attempted: true,
          ok: true,
          value: worktreeResult,
        },
        vscode,
        copy,
        setup,
        tmux,
        ide: ideResult,
      },
    };
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
    const workingDir = resolve(worktreePath, resolved.work_dir);
    const env: WctEnv = {
      WCT_WORKTREE_DIR: worktreePath,
      WCT_WORK_DIR: workingDir,
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
            service.createSession(sessionName, workingDir, resolved.tmux, env),
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

function closeImpl(
  options: WorkspaceCloseOptions = {},
): Effect.Effect<
  WorkspaceCloseResult,
  WctError,
  WorktreeServiceApi | TmuxServiceApi | BunServices.BunServices
> {
  return Effect.gen(function* () {
    const { cwd, force = false, reporter } = options;
    const worktreePath = yield* resolveTargetImpl(options);
    yield* emitReporter(reporter, {
      operation: "close",
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

    const kill: WorkspaceAttempt<null> = existed
      ? yield* TmuxService.use((service) =>
          service.killSession(sessionName),
        ).pipe(
          Effect.as({
            attempted: true as const,
            ok: true as const,
            value: null,
          }),
        )
      : skippedAttempt("session_absent");

    if (existed) {
      yield* emitReporter(reporter, {
        operation: "close",
        _tag: "SessionKilled",
        sessionName,
      });
    } else {
      yield* emitReporter(reporter, {
        operation: "close",
        _tag: "SessionAbsent",
        sessionName,
      });
    }

    yield* emitReporter(reporter, {
      operation: "close",
      _tag: "AttemptStarted",
      attempt: "worktree",
    });
    const removeResult = yield* WorktreeService.use((service) =>
      service.removeWorktree(worktreePath, force, cwd),
    );
    yield* emitReporter(reporter, {
      operation: "close",
      _tag: "AttemptCompleted",
      attempt: "worktree",
      ok: removeResult._tag === "Removed",
    });

    return {
      operation: "close",
      worktreePath,
      sessionName,
      existed,
      status:
        removeResult._tag === "Removed" ? "removed" : "blocked_by_changes",
      attempts: {
        kill,
        remove: {
          attempted: true,
          ok: true,
          value: removeResult,
        },
      },
      warnings: [],
    };
  });
}

export const liveWorkspaceService: WorkspaceService = WorkspaceService.of({
  open: openImpl,
  up: upImpl,
  down: downImpl,
  close: closeImpl,
});
