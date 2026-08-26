// src/tui/hooks/useModalActions.ts

import { Effect } from "effect";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { toWctError } from "../../errors";
import { registerProject } from "../../services/project-registration";
import type { TmuxClient } from "../../services/tmux";
import {
  type WorkspaceOpenResult,
  type WorkspaceReporter,
  WorkspaceService,
  type WorkspaceUpResult,
  type WorkspaceWarning,
} from "../../services/workspace-service";
import type { AddProjectModalResult } from "../components/AddProjectModal";
import type { OpenModalResult } from "../components/OpenModal";
import type { UpModalResult } from "../components/UpModal";
import {
  type LifecycleEntry,
  type LifecyclePhase,
  type LifecycleState,
  lifecycleKey,
} from "../lifecycle";
import { runTuiSilentPromise, tuiRuntime } from "../runtime";
import {
  resolveSelectedWorktreeIndex,
  resolveTreeReturnMode,
} from "../tree-helpers";
import { Mode, type PendingAction, pendingKey, type TreeItem } from "../types";
import type { RepoInfo } from "./useRegistry";
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
  handleStartResult: (
    result: WorkspaceUpResult,
    autoSwitch: boolean,
  ) => Promise<void>;
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

/**
 * Begin a lifecycle for one Workspace Identity and hand back the three
 * operations every lifecycle-driving handler needs: advance the phase, drive
 * it from a `WorkspaceReporter`, and tear the presentation down.
 *
 * `setPhase`/`end` are no-ops once the entry is gone, so a late reporter event
 * (or a second teardown from a `finally`) can never resurrect a progress row
 * for a finished operation, and neither can they touch another identity's
 * entry.
 */
function beginLifecycle(
  deps: ModalActionDeps,
  entry: LifecycleEntry,
): {
  setPhase: (phase: LifecyclePhase) => void;
  end: () => void;
  reporter: WorkspaceReporter;
} {
  const key = lifecycleKey(entry.repoPath, entry.branch);
  deps.setLifecycle((previous) => new Map(previous).set(key, entry));

  const setPhase = (phase: LifecyclePhase) => {
    deps.setLifecycle((previous) => {
      const current = previous.get(key);
      if (!current) return previous;
      const next = new Map(previous);
      next.set(key, { ...current, phase });
      return next;
    });
  };

  const end = () => {
    deps.setLifecycle((previous) => {
      if (!previous.has(key)) return previous;
      const next = new Map(previous);
      next.delete(key);
      return next;
    });
  };

  return {
    setPhase,
    end,
    reporter: {
      // Effect.sync, never a failing effect: the service also isolates
      // reporter failures, but a progress reporter has no business being able
      // to fail an open in the first place.
      event: (event) =>
        Effect.sync(() => {
          if (event._tag !== "PhaseStarted") return;
          setPhase(event.phase);
        }),
    },
  };
}

export function createHandleOpen(deps: ModalActionDeps) {
  return (opts: OpenModalResult) => {
    deps.setMode(deps.modalReturnModeRef.current);
    const requestedBranch = opts.pr ? undefined : opts.branch;
    const project = deps.openModalRepoProject || "unknown";
    const repoPath = deps.openModalRepoPath;
    const key = pendingKey(project, opts.branch);
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

    // The Workspace does not exist yet, so this entry IS its representation in
    // the tree: a Pending Workspace row plus a `Preparing Workspace…` progress
    // row, both inert, both visible before git knows about the worktree.
    const lifecycle = beginLifecycle(deps, {
      operation: "open",
      repoPath,
      project,
      branch: opts.branch,
      phase: { _tag: "Preparing" },
    });

    void (async () => {
      let warningMessage: string | undefined;

      const appendWarning = (message: string) => {
        warningMessage = warningMessage
          ? `${warningMessage}\n${message}`
          : message;
      };

      try {
        let result: WorkspaceOpenResult;
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
          deps.showActionError(toWctError(error).message);
          return;
        }

        if (result.warnings.length > 0) {
          appendWarning(result.warnings.map(formatWorkspaceWarning).join("\n"));
        }

        // Reconciliation, in this order and no other: the row says
        // `Validating Workspace…` while registry/worktree/tmux state is
        // re-read, and ONLY once that settles is the lifecycle presentation
        // taken down. Removing it earlier would blink the Pending Workspace out
        // of the tree before the real worktree appeared in `repos`.
        lifecycle.setPhase({ _tag: "Validating" });
        try {
          await deps.refreshAll();
        } catch (error) {
          appendWarning(
            `Refresh failed after open: ${toWctError(error).message}`,
          );
        }
        lifecycle.end();

        // The automatic tmux client switch happens last, after validation and
        // after the progress row is gone: switching detaches the terminal this
        // TUI is drawn in, and a switch failure must surface as a plain action
        // error rather than resurrecting a progress row.
        if (!opts.noAttach && workspaceOpenStartedTmux(result)) {
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
    deps.setMode(Mode.UpModal(wt.path, worktreeKey, repo.profileNames));
  };
}

export function createHandleUpSubmit(deps: ModalActionDeps) {
  return (result: UpModalResult) => {
    if (deps.mode.type !== "UpModal") return;

    const { worktreePath, worktreeKey } = deps.mode;
    deps.clearActionError();
    deps.setSelectedIndex(deps.upModalReturnSelectedIndexRef.current);
    deps.setMode(deps.upModalReturnModeRef.current);

    const branch = worktreeKey.split("/").slice(1).join("/");
    const project = worktreeKey.split("/")[0] ?? "unknown";
    deps.setPendingActions((prev) =>
      new Map(prev).set(worktreeKey, {
        type: "starting",
        branch,
        project,
      }),
    );

    void (async () => {
      try {
        const upResult = await tuiRuntime.runPromise(
          WorkspaceService.use((service) =>
            service.up({
              path: worktreePath,
              profile: result.profile,
            }),
          ),
        );
        await deps.handleStartResult(upResult, result.autoSwitch);
      } catch (error) {
        deps.showActionError(toWctError(error).message);
        await deps.refreshAll();
      } finally {
        deps.setPendingActions((prev) => {
          const next = new Map(prev);
          next.delete(worktreeKey);
          return next;
        });
      }
    })();
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
