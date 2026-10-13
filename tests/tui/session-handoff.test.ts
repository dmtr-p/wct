import { describe, expect, test, vi } from "vitest";
import type { WorkspaceUpResult } from "../../src/services/workspace-service";
import type { TmuxClientDiscovery } from "../../src/tui/hooks/useTmux";
import { createSessionHandoff } from "../../src/tui/session-handoff";

const client = { tty: "/dev/pts/0", session: "other" };
const tmux: WorkspaceUpResult["attempts"]["tmux"] = {
  attempted: true,
  ok: true,
  value: { _tag: "Created", sessionName: "wt-feat" },
};

function makeDeps() {
  return {
    waitForLifecyclePresentationCleanup: vi.fn().mockResolvedValue(undefined),
    discoverClient: vi
      .fn<() => Promise<TmuxClientDiscovery>>()
      .mockResolvedValue({ type: "single", client }),
    switchSession: vi.fn().mockResolvedValue(true),
    refreshSessions: vi.fn().mockResolvedValue([]),
  };
}

describe.each([
  { action: "open", completed: "Opened" },
  { action: "start", completed: "Started" },
] as const)("$action session handoff", (wording) => {
  const options = {
    repoPath: "/repo",
    branch: "feat",
    sessionName: "wt-feat",
    tmux,
    autoSwitch: true,
    wording,
  };

  test("waits for presentation cleanup before discovering and switching the client", async () => {
    const deps = makeDeps();
    let release!: () => void;
    deps.waitForLifecyclePresentationCleanup.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const handedOff = createSessionHandoff(deps)(options);
    expect(deps.waitForLifecyclePresentationCleanup).toHaveBeenCalledWith(
      "/repo",
      "feat",
    );
    expect(deps.discoverClient).not.toHaveBeenCalled();
    expect(deps.switchSession).not.toHaveBeenCalled();
    release();
    await expect(handedOff).resolves.toBeUndefined();
    expect(deps.switchSession).toHaveBeenCalledWith("wt-feat", client);
    expect(deps.refreshSessions).toHaveBeenCalledOnce();
  });

  test.each([
    { autoSwitch: false, tmux },
    {
      autoSwitch: true,
      tmux: { attempted: false, reason: "tmux_not_configured" },
    },
    {
      autoSwitch: true,
      tmux: {
        attempted: true,
        ok: false,
        error: { code: "tmux_error", message: "no server" },
      },
    },
  ] satisfies Array<{
    autoSwitch: boolean;
    tmux: WorkspaceUpResult["attempts"]["tmux"];
  }>)(
    "skips handoff for $tmux when autoSwitch is $autoSwitch",
    async (override) => {
      const deps = makeDeps();
      await expect(
        createSessionHandoff(deps)({ ...options, ...override }),
      ).resolves.toBeUndefined();
      expect(deps.waitForLifecyclePresentationCleanup).not.toHaveBeenCalled();
      expect(deps.discoverClient).not.toHaveBeenCalled();
      expect(deps.switchSession).not.toHaveBeenCalled();
    },
  );

  test.each(["none", "multiple", "error"] as const)(
    "explains %s client discovery",
    async (type) => {
      const deps = makeDeps();
      deps.discoverClient.mockResolvedValue({ type });
      const expected =
        type === "none"
          ? "No tmux client found — start tmux in the other pane"
          : type === "error"
            ? `${wording.completed} session 'wt-feat' but failed to query tmux clients to switch`
            : `Cannot switch tmux client after ${wording.action} because multiple tmux clients are attached`;
      await expect(createSessionHandoff(deps)(options)).resolves.toBe(expected);
      expect(deps.switchSession).not.toHaveBeenCalled();
    },
  );

  test("returns an operation-specific failed switch message", async () => {
    const deps = makeDeps();
    deps.switchSession.mockResolvedValue(false);
    await expect(createSessionHandoff(deps)(options)).resolves.toBe(
      `${wording.completed} session 'wt-feat', but failed to switch client`,
    );
  });

  test("propagates thrown handoff failures to the lifecycle action error handler", async () => {
    const deps = makeDeps();
    deps.switchSession.mockRejectedValue(new Error("switch failed"));
    await expect(createSessionHandoff(deps)(options)).rejects.toThrow(
      "switch failed",
    );
  });
});
