// src/tui/types.ts

/** TUI interaction modes */
export type Mode =
  | { type: "Navigate" }
  | { type: "Search" }
  | { type: "OpenModal" }
  | { type: "Expanded"; worktreeKey: string };

export const Mode = {
  Navigate: { type: "Navigate" } as Mode,
  Search: { type: "Search" } as Mode,
  OpenModal: { type: "OpenModal" } as Mode,
  Expanded: (worktreeKey: string): Mode => ({
    type: "Expanded",
    worktreeKey,
  }),
};

/** Items in the flat tree list */
export type TreeItem =
  | { type: "repo"; repoIndex: number }
  | { type: "worktree"; repoIndex: number; worktreeIndex: number }
  | {
      type: "detail";
      repoIndex: number;
      worktreeIndex: number;
      detailKind: DetailKind;
      label: string;
      action?: () => void;
      meta?: { state?: string; paneRef?: string };
    };

export type DetailKind =
  | "notification-header"
  | "notification"
  | "pr"
  | "check"
  | "pane-header"
  | "pane";

/** Pending action for optimistic UI */
export interface PendingAction {
  type: "opening" | "closing" | "starting";
  branch: string;
  project: string;
}

/** GitHub PR info from `gh` CLI */
export interface PRInfo {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
  checks: CheckInfo[];
}

export interface CheckInfo {
  name: string;
  state: string; // SUCCESS, FAILURE, PENDING, IN_PROGRESS, etc.
}

/** Tmux pane info */
export interface PaneInfo {
  index: number;
  command: string;
  window: string;
}

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
