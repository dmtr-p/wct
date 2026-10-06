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
      worktreeKey: string;
      repoPath: string;
      /** Never derive branch from worktreeKey — project display names can collide across repos. */
      branch: string;
      project: string;
      profileNames: string[];
    }
  | { type: "Expanded"; worktreeKey: string }
  | {
      type: "ConfirmKill";
      paneId: string;
      label: string;
      worktreeKey: string;
    }
  | {
      type: "ConfirmDown";
      sessionName: string;
      branch: string;
      worktreePath: string;
      worktreeKey: string;
      repoPath: string;
      project: string;
    }
  | {
      type: "ConfirmClose";
      sessionName: string;
      branch: string;
      worktreePath: string;
      worktreeKey: string;
      repoPath: string;
      project: string;
      changedFiles: number;
    }
  | {
      type: "ConfirmCloseForce";
      sessionName: string;
      branch: string;
      worktreePath: string;
      worktreeKey: string;
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
    worktreeKey,
    repoPath,
    branch,
    project,
    profileNames,
  }: Omit<Extract<Mode, { type: "UpModal" }>, "type">): Mode => ({
    type: "UpModal",
    worktreePath,
    worktreeKey,
    repoPath,
    branch,
    project,
    profileNames,
  }),
  Expanded: (worktreeKey: string): Mode => ({
    type: "Expanded",
    worktreeKey,
  }),
  ConfirmKill: (paneId: string, label: string, worktreeKey: string): Mode => ({
    type: "ConfirmKill",
    paneId,
    label,
    worktreeKey,
  }),
  ConfirmDown: ({
    sessionName,
    branch,
    worktreePath,
    worktreeKey,
    repoPath,
    project,
  }: Omit<Extract<Mode, { type: "ConfirmDown" }>, "type">): Mode => ({
    type: "ConfirmDown",
    sessionName,
    branch,
    worktreePath,
    worktreeKey,
    repoPath,
    project,
  }),
  ConfirmClose: (
    sessionName: string,
    branch: string,
    worktreePath: string,
    worktreeKey: string,
    repoPath: string,
    project: string,
    changedFiles: number,
  ): Mode => ({
    type: "ConfirmClose",
    sessionName,
    branch,
    worktreePath,
    worktreeKey,
    repoPath,
    project,
    changedFiles,
  }),
  ConfirmCloseForce: (
    sessionName: string,
    branch: string,
    worktreePath: string,
    worktreeKey: string,
    repoPath: string,
    project: string,
  ): Mode => ({
    type: "ConfirmCloseForce",
    sessionName,
    branch,
    worktreePath,
    worktreeKey,
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
        rollupState: "success" | "failure" | "pending" | "unknown" | null;
        prKey?: string;
        presentation?: import("./pr-status").PrPresentation;
        pr?: import("../services/pr-model").PrFacts;
        expanded?: boolean;
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

/** GitHub PR info from `gh` CLI */
export interface PRInfo {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
  rollupState: "success" | "failure" | "pending" | "unknown" | null;
  facts?: import("../services/pr-model").PrFacts;
}

export type { TmuxPaneInfo as PaneInfo } from "../services/tmux";

/** Worktree Display Key: Project Display Name + branch, not Workspace Identity. */
export function worktreeDisplayKey(
  projectDisplayName: string,
  branch: string,
): string {
  return `${projectDisplayName}/${branch}`;
}
