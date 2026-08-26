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
// This module owns the key space, the canonical row labels, the width-aware
// truncation AND the one shared run shape every lifecycle-driving handler uses
// (`beginLifecycle` / `runLifecycleOperation`). Rendering lives in
// `components/LifecycleProgressRow` and row placement in
// `tree-helpers.buildTreeRows`, so both consume ONE label mapping and no raw
// setup command text can ever reach the screen.

import { Effect } from "effect";
import type { Dispatch, SetStateAction } from "react";
import { toWctError } from "../errors";
import type {
  WorkspaceOperation,
  WorkspacePhase,
  WorkspaceReporter,
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

/**
 * The three operations every lifecycle-driving handler needs: advance the
 * phase, drive it from a `WorkspaceReporter`, and tear the presentation down.
 *
 * `setPhase`/`end` are no-ops once the entry is gone, so a late reporter event
 * (or a second teardown from a `finally`) can never resurrect a progress row
 * for a finished operation, and neither can they touch another identity's
 * entry.
 */
export interface LifecycleController {
  setPhase: (phase: LifecyclePhase) => void;
  end: () => void;
  reporter: WorkspaceReporter;
}

/** Begin a lifecycle for ONE Workspace Identity. */
export function beginLifecycle(
  setLifecycle: Dispatch<SetStateAction<LifecycleState>>,
  entry: LifecycleEntry,
): LifecycleController {
  const key = lifecycleKey(entry.repoPath, entry.branch);
  setLifecycle((previous) => new Map(previous).set(key, entry));

  const setPhase = (phase: LifecyclePhase) => {
    setLifecycle((previous) => {
      const current = previous.get(key);
      if (!current) return previous;
      const next = new Map(previous);
      next.set(key, { ...current, phase });
      return next;
    });
  };

  const end = () => {
    setLifecycle((previous) => {
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
      // to fail a lifecycle operation in the first place.
      event: (event) =>
        Effect.sync(() => {
          if (event._tag !== "PhaseStarted") return;
          setPhase(event.phase);
        }),
    },
  };
}

export interface LifecycleRunOptions<T> {
  setLifecycle: Dispatch<SetStateAction<LifecycleState>>;
  /**
   * Resolves the snapshot THIS validation observed, or `null` when the refresh
   * could not observe anything (previous tree kept).
   */
  refreshAll: () => Promise<unknown>;
  showActionError: (message: string) => void;
  /** The Workspace Identity and starting phase of this operation. */
  entry: LifecycleEntry;
  /** The service call. The reporter it is handed drives the progress row. */
  run: (reporter: WorkspaceReporter) => Promise<T>;
  /** Outcome messages a settled result carries; reported after validation. */
  resultWarnings?: (result: T) => readonly string[];
  /**
   * Work that must wait for BOTH validation and lifecycle teardown — the
   * automatic tmux hand-off, which detaches the terminal this TUI is drawn in
   * and whose failure must never resurrect a progress row.
   */
  afterCleanup?: (result: T) => Promise<string | undefined>;
}

/**
 * The ONE shared lifecycle shape: present → run with the reporter → validate →
 * tear down → hand off → report.
 *
 * Every outcome (a fatal failure, a partial result with warnings, a clean run)
 * is COLLECTED and reported only once validation has finished, and validation
 * runs on BOTH the success and the failure branch — a failed operation may
 * still have changed worktree or tmux state, so the tree has to be told the
 * truth about what exists before the error is shown.
 *
 * Expansion is deliberately absent from this flow: forced expansion during a
 * lifecycle is presentation-only (`isWorktreeEffectivelyExpanded`), so the
 * user's stored `expandedWorktreeKeys` preference is restored simply by the
 * entry going away — nothing to save and nothing to write back.
 */
export async function runLifecycleOperation<T>(
  options: LifecycleRunOptions<T>,
): Promise<void> {
  const { entry } = options;
  const operation = entry.operation;
  const lifecycle = beginLifecycle(options.setLifecycle, entry);

  const messages: string[] = [];
  const append = (message: string) => {
    if (message) messages.push(message);
  };

  try {
    let result: T | undefined;
    try {
      result = await options.run(lifecycle.reporter);
    } catch (error) {
      append(toWctError(error).message);
    }

    if (result !== undefined && options.resultWarnings) {
      for (const warning of options.resultWarnings(result)) append(warning);
    }

    // The row says `Validating Workspace…` while registry, worktree and tmux
    // state is re-read, and ONLY once that settles does the presentation come
    // down. The null check lives INSIDE the try so a throwing refresh is
    // reported once, by its own message, rather than twice.
    lifecycle.setPhase({ _tag: "Validating" });
    try {
      if ((await options.refreshAll()) === null) {
        append(lifecycleValidationWarning(operation));
      }
    } catch (error) {
      append(`Refresh failed after ${operation}: ${toWctError(error).message}`);
    }
    lifecycle.end();

    if (result !== undefined && options.afterCleanup) {
      append((await options.afterCleanup(result)) ?? "");
    }

    if (messages.length > 0) options.showActionError(messages.join("\n"));
  } finally {
    lifecycle.end();
  }
}
