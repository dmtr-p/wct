import { existsSync } from "node:fs";
import { Context, Effect, FileSystem, Semaphore } from "effect";
import { loadConfig } from "../config/loader";
import type { ResolvedConfig } from "../config/schema";
import type { WctError } from "../errors";
import type { RegistrationId } from "./identities";
import { ObservationProcessBudget } from "./process";
import { RegistryService } from "./registry-service";
import { TmuxService } from "./tmux";
import { WorktreeService } from "./worktree-service";

export const LOCAL_OBSERVATION_LIMIT = 4;

export interface WorktreeInfo {
  branch: string;
  path: string;
  isMainWorktree: boolean;
  changedFiles: number;
  sync: { ahead: number; behind: number } | null;
}

export interface RepoInfo {
  id: RegistrationId;
  repoPath: string;
  /** Project Display Name from the registry, not the configured project_name. */
  project: string;
  worktrees: WorktreeInfo[];
  profileNames: string[];
  baseBranch?: string;
  error?: string;
}

export interface RegistryRepoItem {
  id: RegistrationId;
  repo_path: string;
  project: string;
}

export const makeLocalObservationService = Effect.gen(function* () {
  const registry = yield* RegistryService;
  const worktree = yield* WorktreeService;
  const tmux = yield* TmuxService;
  const budget = yield* Semaphore.make(LOCAL_OBSERVATION_LIMIT);
  const fs = yield* FileSystem.FileSystem;
  const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, ObservationProcessBudget, budget);
  return {
    repositories: bounded(
      Effect.flatMap(registry.listRepos, (items) =>
        Effect.forEach(
          items,
          (item) =>
            inspectRepository(item, {
              ...worktree,
              pathExists: existsSync,
              getConfig: (path) =>
                loadConfig(path).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                ),
            }),
          { concurrency: LOCAL_OBSERVATION_LIMIT },
        ),
      ),
    ),
    sessions: bounded(
      Effect.gen(function* () {
        const sessions = (yield* tmux.listSessions) ?? [];
        const entries = yield* Effect.forEach(
          sessions,
          (session) =>
            tmux.listPanes(session.name).pipe(
              Effect.map((panes) => [session.name, panes] as const),
              Effect.orElseSucceed(() => null),
            ),
          { concurrency: LOCAL_OBSERVATION_LIMIT },
        );
        return {
          sessions: sessions.map(({ name, attached }) => ({ name, attached })),
          panes: new Map(entries.filter((entry) => entry !== null)),
        };
      }),
    ),
    clients: bounded(tmux.listClients),
  };
});

export type LocalObservationServiceApi = Effect.Success<
  typeof makeLocalObservationService
>;
export const LocalObservationService =
  Context.Service<LocalObservationServiceApi>("wct/LocalObservationService");

interface RepositoryObservationDeps {
  pathExists: (path: string) => boolean;
  getConfig: (
    path: string,
  ) => Effect.Effect<
    Pick<ResolvedConfig, "profiles" | "base_branch">,
    WctError | import("../config/loader").ConfigError
  >;
  listWorktrees: (
    path: string,
  ) => Effect.Effect<import("./worktree-service").Worktree[], WctError>;
  getDefaultBranch: (path: string) => Effect.Effect<string | null, WctError>;
  getChangedFileCount: (
    path: string,
    options?: import("./worktree-service").WorktreeStatusOptions,
  ) => Effect.Effect<number, WctError>;
  getAheadBehind: (
    path: string,
    ref: string,
    options?: import("./worktree-service").WorktreeStatusOptions,
  ) => Effect.Effect<{ ahead: number; behind: number } | null, WctError>;
}
export const inspectRepository = (
  item: RegistryRepoItem,
  deps: RepositoryObservationDeps,
): Effect.Effect<RepoInfo> =>
  Effect.gen(function* () {
    const base = {
      id: item.id,
      repoPath: item.repo_path,
      project: item.project,
      worktrees: [] as WorktreeInfo[],
      profileNames: [] as string[],
    };
    if (!deps.pathExists(item.repo_path))
      return { ...base, error: "Directory not found" };
    const config = yield* deps
      .getConfig(item.repo_path)
      .pipe(
        Effect.orElseSucceed(
          (): Pick<ResolvedConfig, "profiles" | "base_branch"> => ({}),
        ),
      );
    const configured = {
      ...base,
      profileNames: Object.keys(config.profiles ?? {}),
      ...(config.base_branch ? { baseBranch: config.base_branch } : {}),
    };
    return yield* Effect.gen(function* () {
      const [trees, defaultBranch] = yield* Effect.all(
        [
          deps.listWorktrees(item.repo_path),
          deps.getDefaultBranch(item.repo_path),
        ],
        { concurrency: "unbounded" },
      );
      const worktrees = yield* Effect.forEach(
        trees.filter((tree) => !tree.isBare),
        (tree, index) =>
          Effect.gen(function* () {
            const exists = deps.pathExists(tree.path);
            const [changedFiles, sync] = yield* Effect.all(
              [
                exists
                  ? deps
                      .getChangedFileCount(tree.path, { logWarnings: false })
                      .pipe(Effect.orElseSucceed(() => 0))
                  : Effect.succeed(0),
                exists && defaultBranch
                  ? deps
                      .getAheadBehind(tree.path, defaultBranch, {
                        logWarnings: false,
                      })
                      .pipe(Effect.orElseSucceed(() => null))
                  : Effect.succeed(null),
              ],
              { concurrency: "unbounded" },
            );
            return {
              branch: tree.branch,
              path: tree.path,
              isMainWorktree: index === 0,
              changedFiles,
              sync,
            };
          }),
        { concurrency: LOCAL_OBSERVATION_LIMIT },
      );
      return { ...configured, worktrees };
    }).pipe(
      Effect.orElseSucceed(() => ({
        ...configured,
        error: "Failed to inspect repository",
      })),
    );
  });
