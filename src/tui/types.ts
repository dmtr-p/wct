import type { WorkspaceIdentityKey } from "../services/identities";
/** Expansion-related targets carry opaque Workspace Identity Keys. */
export type Mode =
  | { type: "Navigate" }
  | { type: "Search" }
  | { type: "Shortcuts" }
  | { type: "OpenModal" }
  | { type: "PrMenu" }
  | { type: "AddProjectModal" }
  | {
      type: "UpModal";
      worktreePath: string;
      workspaceKey: WorkspaceIdentityKey;
      repoPath: string;
      branch: string;
      project: string;
      profileNames: string[];
    }
  | { type: "Expanded"; workspaceKey: WorkspaceIdentityKey }
  | {
      type: "ConfirmKill";
      paneId: string;
      label: string;
      workspaceKey: WorkspaceIdentityKey;
    }
  | {
      type: "ConfirmDown";
      sessionName: string;
      branch: string;
      worktreePath: string;
      workspaceKey: WorkspaceIdentityKey;
      repoPath: string;
      project: string;
    }
  | {
      type: "ConfirmClose";
      sessionName: string;
      branch: string;
      worktreePath: string;
      workspaceKey: WorkspaceIdentityKey;
      repoPath: string;
      project: string;
      changedFiles: number;
    }
  | {
      type: "ConfirmCloseForce";
      sessionName: string;
      branch: string;
      worktreePath: string;
      workspaceKey: WorkspaceIdentityKey;
      repoPath: string;
      project: string;
    }
  | {
      type: "ConfirmRemoveProject";
      repoPath: string;
      project: string;
    };

export const Mode = {
  Navigate: { type: "Navigate" } as Mode,
  Search: { type: "Search" } as Mode,
  Shortcuts: { type: "Shortcuts" } as Mode,
  OpenModal: { type: "OpenModal" } as Mode,
  PrMenu: { type: "PrMenu" } as Mode,
  AddProjectModal: { type: "AddProjectModal" } as Mode,
  UpModal: ({
    worktreePath,
    workspaceKey,
    repoPath,
    branch,
    project,
    profileNames,
  }: Omit<Extract<Mode, { type: "UpModal" }>, "type">): Mode => ({
    type: "UpModal",
    worktreePath,
    workspaceKey,
    repoPath,
    branch,
    project,
    profileNames,
  }),
  Expanded: (workspaceKey: WorkspaceIdentityKey): Mode => ({
    type: "Expanded",
    workspaceKey,
  }),
  ConfirmKill: (
    paneId: string,
    label: string,
    workspaceKey: WorkspaceIdentityKey,
  ): Mode => ({
    type: "ConfirmKill",
    paneId,
    label,
    workspaceKey,
  }),
  ConfirmDown: ({
    sessionName,
    branch,
    worktreePath,
    workspaceKey,
    repoPath,
    project,
  }: Omit<Extract<Mode, { type: "ConfirmDown" }>, "type">): Mode => ({
    type: "ConfirmDown",
    sessionName,
    branch,
    worktreePath,
    workspaceKey,
    repoPath,
    project,
  }),
  ConfirmClose: (
    sessionName: string,
    branch: string,
    worktreePath: string,
    workspaceKey: WorkspaceIdentityKey,
    repoPath: string,
    project: string,
    changedFiles: number,
  ): Mode => ({
    type: "ConfirmClose",
    sessionName,
    branch,
    worktreePath,
    workspaceKey,
    repoPath,
    project,
    changedFiles,
  }),
  ConfirmCloseForce: (
    sessionName: string,
    branch: string,
    worktreePath: string,
    workspaceKey: WorkspaceIdentityKey,
    repoPath: string,
    project: string,
  ): Mode => ({
    type: "ConfirmCloseForce",
    sessionName,
    branch,
    worktreePath,
    workspaceKey,
    repoPath,
    project,
  }),
  ConfirmRemoveProject: (repoPath: string, project: string): Mode => ({
    type: "ConfirmRemoveProject",
    repoPath,
    project,
  }),
};

export type TreeItem =
  | { type: "repo"; repoIndex: number }
  | { type: "worktree"; repoIndex: number; worktreeIndex: number }
  | DetailItem<
      "pr",
      {
        prKey: string;
        presentation: import("./pr-status").PrPresentation;
        pr: import("../services/pr-model").PrFacts;
        expanded: boolean;
      }
    >
  | DetailItem<"pr-title", { prKey: string }>
  | DetailItem<"pr-fact", { prKey: string; factKey: string }>
  | DetailItem<"candidate-group", { groupKey: string; expanded: boolean }>
  | DetailItem<
      "candidate",
      { groupKey: string; pr: import("../services/pr-model").PrFacts }
    >
  | DetailItem<"pane-header">
  | DetailItem<
      "pane",
      {
        paneId: string;
        zoomed?: boolean;
        active?: boolean;
        window: string;
        paneIndex: number;
        command: string;
        agent?: import("../services/agent-model").AgentObservation;
      }
    >;

export type DetailKind =
  | "pr"
  | "pr-title"
  | "pr-fact"
  | "candidate-group"
  | "candidate"
  | "pane-header"
  | "pane";

type DetailItem<
  TKind extends DetailKind,
  TMeta = undefined,
> = TMeta extends undefined
  ? {
      type: "detail";
      repoIndex: number;
      worktreeIndex: number;
      detailKind: TKind;
      label: string;
      action?: () => void;
    }
  : {
      type: "detail";
      repoIndex: number;
      worktreeIndex: number;
      detailKind: TKind;
      label: string;
      action?: () => void;
      meta: TMeta;
    };

export type { TmuxPaneInfo as PaneInfo } from "../services/tmux";
