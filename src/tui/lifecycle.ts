// src/tui/lifecycle.ts
//
// The TUI's Workspace-lifecycle presentation model.
//
// A lifecycle entry is keyed by **Workspace Identity** — the main repository
// path plus the branch — NOT by the project display name used for expansion
// keys (`pendingKey`), `Mode.Expanded` and `treeItemId`. Two registered repos
// can share a display name, so a display-name key would let one repo's `open`
// blank out another repo's progress row; the identity key keeps same-named
// branches in different repositories independent (AC-27).
//
// Everything here is pure: the key space, the canonical row labels and the
// width-aware truncation. Rendering lives in `components/LifecycleProgressRow`
// and row placement in `tree-helpers.buildTreeRows`, so both consume ONE label
// mapping and no raw setup command text can ever reach the screen.

import type {
  WorkspaceOperation,
  WorkspacePhase,
} from "../services/workspace-service";
import { truncateBranch } from "./utils/truncate";

/**
 * A service phase (`WorkspacePhase`) plus the TUI-owned reconciliation phase.
 * `Validating` has no service event behind it: the TUI enters it once the
 * lifecycle effect settles and stays there while it refreshes registry,
 * worktree and tmux state.
 */
export type LifecyclePhase = WorkspacePhase | { _tag: "Validating" };

export interface LifecycleEntry {
  operation: WorkspaceOperation;
  /** Main repository path — one half of the Workspace Identity. */
  repoPath: string;
  /** Project display name; used only for row placement and messages. */
  project: string;
  /** Branch — the other half of the Workspace Identity. */
  branch: string;
  phase: LifecyclePhase;
}

/** Active lifecycle operations, keyed by `lifecycleKey`. */
export type LifecycleState = ReadonlyMap<string, LifecycleEntry>;

// NUL cannot appear in a filesystem path or a git ref, so the two halves of
// the identity can never be confused with each other (a `#` or `/` separator
// could be, since both are legal in paths and in branch names).
const KEY_SEPARATOR = "\u0000";

/** The Workspace Identity key: main repository path + branch. */
export function lifecycleKey(mainRepoPath: string, branch: string): string {
  return `${mainRepoPath}${KEY_SEPARATOR}${branch}`;
}

export function lifecycleEntryFor(
  lifecycle: LifecycleState,
  mainRepoPath: string,
  branch: string,
): LifecycleEntry | undefined {
  return lifecycle.get(lifecycleKey(mainRepoPath, branch));
}

/** True while a lifecycle operation owns this Workspace Identity. */
export function isLifecycleActive(
  lifecycle: LifecycleState,
  mainRepoPath: string,
  branch: string,
): boolean {
  return lifecycle.has(lifecycleKey(mainRepoPath, branch));
}

/** The message shown when an action targets a Workspace under a lifecycle. */
export function lifecycleBusyMessage(
  branch: string,
  phase?: LifecyclePhase,
): string {
  const suffix = phase ? ` (${lifecyclePhaseLabel(phase)})` : "";
  return `'${branch}' is busy${suffix}`;
}

/**
 * The ONE canonical label mapping. Every phase renders exactly one row, so
 * adding a phase means adding a label here — never at a call site.
 */
export function lifecyclePhaseLabel(phase: LifecyclePhase): string {
  switch (phase._tag) {
    case "Preparing":
      return "Preparing Workspace…";
    case "CreatingWorktree":
      return "Creating worktree…";
    case "CopyingFiles":
      return "Copying files…";
    case "RunningSetup":
      return `Setup: ${phase.name}…`;
    case "CreatingTmuxSession":
      return "Creating tmux session…";
    case "KillingTmuxSession":
      return "Killing tmux session…";
    case "RemovingWorktree":
      return "Removing worktree…";
    case "Validating":
      return "Validating Workspace…";
  }
}

/**
 * The warning shown when a lifecycle's OWN validation refresh failed (its
 * `refreshAll` resolved no snapshot). A failed validation is not a failed
 * operation: the previous tree stays on screen, the lifecycle presentation
 * still comes down, and the user is told through the ordinary timed
 * action-error display that what they are looking at may be stale.
 */
export function lifecycleValidationWarning(
  operation: WorkspaceOperation,
): string {
  return `Validation after ${operation} failed — showing the last known Workspace state`;
}

/** Static child connector: the progress row hangs under its Workspace. */
export const LIFECYCLE_ROW_PREFIX = "     └ ";

/**
 * The exact single-line content of a Lifecycle Progress Row. Tree rows are
 * budgeted as EXACTLY one terminal row by `buildTreeRows`, so a long
 * `Setup: <name>…` label must be truncated rather than soft-wrapped — a
 * wrapped row would desync windowing and mouse hit-testing for every row
 * below it.
 */
export function lifecycleProgressContent(
  phase: LifecyclePhase,
  maxWidth: number,
): string {
  const label = lifecyclePhaseLabel(phase);
  const available = maxWidth - LIFECYCLE_ROW_PREFIX.length;
  if (available <= 0) return "";
  return `${LIFECYCLE_ROW_PREFIX}${truncateBranch(label, available)}`;
}
