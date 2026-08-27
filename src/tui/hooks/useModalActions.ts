// src/tui/hooks/useModalActions.ts

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { toWctError } from "../../errors";
import { registerProject } from "../../services/project-registration";
import type { TmuxClient } from "../../services/tmux";
import {
  type WorkspaceOpenResult,
  WorkspaceService,
  type WorkspaceWarning,
} from "../../services/workspace-service";
import type { AddProjectModalResult } from "../components/AddProjectModal";
import type { OpenModalResult } from "../components/OpenModal";
import type { UpModalResult } from "../components/UpModal";
import {
  type LifecycleClaims,
  type LifecycleState,
  rejectIfLifecycleActive,
  runLifecycleOperation,
} from "../lifecycle";
import { runTuiSilentPromise, tuiRuntime } from "../runtime";
import {
  resolveSelectedWorktreeIndex,
  resolveTreeReturnMode,
} from "../tree-helpers";
import { Mode, pendingKey, type TreeItem } from "../types";
import type { RepoInfo } from "./useRegistry";
import type { StartWorkspaceTarget } from "./useSessionActions";
import type { TmuxClientDiscovery } from "./useTmux";

function workspaceOpenStartedTmux(result: WorkspaceOpenResult): boolean {
  return result.attempts.tmux.attempted && result.attempts.tmux.ok;
}

function formatWorkspaceWarning(warning: WorkspaceWarning): string {
  switch (warning._tag) {
    case "SetupFailed":
      return `${warning.optional ? "Optional setup failed" : "Setup failed"}: ${warning.name}: ${warning.error.message}`;
    case "TmuxStartFailed":
      return `Failed to create tmux session: ${warning.error.message}`;
  }
}

/**
 * The Workspace Identity key an `open` validation actually found on disk, or
 * `undefined` when no managed worktree for this identity exists. Matched on the
 * main repository PATH whenever the modal knew it — two repositories can share
 * a project display name — and on the display name only as a fallback.
 */
function discoveredWorkspaceKey(
  snapshot: readonly RepoInfo[],
  repoPath: string,
  project: string,
  branch: string,
): string | undefined {
  for (const repo of snapshot) {
    const isSameRepo = repoPath
      ? repo.repoPath === repoPath
      : repo.project === project;
    if (!isSameRepo) continue;
    const hasWorktree = repo.worktrees.some((wt) => wt.branch === branch);
    if (!hasWorktree) continue;
    return pendingKey(repo.project, branch);
  }
  return undefined;
}

export interface ModalActionDeps {
  treeItems: TreeItem[];
  filteredRepos: RepoInfo[];
  selectedIndex: number;
  mode: Mode;
  openModalRepoProject: string;
  openModalRepoPath: string;
  /** Active lifecycle operations, keyed by Workspace Identity. */
  lifecycle: LifecycleState;
  /**
   * The synchronous claim ledger arbitrating Workspace Identities, shared with
   * `useSessionActions` so an `open` and an `up`/`down`/`close` cannot both
   * claim one Workspace.
   */
  lifecycleClaims: LifecycleClaims;

  setLifecycle: Dispatch<SetStateAction<LifecycleState>>;
  setMode: (m: Mode) => void;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  setOpenModalBase: (v: string | undefined) => void;
  setOpenModalProfiles: (v: string[]) => void;
  setOpenModalRepoProject: (v: string) => void;
  setOpenModalRepoPath: (v: string) => void;

  /**
   * Records a Workspace Identity as freshly discovered by an `open`, which
   * PRESENTS it as expanded without ever writing the stored
   * `expandedWorktreeKeys` preference — the same presentation-only mechanism
   * an active lifecycle already uses.
   */
  markWorkspaceDiscovered: (worktreeKey: string) => void;

  showActionError: (msg: string) => void;
  clearActionError: () => void;
  switchSession: (name: string, client?: TmuxClient | null) => Promise<boolean>;
  discoverClient: (signal?: AbortSignal) => Promise<TmuxClientDiscovery>;
  /** The shared `up` lifecycle, owned by `useSessionActions`. */
  startWorkspace: (target: StartWorkspaceTarget) => Promise<void>;
  /**
   * Resolves the registry snapshot the refresh observed, or `null` when it
   * failed (previous repos kept). Lifecycle reconciliation must read THAT
   * snapshot, never the render-time `filteredRepos` capture.
   */
  refreshAll: () => Promise<RepoInfo[] | null>;

  upModalReturnModeRef: MutableRefObject<Mode>;
  upModalReturnSelectedIndexRef: MutableRefObject<number>;
  modalReturnModeRef: MutableRefObject<Mode>;
}

export function createPrepareOpenModal(deps: ModalActionDeps) {
  return () => {
    deps.modalReturnModeRef.current = resolveTreeReturnMode(deps.mode);
    const selected = deps.treeItems[deps.selectedIndex];
    let base: string | undefined;
    let profiles: string[] = [];
    let project = "";
    let repoPath = "";
    if (selected) {
      const repo = deps.filteredRepos[selected.repoIndex];
      if (repo) {
        profiles = repo.profileNames;
        project = repo.project;
        repoPath = repo.repoPath;
      }
      if (
        repo &&
        (selected.type === "worktree" || selected.type === "detail")
      ) {
        const wt = repo.worktrees[selected.worktreeIndex];
        if (wt) {
          base = wt.branch;
        }
      }
    }
    deps.setOpenModalBase(base);
    deps.setOpenModalProfiles(profiles);
    deps.setOpenModalRepoProject(project);
    deps.setOpenModalRepoPath(repoPath);
    deps.setMode(Mode.OpenModal);
  };
}

export function createHandleOpen(deps: ModalActionDeps) {
  return (opts: OpenModalResult) => {
    deps.setMode(deps.modalReturnModeRef.current);
    const requestedBranch = opts.pr ? undefined : opts.branch;
    const project = deps.openModalRepoProject || "unknown";
    const repoPath = deps.openModalRepoPath;

    // `open` goes through the SAME shared lifecycle shape as up/down/close —
    // present → run with the reporter → validate → tear down → hand off →
    // report — so the ordering contract has exactly one implementation. The
    // Workspace does not exist yet, so its entry IS its representation in the
    // tree: a Pending Workspace row plus a `Preparing Workspace…` progress
    // row, both inert, both visible before git knows about the worktree.
    void runLifecycleOperation<WorkspaceOpenResult>({
      claims: deps.lifecycleClaims,
      setLifecycle: deps.setLifecycle,
      refreshAll: deps.refreshAll,
      showActionError: deps.showActionError,
      entry: {
        operation: "open",
        repoPath,
        project,
        branch: opts.branch,
        phase: { _tag: "Preparing" },
      },
      run: (reporter) =>
        tuiRuntime.runPromise(
          WorkspaceService.use((service) =>
            service.open({
              branch: requestedBranch,
              base: opts.base,
              cwd: deps.openModalRepoPath || undefined,
              pr: opts.pr,
              profile: opts.profile,
              existing: opts.existing,
              reporter,
            }),
          ),
        ),
      resultWarnings: (result) => result.warnings.map(formatWorkspaceWarning),
      // A Workspace validation DID find on disk is left expanded once the
      // presentation comes down. The override is presentation-only, so the
      // stored expansion preference is still never written by lifecycle code;
      // an identity that validation found nothing for records nothing and
      // simply disappears.
      onValidated: (snapshot) => {
        const discovered = discoveredWorkspaceKey(
          snapshot,
          repoPath,
          project,
          opts.branch,
        );
        if (discovered) deps.markWorkspaceDiscovered(discovered);
      },
      afterCleanup: (result) => openSessionHandoff(deps, opts, result),
    });
  };
}

/**
 * The automatic tmux client switch after a successful `open`, run by the shared
 * lifecycle AFTER validation and teardown: switching detaches the terminal this
 * TUI is drawn in, and a failure here must surface as a plain action error
 * rather than resurrecting a progress row.
 *
 * Distinct from `up`'s `createSessionHandoff`: `open` gates on `noAttach` and
 * reports the degenerate client cases (none / multiple / query failure) that a
 * start does not.
 */
async function openSessionHandoff(
  deps: ModalActionDeps,
  opts: OpenModalResult,
  result: WorkspaceOpenResult,
): Promise<string | undefined> {
  if (opts.noAttach || !workspaceOpenStartedTmux(result)) return undefined;

  const liveClient = await deps.discoverClient();
  if (liveClient.type === "single") {
    const switched = await deps.switchSession(
      result.sessionName,
      liveClient.client,
    );
    return switched
      ? undefined
      : `Started session '${result.sessionName}', but failed to switch client`;
  }
  if (liveClient.type === "none") {
    return "No tmux client found — start tmux in the other pane";
  }
  if (liveClient.type === "error") {
    return `Opened session '${result.sessionName}' but failed to query tmux clients to switch`;
  }
  return "Cannot switch tmux client after open because multiple tmux clients are attached";
}

export function createPrepareUpModal(deps: ModalActionDeps) {
  return () => {
    const worktreeIndex = resolveSelectedWorktreeIndex(
      deps.treeItems,
      deps.selectedIndex,
    );
    if (worktreeIndex === null) return;

    const item = deps.treeItems[worktreeIndex];
    if (item?.type !== "worktree") return;

    const repo = deps.filteredRepos[item.repoIndex];
    const wt = repo?.worktrees[item.worktreeIndex];
    if (!repo || !wt) return;

    // Refused through the SAME shared guard as space/down/close, so a busy
    // Workspace says so immediately instead of opening an option sheet the
    // submit would only refuse afterwards.
    if (
      rejectIfLifecycleActive({
        lifecycle: deps.lifecycle,
        mainRepoPath: repo.repoPath,
        branch: wt.branch,
        showActionError: deps.showActionError,
      })
    ) {
      return;
    }

    const worktreeKey = pendingKey(repo.project, wt.branch);
    deps.upModalReturnSelectedIndexRef.current = deps.selectedIndex;
    deps.upModalReturnModeRef.current =
      deps.mode.type === "Expanded"
        ? Mode.Expanded(worktreeKey)
        : Mode.Navigate;
    deps.setMode(
      Mode.UpModal(
        wt.path,
        worktreeKey,
        repo.repoPath,
        wt.branch,
        repo.project,
        repo.profileNames,
      ),
    );
  };
}

export function createHandleUpSubmit(deps: ModalActionDeps) {
  return (result: UpModalResult) => {
    if (deps.mode.type !== "UpModal") return;

    // Identity comes off the mode, never off the display key: `project` is
    // free-form and may itself contain a slash, so splitting `worktreeKey`
    // would claim a bogus lifecycleKey and lose the operation.
    const { worktreePath, repoPath, branch, project } = deps.mode;
    deps.clearActionError();
    deps.setSelectedIndex(deps.upModalReturnSelectedIndexRef.current);
    deps.setMode(deps.upModalReturnModeRef.current);

    // The modal is only an option sheet: the start itself goes through the ONE
    // shared `up` lifecycle, so the space-bar start and this one show the same
    // phase-by-phase progress and validate identically.
    void deps.startWorkspace({
      worktreePath,
      repoPath,
      project,
      branch,
      ...(result.profile ? { profile: result.profile } : {}),
      autoSwitch: result.autoSwitch,
    });
  };
}

export function createPrepareAddProjectModal(deps: ModalActionDeps) {
  return () => {
    deps.modalReturnModeRef.current = resolveTreeReturnMode(deps.mode);
    deps.setMode(Mode.AddProjectModal);
  };
}

export function createHandleAddProject(deps: ModalActionDeps) {
  return (result: AddProjectModalResult) => {
    deps.clearActionError();
    deps.setMode(deps.modalReturnModeRef.current);
    (async () => {
      try {
        await runTuiSilentPromise(
          registerProject({
            path: result.path,
            name: result.nameManuallyEdited ? result.name : undefined,
            forceRename: result.nameManuallyEdited,
            tolerateConfigErrors: true,
          }),
        );
        await deps.refreshAll();
      } catch (error) {
        deps.showActionError(toWctError(error).message);
      }
    })();
  };
}

export function useModalActions(deps: ModalActionDeps) {
  return {
    prepareOpenModal: createPrepareOpenModal(deps),
    handleOpen: createHandleOpen(deps),
    prepareUpModal: createPrepareUpModal(deps),
    handleUpSubmit: createHandleUpSubmit(deps),
    prepareAddProjectModal: createPrepareAddProjectModal(deps),
    handleAddProject: createHandleAddProject(deps),
  };
}
