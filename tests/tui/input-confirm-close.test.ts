import type { Key } from "ink";
import { describe, expect, test, vi } from "vitest";
import {
  type ConfirmCloseContext,
  handleConfirmCloseInput,
} from "../../src/tui/input/confirm-close";
import { Mode } from "../../src/tui/types";

const noKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

function confirmCloseMode(changedFiles = 0) {
  return Mode.ConfirmClose(
    "session",
    "feature",
    "/worktrees/feature",
    "project/feature",
    "/repos/project",
    "project",
    changedFiles,
  );
}

function confirmCloseForceMode() {
  return Mode.ConfirmCloseForce(
    "session",
    "feature",
    "/worktrees/feature",
    "project/feature",
    "/repos/project",
    "project",
  );
}

function makeCtx(
  overrides: Partial<ConfirmCloseContext> = {},
): ConfirmCloseContext {
  return {
    mode: confirmCloseMode(),
    returnMode: Mode.Navigate,
    returnSelectedIndex: 3,
    setMode: vi.fn(),
    setSelectedIndex: vi.fn(),
    executeClose: vi.fn(),
    ...overrides,
  };
}

describe("handleConfirmCloseInput", () => {
  test("escape restores selected index and previous mode", () => {
    const returnMode = Mode.Expanded("project/feature");
    const ctx = makeCtx({ returnMode, returnSelectedIndex: 5 });

    handleConfirmCloseInput(ctx, "", { ...noKey, escape: true });

    expect(ctx.setSelectedIndex).toHaveBeenCalledWith(5);
    expect(ctx.setMode).toHaveBeenCalledWith(returnMode);
    expect(ctx.executeClose).not.toHaveBeenCalled();
  });

  test("return from dirty ConfirmClose executes non-force close first", () => {
    const ctx = makeCtx({ mode: confirmCloseMode(2) });

    handleConfirmCloseInput(ctx, "", { ...noKey, return: true });

    expect(ctx.setMode).not.toHaveBeenCalledWith(confirmCloseForceMode());
    expect(ctx.executeClose).toHaveBeenCalledWith(
      "session",
      "feature",
      "/worktrees/feature",
      "project/feature",
      "/repos/project",
      "project",
      false,
    );
  });

  test("return from clean ConfirmClose executes non-force close", () => {
    const ctx = makeCtx({ mode: confirmCloseMode(0) });

    handleConfirmCloseInput(ctx, "", { ...noKey, return: true });

    expect(ctx.executeClose).toHaveBeenCalledWith(
      "session",
      "feature",
      "/worktrees/feature",
      "project/feature",
      "/repos/project",
      "project",
      false,
    );
  });

  test("return from ConfirmCloseForce executes force close", () => {
    const ctx = makeCtx({ mode: confirmCloseForceMode() });

    handleConfirmCloseInput(ctx, "", { ...noKey, return: true });

    expect(ctx.executeClose).toHaveBeenCalledWith(
      "session",
      "feature",
      "/worktrees/feature",
      "project/feature",
      "/repos/project",
      "project",
      true,
    );
  });
});
