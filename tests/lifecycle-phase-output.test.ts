// Runs each command twice against a stubbed WorkspaceService, with and
// without PhaseStarted events interleaved, and diffs the transcripts.

import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";
import { closeCommand } from "../src/commands/close";
import { downCommand } from "../src/commands/down";
import { openCommand } from "../src/commands/open";
import { upCommand } from "../src/commands/up";
import { runBunPromise } from "../src/effect/runtime";
import type {
  WorkspaceCloseResult,
  WorkspaceDownResult,
  WorkspaceOpenResult,
  WorkspacePhase,
  WorkspaceReporter,
  WorkspaceReporterEvent,
  WorkspaceService as WorkspaceServiceApi,
  WorkspaceUpResult,
} from "../src/services/workspace-service";
import {
  liveWorktreeService,
  type WorktreeService,
} from "../src/services/worktree-service";
import { withTestServices } from "./helpers/services";

// `closeCommand` resolves its branch through the real WorktreeService; stub just that lookup.
const worktree: WorktreeService = {
  ...liveWorktreeService,
  findWorktreeByBranch: (branch) =>
    Effect.succeed({
      path: "/tmp/myapp-feature",
      branch,
      commit: "abc123",
      isBare: false,
    }),
};

const openResult: WorkspaceOpenResult = {
  operation: "open",
  worktreePath: "/tmp/myapp-feature",
  mainRepoPath: "/repos/myapp",
  branch: "feature",
  sessionName: "myapp-feature",
  projectName: "myapp",
  created: true,
  env: {
    WCT_WORKTREE_DIR: "/tmp/myapp-feature",
    WCT_WORK_DIR: "/tmp/myapp-feature",
    WCT_MAIN_DIR: "/repos/myapp",
    WCT_BRANCH: "feature",
    WCT_PROJECT: "myapp",
  },
  warnings: [],
  attempts: {
    worktree: {
      attempted: true,
      ok: true,
      value: { _tag: "Created", path: "/tmp/myapp-feature" },
    },
    copy: { attempted: true, ok: true, value: [] },
    setup: {
      attempted: true,
      ok: true,
      value: [{ _tag: "Succeeded", name: "install" }],
    },
    tmux: { attempted: false, reason: "tmux_not_configured" },
  },
};

const upResult: WorkspaceUpResult = {
  operation: "up",
  worktreePath: "/tmp/myapp-feature",
  mainRepoPath: "/repos/myapp",
  branch: "feature",
  sessionName: "myapp-feature",
  projectName: "myapp",
  env: openResult.env,
  warnings: [],
  attempts: { tmux: { attempted: false, reason: "tmux_not_configured" } },
};

const downResult: WorkspaceDownResult = {
  operation: "down",
  worktreePath: "/tmp/myapp-feature",
  sessionName: "myapp-feature",
  existed: true,
  status: "killed",
  attempts: { kill: { attempted: true, ok: true, value: null } },
  warnings: [],
};

const closeResult: WorkspaceCloseResult = {
  operation: "close",
  worktreePath: "/tmp/myapp-feature",
  sessionName: "myapp-feature",
  existed: false,
  status: "removed",
  attempts: {
    kill: { attempted: false, reason: "session_absent" },
    remove: {
      attempted: true,
      ok: true,
      value: { _tag: "Removed", path: "/tmp/myapp-feature" },
    },
  },
  warnings: [],
};

const LEGACY_OPEN_EVENTS: WorkspaceReporterEvent[] = [
  {
    operation: "open",
    _tag: "TargetResolved",
    worktreePath: "/tmp/myapp-feature",
    branch: "feature",
    base: "main",
  },
  { operation: "open", _tag: "ProfileResolved", profileName: "dev" },
  { operation: "open", _tag: "AttemptStarted", attempt: "worktree" },
  {
    operation: "open",
    _tag: "AttemptCompleted",
    attempt: "worktree",
    ok: true,
  },
  { operation: "open", _tag: "AttemptStarted", attempt: "copy" },
  { operation: "open", _tag: "AttemptCompleted", attempt: "copy", ok: true },
  { operation: "open", _tag: "AttemptStarted", attempt: "setup" },
  { operation: "open", _tag: "AttemptCompleted", attempt: "setup", ok: true },
];

const ALL_PHASES: WorkspacePhase[] = [
  { _tag: "Preparing" },
  { _tag: "CreatingWorktree" },
  { _tag: "CopyingFiles" },
  { _tag: "RunningSetup", name: "install" },
  { _tag: "CreatingTmuxSession" },
  { _tag: "KillingTmuxSession" },
  { _tag: "RemovingWorktree" },
];

// Interleaves a phase event before each legacy event, so a listener reacting
// to phase order anywhere in the stream would be caught.
function eventsWithPhases(): WorkspaceReporterEvent[] {
  const phaseEvents: WorkspaceReporterEvent[] = ALL_PHASES.map((phase) => ({
    operation: "open" as const,
    _tag: "PhaseStarted" as const,
    phase,
  }));
  const woven: WorkspaceReporterEvent[] = [];
  const phases = [...phaseEvents];
  for (const event of LEGACY_OPEN_EVENTS) {
    const phaseEvent = phases.shift();
    if (phaseEvent) woven.push(phaseEvent);
    woven.push(event);
  }
  woven.push(...phases);
  return woven;
}

function emitAll(
  reporter: WorkspaceReporter | undefined,
  events: WorkspaceReporterEvent[],
) {
  return Effect.gen(function* () {
    if (!reporter) return;
    for (const event of events) {
      yield* Effect.catch(reporter.event(event), () => Effect.void);
    }
  });
}

function stubWorkspace(
  events: WorkspaceReporterEvent[],
  seenOptions: Array<Record<string, unknown>>,
): WorkspaceServiceApi {
  return {
    open: (options) =>
      Effect.gen(function* () {
        seenOptions.push(options as Record<string, unknown>);
        yield* emitAll(options.reporter, events);
        return openResult;
      }),
    up: (options) =>
      Effect.gen(function* () {
        seenOptions.push((options ?? {}) as Record<string, unknown>);
        yield* emitAll(options?.reporter, events);
        return upResult;
      }),
    down: (options) =>
      Effect.gen(function* () {
        seenOptions.push((options ?? {}) as Record<string, unknown>);
        yield* emitAll(options?.reporter, events);
        return downResult;
      }),
    close: (options) =>
      Effect.gen(function* () {
        seenOptions.push((options ?? {}) as Record<string, unknown>);
        yield* emitAll(options?.reporter, events);
        return closeResult;
      }),
  };
}

async function transcript(
  events: WorkspaceReporterEvent[],
  json: boolean,
  seenOptions: Array<Record<string, unknown>>,
): Promise<string[]> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const workspace = stubWorkspace(events, seenOptions);
    await runBunPromise(
      withTestServices(openCommand({ branch: "feature", noAttach: true }), {
        workspace,
        worktree,
        json,
      }),
    );
    await runBunPromise(
      withTestServices(upCommand({ path: "/tmp/myapp-feature" }), {
        workspace,
        worktree,
        json,
      }),
    );
    await runBunPromise(
      withTestServices(downCommand({ path: "/tmp/myapp-feature" }), {
        workspace,
        worktree,
        json,
      }),
    );
    await runBunPromise(
      withTestServices(
        closeCommand({ branches: ["feature"], yes: true, force: false }),
        { workspace, worktree, json },
      ),
    );
    return [
      ...logSpy.mock.calls.map((args) => args.map(String).join(" ")),
      ...errorSpy.mock.calls.map((args) => args.map(String).join(" ")),
    ];
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

describe("semantic phases and CLI output", () => {
  test("human output and --json envelopes are byte-identical with and without phase events", async () => {
    const withoutPhasesOptions: Array<Record<string, unknown>> = [];
    const withPhasesOptions: Array<Record<string, unknown>> = [];

    const humanWithout = await transcript(
      LEGACY_OPEN_EVENTS,
      false,
      withoutPhasesOptions,
    );
    const humanWith = await transcript(
      eventsWithPhases(),
      false,
      withPhasesOptions,
    );

    expect(humanWith).toEqual(humanWithout);
    expect(humanWithout.length).toBeGreaterThan(0);
    for (const line of humanWith) {
      expect(line).not.toContain("Preparing Workspace");
      expect(line).not.toContain("Validating Workspace");
      expect(line).not.toContain("Setup: install…");
    }

    const jsonWithout = await transcript(LEGACY_OPEN_EVENTS, true, []);
    const jsonWith = await transcript(eventsWithPhases(), true, []);
    expect(jsonWith).toEqual(jsonWithout);
    for (const line of jsonWith) {
      expect(line).not.toContain("PhaseStarted");
    }

    // `up`, `down`, and `close` never pass a reporter.
    const nonOpen = withPhasesOptions.slice(1);
    expect(nonOpen.length).toBeGreaterThan(0);
    for (const options of nonOpen) {
      expect(options.reporter).toBeUndefined();
    }
  });
});
