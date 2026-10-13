import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { toWctError } from "../../errors";
import { registerProject } from "../../services/project-registration";
import {
  type WorkspaceOpenResult,
  WorkspaceService,
} from "../../services/workspace-service";
import type { AddProjectModalResult } from "../components/AddProjectModal";
import type { OpenModalResult } from "../components/OpenModal";
import type { UpModalResult } from "../components/UpModal";
import {
  type LifecycleClaims,
  type LifecycleState,
  rejectIfLifecycleActive,
  runLifecycleOperation,
  workspaceIdentityKey,
} from "../lifecycle";
import { runTuiSilentPromise, tuiRuntime } from "../runtime";
import {
  createSessionHandoff,
  type SessionHandoffDeps,
} from "../session-handoff";
import {
  resolveSelectedWorktreeIndex,
  resolveTreeReturnMode,
} from "../tree-helpers";
import type { ReturnSlot } from "../tree-navigation";
import { Mode, type TreeItem } from "../types";
import { formatWorkspaceWarning } from "../workspace-warning";
import type { RepoInfo } from "./useRegistry";
import type { StartWorkspaceTarget } from "./useSessionActions";

function discoveredWorkspaceIdentityKey(
  snapshot: readonly RepoInfo[],
  repoPath: string,
  branch: string,
): string | undefined {
  if (!repoPath) return undefined;
  for (const repo of snapshot) {
    if (repo.repoPath !== repoPath) continue;
    const hasWorktree = repo.worktrees.some((wt) => wt.branch === branch);
    if (!hasWorktree) continue;
    return workspaceIdentityKey(repo.repoPath, branch);
  }
  return undefined;
}

export interface ModalActionDeps extends SessionHandoffDeps {
  treeItems: TreeItem[];
  filteredRepos: RepoInfo[];
  selectedIndex: number;
  mode: Mode;
  openModalRepoProject: string;
  openModalRepoPath: string;
  lifecycle: LifecycleState;
  // Shared with `useSessionActions` so an `open` and an `up`/`down`/`close`
  // can't both claim the same Workspace.
  lifecycleClaims: LifecycleClaims;

  setLifecycle: Dispatch<SetStateAction<LifecycleState>>;
  setMode: (m: Mode) => void;
  captureTreeReturnPosition: (slot: ReturnSlot) => void;
  restoreTreeReturnPosition: (slot: ReturnSlot) => void;
  setOpenModalBase: (v: string | undefined) => void;
  setOpenModalProfiles: (v: string[]) => void;
  setOpenModalRepoProject: (v: string) => void;
  setOpenModalRepoPath: (v: string) => void;

  markWorkspaceDiscovered: (workspaceKey: string) => void;

  showActionError: (msg: string) => void;
  clearActionError: () => void;
  startWorkspace: (target: StartWorkspaceTarget) => Promise<void>;
  // Lifecycle reconciliation must read the snapshot this resolves to, never
  // the render-time `filteredRepos` capture.
  refreshAll: () => Promise<RepoInfo[] | null>;

  upModalReturnModeRef: MutableRefObject<Mode>;
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
  const sessionHandoff = createSessionHandoff(deps);
  return (opts: OpenModalResult) => {
    deps.setMode(deps.modalReturnModeRef.current);
    const requestedBranch = opts.pr ? undefined : opts.branch;
    const project = deps.openModalRepoProject || "unknown";
    const repoPath = deps.openModalRepoPath;

    // Create the entry before service.open so Pending Workspaces can render
    // before Git exposes their worktrees.
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
      onValidated: (snapshot) => {
        const discovered = discoveredWorkspaceIdentityKey(
          snapshot,
          repoPath,
          opts.branch,
        );
        if (discovered) deps.markWorkspaceDiscovered(discovered);
      },
      afterCleanup: (result) =>
        sessionHandoff({
          repoPath,
          branch: opts.branch,
          sessionName: result.sessionName,
          tmux: result.attempts.tmux,
          autoSwitch: !opts.noAttach,
          wording: { action: "open", completed: "Opened" },
        }),
    });
  };
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

    // Same guard as space/down/close: refuse before opening the option
    // sheet, not after submit.
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

    const workspaceKey = workspaceIdentityKey(repo.repoPath, wt.branch);
    deps.captureTreeReturnPosition("up");
    deps.upModalReturnModeRef.current =
      deps.mode.type === "Expanded"
        ? Mode.Expanded(workspaceKey)
        : Mode.Navigate;
    deps.setMode(
      Mode.UpModal({
        worktreePath: wt.path,
        workspaceKey,
        repoPath: repo.repoPath,
        branch: wt.branch,
        project: repo.project,
        profileNames: repo.profileNames,
      }),
    );
  };
}

export function createHandleUpSubmit(deps: ModalActionDeps) {
  return (result: UpModalResult) => {
    if (deps.mode.type !== "UpModal") return;

    const { worktreePath, repoPath, branch, project } = deps.mode;
    deps.clearActionError();
    deps.restoreTreeReturnPosition("up");
    deps.setMode(deps.upModalReturnModeRef.current);

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
    void (async () => {
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
