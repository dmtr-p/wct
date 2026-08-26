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
  beginLifecycle,
  type LifecycleClaims,
  type LifecycleState,
  lifecycleValidationWarning,
} from "../lifecycle";
import { runTuiSilentPromise, tuiRuntime } from "../runtime";
import {
  resolveSelectedWorktreeIndex,
  resolveTreeReturnMode,
} from "../tree-helpers";
import { Mode, type PendingAction, pendingKey, type TreeItem } from "../types";
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
  setPendingActions: Dispatch<SetStateAction<Map<string, PendingAction>>>;
  setOpenModalBase: (v: string | undefined) => void;
  setOpenModalProfiles: (v: string[]) => void;
  setOpenModalRepoProject: (v: string) => void;
  setOpenModalRepoPath: (v: string) => void;

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
    const key = pendingKey(project, opts.branch);

    // The Workspace does not exist yet, so this entry IS its representation in
    // the tree: a Pending Workspace row plus a `Preparing Workspace…` progress
    // row, both inert, both visible before git knows about the worktree.
    //
    // The claim comes FIRST, before any other bookkeeping: a refused open must
    // leave the running operation's state — including the pending-action entry
    // it shares this display key with — exactly as it found it (AC-28).
    const lifecycle = beginLifecycle({
      claims: deps.lifecycleClaims,
      setLifecycle: deps.setLifecycle,
      showActionError: deps.showActionError,
      entry: {
        operation: "open",
        repoPath,
        project,
        branch: opts.branch,
        phase: { _tag: "Preparing" },
      },
    });
    // Refused: this Workspace Identity is already in flight. The refusal has
    // been reported through the timed error display, and this handler must
    // stop here — running `open` anyway would race the active operation and
    // its teardown would take down the active operation's presentation.
    if (!lifecycle) return;

    deps.setPendingActions((prev) =>
      new Map(prev).set(key, {
        type: "opening",
        branch: opts.branch,
        project,
      }),
    );

    const clearPending = () => {
      deps.setPendingActions((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    };

    void (async () => {
      // Every outcome — a fatal failure, a partial build with warnings, a
      // clean open — is COLLECTED here and reported only once validation has
      // finished (AC-17). Nothing about an outcome is ever painted as a
      // lifecycle row.
      let warningMessage: string | undefined;

      const appendWarning = (message: string) => {
        warningMessage = warningMessage
          ? `${warningMessage}\n${message}`
          : message;
      };

      try {
        let result: WorkspaceOpenResult | undefined;
        try {
          result = await tuiRuntime.runPromise(
            WorkspaceService.use((service) =>
              service.open({
                branch: requestedBranch,
                base: opts.base,
                cwd: deps.openModalRepoPath || undefined,
                pr: opts.pr,
                profile: opts.profile,
                existing: opts.existing,
                reporter: lifecycle.reporter,
              }),
            ),
          );
        } catch (error) {
          // A fatal open does NOT skip validation: git may already have created
          // the worktree before the failing phase, so the tree still has to be
          // told the truth about what exists on disk before this error is shown
          // (AC-14).
          appendWarning(toWctError(error).message);
        }

        if (result && result.warnings.length > 0) {
          appendWarning(result.warnings.map(formatWorkspaceWarning).join("\n"));
        }

        // Reconciliation, in this order and no other and on BOTH branches: the
        // row says `Validating Workspace…` while registry/worktree/tmux state
        // is re-read, and ONLY once that settles is the lifecycle presentation
        // taken down. Removing it earlier would blink the Pending Workspace out
        // of the tree before the real worktree appeared in `repos`.
        lifecycle.setPhase({ _tag: "Validating" });
        // Reconcile against the snapshot THIS closure's own validation
        // observed — never the render-time `filteredRepos` capture and never a
        // shared ref, which a concurrently finishing operation would have
        // overwritten while this one awaited (AC-32). A `null` snapshot means
        // validation could not observe anything: the previous tree stays on
        // screen, the user is warned, and the lifecycle UI still comes down.
        // The null check lives INSIDE the try so a throwing refresh is
        // reported once, by its own message, rather than twice.
        try {
          const snapshot = await deps.refreshAll();
          if (snapshot === null) {
            appendWarning(lifecycleValidationWarning("open"));
          }
        } catch (error) {
          appendWarning(
            `Refresh failed after open: ${toWctError(error).message}`,
          );
        }
        // Ending THIS identity's entry is the whole reconciliation. The row
        // model derives a Pending Workspace from (an `open` entry ∧ its branch
        // absent from `repos`), and `refreshAll` has already committed the
        // snapshot above, so in the SAME React commit: an identity that
        // validation found no managed worktree for loses its Pending Workspace
        // entirely (AC-15), while one whose worktree WAS created — a later copy,
        // setup or tmux phase having failed — is rendered from `repos` as the
        // discovered Workspace and simply stays there (AC-16). `end` is keyed,
        // so another identity's concurrent lifecycle is untouched.
        lifecycle.end();

        // The automatic tmux client switch happens last, after validation and
        // after the progress row is gone: switching detaches the terminal this
        // TUI is drawn in, and a switch failure must surface as a plain action
        // error rather than resurrecting a progress row.
        if (result && !opts.noAttach && workspaceOpenStartedTmux(result)) {
          const liveClient = await deps.discoverClient();
          if (liveClient.type === "single") {
            const switched = await deps.switchSession(
              result.sessionName,
              liveClient.client,
            );
            if (!switched) {
              appendWarning(
                `Started session '${result.sessionName}', but failed to switch client`,
              );
            }
          } else if (liveClient.type === "none") {
            appendWarning(
              "No tmux client found — start tmux in the other pane",
            );
          } else if (liveClient.type === "error") {
            appendWarning(
              `Opened session '${result.sessionName}' but failed to query tmux clients to switch`,
            );
          } else if (liveClient.type === "multiple") {
            appendWarning(
              "Cannot switch tmux client after open because multiple tmux clients are attached",
            );
          }
        }

        if (warningMessage) {
          deps.showActionError(warningMessage);
        }
      } finally {
        lifecycle.end();
        clearPending();
      }
    })();
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

    const worktreeKey = pendingKey(repo.project, wt.branch);
    deps.upModalReturnSelectedIndexRef.current = deps.selectedIndex;
    deps.upModalReturnModeRef.current =
      deps.mode.type === "Expanded"
        ? Mode.Expanded(worktreeKey)
        : Mode.Navigate;
    deps.setMode(
      Mode.UpModal(wt.path, worktreeKey, repo.repoPath, repo.profileNames),
    );
  };
}

export function createHandleUpSubmit(deps: ModalActionDeps) {
  return (result: UpModalResult) => {
    if (deps.mode.type !== "UpModal") return;

    const { worktreePath, worktreeKey, repoPath } = deps.mode;
    deps.clearActionError();
    deps.setSelectedIndex(deps.upModalReturnSelectedIndexRef.current);
    deps.setMode(deps.upModalReturnModeRef.current);

    const branch = worktreeKey.split("/").slice(1).join("/");
    const project = worktreeKey.split("/")[0] ?? "unknown";

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
