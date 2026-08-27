// A lifecycle entry is keyed by Workspace Identity — main repository path +
// branch — not the project display name used for expansion keys
// (`pendingKey`, `Mode.Expanded`, `treeItemId`). Two registered repos can
// share a display name, so a display-name key would let one repo's `open`
// blank out another repo's progress row.

import { Effect } from "effect";
import type { Dispatch, SetStateAction } from "react";
import { toWctError } from "../errors";
import type {
  WorkspaceOperation,
  WorkspacePhase,
  WorkspaceReporter,
} from "../services/workspace-service";
import type { RepoInfo } from "./hooks/useRegistry";
import { truncateBranch } from "./utils/truncate";

/**
 * A service phase plus the TUI-owned `Validating` phase, which has no service
 * event behind it — the TUI enters it once the lifecycle effect settles.
 */
export type LifecyclePhase = WorkspacePhase | { _tag: "Validating" };

export interface LifecycleEntry {
  operation: WorkspaceOperation;
  /** Half of the Workspace Identity. */
  repoPath: string;
  /** Display name only — not part of the Workspace Identity. */
  project: string;
  /** The other half of the Workspace Identity. */
  branch: string;
  phase: LifecyclePhase;
}

/** Active lifecycle operations, keyed by `lifecycleKey`. */
export type LifecycleState = ReadonlyMap<string, LifecycleEntry>;

// NUL cannot appear in a filesystem path or a git ref, unlike `#` or `/`, so
// the two halves of the identity can never be confused with each other.
const KEY_SEPARATOR = "\u0000";

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

/**
 * Synchronous claim ledger for Workspace Identities. A `setLifecycle` updater
 * doesn't apply until next render, so two starts dispatched in the same tick
 * would both read the identity as free; this ledger is mutated the instant a
 * claim is taken, so the second start is refused before either can overwrite
 * the other's state.
 */
export interface LifecycleClaims {
  claim: (entry: LifecycleEntry) => boolean;
  record: (entry: LifecycleEntry) => void;
  /**
   * Release the identity, but only when `entry` is the exact object the claim
   * was taken with — so a finished operation's trailing teardown can never
   * unlock a successor that claimed the same identity in the meantime.
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
      const key = lifecycleKey(entry.repoPath, entry.branch);
      if (held.has(key)) return false;
      held.set(key, { owner: entry, current: entry });
      return true;
    },
    record: (entry) => {
      const key = lifecycleKey(entry.repoPath, entry.branch);
      const holder = held.get(key);
      if (!holder) return;
      held.set(key, { owner: holder.owner, current: entry });
    },
    release: (entry) => {
      const key = lifecycleKey(entry.repoPath, entry.branch);
      if (held.get(key)?.owner !== entry) return;
      held.delete(key);
    },
    active: (mainRepoPath, branch) =>
      held.get(lifecycleKey(mainRepoPath, branch))?.current,
  };
}

export function isLifecycleActive(
  lifecycle: LifecycleState,
  mainRepoPath: string,
  branch: string,
): boolean {
  return lifecycle.has(lifecycleKey(mainRepoPath, branch));
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

/** A failed validation is not treated as a failed operation — the previous tree stays on screen. */
export function lifecycleValidationWarning(
  operation: WorkspaceOperation,
): string {
  return `Validation after ${operation} failed — showing the last known Workspace state`;
}

/** Static child connector: the progress row hangs under its Workspace. */
export const LIFECYCLE_ROW_PREFIX = "     └ ";

/**
 * Single-line content for a Lifecycle Progress Row. Tree rows are budgeted as
 * exactly one terminal row, so a long label is truncated rather than
 * soft-wrapped — a wrapped row would desync windowing and mouse hit-testing
 * for every row below it.
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
 * Advance the phase, drive it from a `WorkspaceReporter`, and tear the
 * presentation down. Every method is a no-op once this operation has ended,
 * so a late reporter event can't resurrect this row or touch a successor's
 * entry for the same identity.
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
 * Begin a lifecycle for one Workspace Identity, or refuse it if already
 * claimed, reporting the refusal and leaving the owning operation untouched.
 * Returns `null` rather than an inert controller, so a refused caller can't
 * go on to run the service and tear down the operation that owns the
 * identity.
 */
export function beginLifecycle(
  options: BeginLifecycleOptions,
): LifecycleController | null {
  const { claims, setLifecycle, entry } = options;
  const key = lifecycleKey(entry.repoPath, entry.branch);

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

  // Teardown latch: every flow tears down twice (inline, then in `finally`),
  // with awaits in between during which a new operation may claim the freed
  // identity, so once this fires, later calls must no-op rather than touch a
  // successor's entry.
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
      // Effect.sync — a progress reporter must never be able to fail the
      // lifecycle operation it's reporting on.
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
   * Snapshot this validation observed, or `null` when the refresh couldn't
   * observe anything (previous tree kept) — the run then warns instead of
   * silently trusting stale state.
   */
  refreshAll: () => Promise<readonly RepoInfo[] | null>;
  showActionError: (message: string) => void;
  entry: LifecycleEntry;
  run: (reporter: WorkspaceReporter) => Promise<T>;
  resultWarnings?: (result: T) => readonly string[];
  /**
   * Reconciliation using the observed snapshot, run before the presentation
   * comes down; never called on the `null` (warned) arm. `open` uses it to
   * mark a Workspace found on disk as discovered.
   */
  onValidated?: (snapshot: readonly RepoInfo[]) => void;
  /**
   * Work that must wait for both validation and teardown — e.g. the tmux
   * hand-off that detaches this TUI's terminal. Its failure must never
   * resurrect a progress row.
   */
  afterCleanup?: (result: T) => Promise<string | undefined>;
}

/**
 * Shared lifecycle shape: present → run with the reporter → validate → tear
 * down → hand off → report. Validation runs on both the success and failure
 * branch, since a failed operation may still have changed worktree or tmux
 * state that the tree needs to reflect before the error is shown.
 *
 * Expansion is intentionally not handled here: a lifecycle's forced
 * expansion is presentation-only, so removing the entry restores the user's
 * stored preference with nothing to reconcile.
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
  // Refused: another operation owns this identity and the refusal is already
  // reported. Returning here avoids racing that operation and having the
  // `finally` below tear down its presentation.
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

    // The null check stays inside the try, so a throwing refresh is reported
    // once by its own message rather than twice.
    lifecycle.setPhase({ _tag: "Validating" });
    try {
      const snapshot = await options.refreshAll();
      if (snapshot === null) {
        append(lifecycleValidationWarning(operation));
      } else {
        // Runs before `end`, in the same React commit, using the snapshot
        // this closure observed — a shared ref could be overwritten by a
        // concurrently finishing operation while this one awaited.
        options.onValidated?.(snapshot);
      }
    } catch (error) {
      append(`Refresh failed after ${operation}: ${toWctError(error).message}`);
    }
    lifecycle.end();

    if (result !== undefined && options.afterCleanup) {
      // Nothing awaits this function's returned promise, so a throw here must
      // be caught and reported — otherwise it surfaces as a silent unhandled
      // rejection, dropping the messages collected above.
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
