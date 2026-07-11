import { describe, expect, test, vi } from "vitest";
import {
  type ConfirmKillContext,
  executeConfirmKill,
} from "../../src/tui/input/confirm-kill";

function makeContext(
  overrides: Partial<ConfirmKillContext> = {},
): ConfirmKillContext {
  return {
    paneId: "%5",
    killPane: vi.fn().mockResolvedValue(true),
    refreshSessions: vi.fn().mockResolvedValue([]),
    isCurrent: vi.fn(() => true),
    onSuccess: vi.fn(),
    showActionError: vi.fn(),
    ...overrides,
  };
}

describe("executeConfirmKill", () => {
  test("calls onSuccess and refreshes sessions after a successful kill", async () => {
    const ctx = makeContext();

    await executeConfirmKill(ctx);

    expect(ctx.killPane).toHaveBeenCalledWith("%5");
    expect(ctx.onSuccess).toHaveBeenCalledOnce();
    expect(ctx.refreshSessions).toHaveBeenCalledOnce();
    expect(ctx.showActionError).not.toHaveBeenCalled();
  });

  test("reports failure without calling onSuccess or refreshing sessions", async () => {
    const ctx = makeContext({
      killPane: vi.fn().mockResolvedValue(false),
    });

    await executeConfirmKill(ctx);

    expect(ctx.showActionError).toHaveBeenCalledWith("Failed to kill pane");
    expect(ctx.onSuccess).not.toHaveBeenCalled();
    expect(ctx.refreshSessions).not.toHaveBeenCalled();
  });

  test("ignores a stale completion after the confirmation is cancelled", async () => {
    const ctx = makeContext({
      isCurrent: vi.fn(() => false),
    });

    await executeConfirmKill(ctx);

    expect(ctx.onSuccess).not.toHaveBeenCalled();
    expect(ctx.showActionError).not.toHaveBeenCalled();
    expect(ctx.refreshSessions).not.toHaveBeenCalled();
  });
});
