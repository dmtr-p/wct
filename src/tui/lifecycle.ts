// Project display names can collide; lifecycle ownership uses main repo path
// and branch so one repository's operation cannot overwrite another's progress.

import { Effect } from "effect";
import type { Dispatch, SetStateAction } from "react";
import { toWctError } from "../errors";
import type {
  WorkspaceOperation,
  WorkspacePhase,
  WorkspaceReporter,
} from "../services/workspace-service";
import type { RepoInfo } from "./hooks/useRegistry";
import { toSingleLine, truncateBranch } from "./utils/truncate";

/**
 * A service phase plus the TUI-owned `Validating` phase, which has no service
 * event behind it — the TUI enters it once the lifecycle effect settles.
 */
export type LifecyclePhase = WorkspacePhase | { _tag: "Validating" };

export interface LifecycleEntry {
  operation: WorkspaceOperation;
  repoPath: string;
  /** Display name only — not part of the Workspace Identity. */
  project: string;
  branch: string;
  phase: LifecyclePhase;
}

/** Active lifecycle operations, keyed by `workspaceIdentityKey`. */
export type LifecycleState = ReadonlyMap<string, LifecycleEntry>;

// NUL cannot appear in a filesystem path or a git ref, unlike `#` or `/`, so
// the two halves of the identity can never be confused with each other.
const KEY_SEPARATOR = "\u0000";

/** Shared Workspace Identity Key for lifecycle, PR, and expansion state. */
export function workspaceIdentityKey(
  mainRepoPath: string,
  branch: string,
): string {
  return `${mainRepoPath}${KEY_SEPARATOR}${branch}`;
}

export function lifecycleEntryFor(
  lifecycle: LifecycleState,
  mainRepoPath: string,
  branch: string,
): LifecycleEntry | undefined {
  return lifecycle.get(workspaceIdentityKey(mainRepoPath, branch));
}

/**
 * Claim synchronously: React state updates apply on a later render, allowing
 * two starts in the same tick to observe the same Workspace as available.
 */
export interface LifecycleClaims {
  claim: (entry: LifecycleEntry) => boolean;
  record: (entry: LifecycleEntry) => void;
  /**
   * Require the original entry object so late teardown cannot unlock a successor.
   */
  release: (entry: LifecycleEntry) => void;
  active: (mainRepoPath: string, branch: string) => LifecycleEntry | undefined;
}

export function createLifecycleClaims(): LifecycleClaims {
  // `owner` is the object identity the claim was taken with, so `release` can
  // scope to the operation that actually claimed it; `current` tracks phase
  // updates independently.
  const held = new Map<
    string,
    { owner: LifecycleEntry; current: LifecycleEntry }
  >();
  return {
    claim: (entry) => {
      const key = workspaceIdentityKey(entry.repoPath, entry.branch);
      if (held.has(key)) return false;
      held.set(key, { owner: entry, current: entry });
      return true;
    },
    record: (entry) => {
      const key = workspaceIdentityKey(entry.repoPath, entry.branch);
      const holder = held.get(key);
      if (!holder) return;
      held.set(key, { owner: holder.owner, current: entry });
    },
    release: (entry) => {
      const key = workspaceIdentityKey(entry.repoPath, entry.branch);
      if (held.get(key)?.owner !== entry) return;
      held.delete(key);
    },
    active: (mainRepoPath, branch) =>
      held.get(workspaceIdentityKey(mainRepoPath, branch))?.current,
  };
}

export function isLifecycleActive(
  lifecycle: LifecycleState,
  mainRepoPath: string,
  branch: string,
): boolean {
  return lifecycle.has(workspaceIdentityKey(mainRepoPath, branch));
}

export function lifecycleBusyMessage(
  branch: string,
  phase?: LifecyclePhase,
): string {
  const suffix = phase ? ` (${lifecyclePhaseLabel(phase)})` : "";
  return `'${branch}' is busy${suffix}`;
}

export interface RejectIfLifecycleActiveOptions {
  lifecycle: LifecycleState;
  mainRepoPath: string;
  branch: string;
  showActionError: (message: string) => void;
}

/**
 * Shared action guard: a Workspace under an active lifecycle stays selectable
 * and arrow-key reachable, but its actions are refused. Returns true when the
 * caller must stop.
 */
export function rejectIfLifecycleActive({
  lifecycle,
  mainRepoPath,
  branch,
  showActionError,
}: RejectIfLifecycleActiveOptions): boolean {
  const entry = lifecycleEntryFor(lifecycle, mainRepoPath, branch);
  if (!entry) return false;
  showActionError(lifecycleBusyMessage(branch, entry.phase));
  return true;
}

/** Canonical label mapping — add new phases here, not at call sites. */
export function lifecyclePhaseLabel(phase: LifecyclePhase): string {
  switch (phase._tag) {
    case "Preparing":
      return "Preparing Workspace…";
    case "CreatingWorktree":
      return "Creating worktree…";
    case "CopyingFiles":
      return "Copying files…";
    case "RunningDown":
      return `Down: ${toSingleLine(phase.name)}…`;
    case "RunningSetup":
      return `Setup: ${toSingleLine(phase.name)}…`;
    case "StartingTmuxSession":
      return "Starting tmux session…";
    case "StoppingTmuxSession":
      return "Stopping tmux session…";
    case "RemovingWorktree":
      return "Removing worktree…";
    case "Validating":
      return "Validating Workspace…";
  }
}

/** A failed validation is not treated as a failed operation — the previous tree stays on screen. */
export function lifecycleValidationWarning(
  operation: WorkspaceOperation,
): string {
  return `Validation after ${operation} failed — showing the last known Workspace state`;
}

/** Static child connector: the progress row hangs under its Workspace. */
export const LIFECYCLE_ROW_PREFIX = "     └ ";

/**
 * Keep progress to one terminal row so windowing and mouse hit-testing agree.
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
 * Ignore updates after teardown so late events cannot resurrect progress or
 * modify a successor's entry for the same Workspace.
 */
export interface LifecycleController {
  setPhase: (phase: LifecyclePhase) => void;
  end: () => void;
  reporter: WorkspaceReporter;
}

export interface BeginLifecycleOptions {
  claims: LifecycleClaims;
  setLifecycle: Dispatch<SetStateAction<LifecycleState>>;
  entry: LifecycleEntry;
  showActionError: (message: string) => void;
}

/**
 * Return null on a refused claim; callers must stop before running the service
 * or tearing down the operation that already owns this Workspace.
 */
export function beginLifecycle(
  options: BeginLifecycleOptions,
): LifecycleController | null {
  const { claims, setLifecycle, entry } = options;
  const key = workspaceIdentityKey(entry.repoPath, entry.branch);

  if (!claims.claim(entry)) {
    options.showActionError(
      lifecycleBusyMessage(
        entry.branch,
        claims.active(entry.repoPath, entry.branch)?.phase,
      ),
    );
    return null;
  }

  setLifecycle((previous) => {
    // The ledger already refused a double claim, so an existing entry here
    // means the two have drifted — keep it rather than overwrite.
    if (previous.has(key)) return previous;
    return new Map(previous).set(key, entry);
  });

  // Inline cleanup and finally can straddle a successor's claim. Latch teardown
  // so the second call cannot remove that successor's entry.
  let ended = false;

  const setPhase = (phase: LifecyclePhase) => {
    if (ended) return;
    // The ledger is the synchronous source of truth for ownership, so a late
    // reporter event after teardown is a no-op here.
    const current = claims.active(entry.repoPath, entry.branch);
    if (!current) return;
    claims.record({ ...current, phase });
    setLifecycle((previous) => {
      const held = previous.get(key);
      if (!held) return previous;
      const next = new Map(previous);
      next.set(key, { ...held, phase });
      return next;
    });
  };

  const end = () => {
    if (ended) return;
    ended = true;
    claims.release(entry);
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
      // Reporting adds no typed failures to the lifecycle operation.
      event: (event) =>
        Effect.sync(() => {
          if (event._tag !== "PhaseStarted") return;
          setPhase(event.phase);
        }),
    },
  };
}

interface LifecycleMessage {
  severity: "error" | "warning";
  text: string;
}

export interface LifecycleRunOptions<T> {
  claims: LifecycleClaims;
  setLifecycle: Dispatch<SetStateAction<LifecycleState>>;
  /**
   * Return the observed snapshot, or null to keep the previous tree and warn.
   */
  refreshAll: () => Promise<readonly RepoInfo[] | null>;
  showActionError: (message: string) => void;
  entry: LifecycleEntry;
  run: (reporter: WorkspaceReporter) => Promise<T>;
  resultWarnings?: (result: T) => readonly string[];
  /**
   * Reconcile the observed snapshot before teardown; skip failed validation.
   */
  onValidated?: (snapshot: readonly RepoInfo[]) => void;
  /**
   * Run follow-up actions after validation and teardown; report failures
   * without restoring progress.
   */
  afterCleanup?: (result: T) => Promise<string | undefined>;
}

/**
 * Validate both outcomes: failed operations may still change Git or tmux state.
 * Teardown precedes terminal handoffs and restores the user's expansion
 * preference by removing the temporary lifecycle entry.
 */
export async function runLifecycleOperation<T>(
  options: LifecycleRunOptions<T>,
): Promise<void> {
  const { entry } = options;
  const operation = entry.operation;
  const lifecycle = beginLifecycle({
    claims: options.claims,
    setLifecycle: options.setLifecycle,
    entry,
    showActionError: options.showActionError,
  });
  if (!lifecycle) return;

  const messages: LifecycleMessage[] = [];
  const appendError = (message: string) => {
    if (message) messages.push({ severity: "error", text: message });
  };
  const append = (message: string) => {
    if (message) messages.push({ severity: "warning", text: message });
  };

  try {
    let result: T | undefined;
    try {
      result = await options.run(lifecycle.reporter);
    } catch (error) {
      appendError(toWctError(error).message);
    }

    if (result !== undefined && options.resultWarnings) {
      for (const warning of options.resultWarnings(result)) append(warning);
    }

    lifecycle.setPhase({ _tag: "Validating" });
    try {
      const snapshot = await options.refreshAll();
      if (snapshot === null) {
        append(lifecycleValidationWarning(operation));
      } else {
        // Use this operation's snapshot; a shared ref could be overwritten by
        // another operation while this one awaits validation.
        options.onValidated?.(snapshot);
      }
    } catch (error) {
      append(`Refresh failed after ${operation}: ${toWctError(error).message}`);
    }
    lifecycle.end();

    if (result !== undefined && options.afterCleanup) {
      // A handoff failure must not discard messages collected during the operation.
      try {
        append((await options.afterCleanup(result)) ?? "");
      } catch (error) {
        append(toWctError(error).message);
      }
    }

    if (messages.length > 0) {
      options.showActionError(messages.map((entry) => entry.text).join("\n"));
    }
  } finally {
    lifecycle.end();
  }
}
