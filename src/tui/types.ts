// src/tui/types.ts

import type { PrCheckInfo } from "../services/github-service";

/** TUI interaction modes */
export type Mode =
  | { type: "Navigate" }
  | { type: "Search" }
  | { type: "OpenModal" }
  | { type: "AddProjectModal" }
  | {
      type: "UpModal";
      worktreePath: string;
      worktreeKey: string;
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
    };

export const Mode = {
  Navigate: { type: "Navigate" } as Mode,
  Search: { type: "Search" } as Mode,
  OpenModal: { type: "OpenModal" } as Mode,
  AddProjectModal: { type: "AddProjectModal" } as Mode,
  UpModal: (
    worktreePath: string,
    worktreeKey: string,
    profileNames: string[],
  ): Mode => ({
    type: "UpModal",
    worktreePath,
    worktreeKey,
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
  ConfirmDown: (
    sessionName: string,
    branch: string,
    worktreePath: string,
    worktreeKey: string,
  ): Mode => ({
    type: "ConfirmDown",
    sessionName,
    branch,
    worktreePath,
    worktreeKey,
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
};

export type TreeItem =
  | { type: "repo"; repoIndex: number }
  | { type: "worktree"; repoIndex: number; worktreeIndex: number }
  | DetailItem<"pr">
  | DetailItem<"check", { state?: string }>
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

export type DetailKind = "pr" | "check" | "pane-header" | "pane";

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

/** Pending action for optimistic UI */
export interface PendingAction {
  type: "opening" | "closing" | "starting" | "stopping";
  branch: string;
  project: string;
}

/** GitHub PR info from `gh` CLI */
export interface PRInfo {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
  checks: PrCheckInfo[];
}

export type { TmuxPaneInfo as PaneInfo } from "../services/tmux";

/** Format a pending action key */
export function pendingKey(project: string, branch: string): string {
  return `${project}/${branch}`;
}

/** Map check state to display icon */
export function checkIcon(state: string): string {
  switch (state) {
    case "SUCCESS":
      return "✓";
    case "FAILURE":
      return "✗";
    case "PENDING":
    case "QUEUED":
    case "IN_PROGRESS":
      return "◌";
    case "SKIPPED":
      return "⊘";
    case "CANCELLED":
      return "⊘";
    default:
      return "?";
  }
}

/** Map check state to Ink color name */
export function checkColor(
  state: string,
): "green" | "red" | "yellow" | "dim" | undefined {
  switch (state) {
    case "SUCCESS":
      return "green";
    case "FAILURE":
      return "red";
    case "PENDING":
    case "QUEUED":
    case "IN_PROGRESS":
      return "yellow";
    default:
      return "dim";
  }
}
