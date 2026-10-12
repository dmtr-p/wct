import { PassThrough } from "node:stream";
import React from "react";
import { afterEach, describe, expect, test } from "vitest";
import {
  createMouseController,
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  useMouse,
} from "../../src/tui/hooks/useMouse";

describe("createMouseController", () => {
  test("enable writes the enable bytes exactly once", () => {
    const writes: string[] = [];
    const c = createMouseController({ write: (d) => writes.push(d) });
    c.enable();
    c.enable(); // idempotent — already enabled
    expect(writes).toEqual([MOUSE_ENABLE]);
    expect(c.isEnabled()).toBe(true);
  });

  test("disable writes the disable bytes exactly once and is idempotent", () => {
    const writes: string[] = [];
    const c = createMouseController({ write: (d) => writes.push(d) });
    c.enable();
    writes.length = 0;
    c.disable();
    c.disable(); // idempotent — already disabled
    expect(writes).toEqual([MOUSE_DISABLE]);
    expect(c.isEnabled()).toBe(false);
  });

  test("disable before enable is a no-op", () => {
    const writes: string[] = [];
    const c = createMouseController({ write: (d) => writes.push(d) });
    c.disable();
    expect(writes).toEqual([]);
  });

  test("enable bytes add any-motion + SGR reporting; disable in reverse", () => {
    expect(MOUSE_ENABLE).toBe("\x1b[?1000h\x1b[?1003h\x1b[?1006h");
    expect(MOUSE_DISABLE).toBe("\x1b[?1006l\x1b[?1003l\x1b[?1000l");
  });
});

type TestStdout = NodeJS.WriteStream & { columns: number; rows: number };
type TestStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
  ref: () => NodeJS.ReadStream;
  unref: () => NodeJS.ReadStream;
};

function createStdoutStdin() {
  const stdout = new PassThrough() as unknown as TestStdout;
  stdout.columns = 80;
  stdout.rows = 24;
  const stdin = new PassThrough() as unknown as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return { stdout, stdin };
}

function MouseProbe() {
  useMouse();
  return null;
}

/** A probe that renders Ink but does NOT call useMouse — a control to isolate
 * the per-signal listeners Ink itself registers (via signal-exit) from any our
 * hook might add. */
function NullProbe() {
  return null;
}

async function renderProbe(component: React.FC) {
  const { stdout, stdin } = createStdoutStdin();
  const chunks: string[] = [];
  stdout.on("data", (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
  const { render } = await import("ink");
  const instance = render(React.createElement(component), {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    output: () => chunks.join(""),
    unmount: () => instance.unmount(),
  };
}

function renderMouseProbe() {
  return renderProbe(MouseProbe);
}

describe("useMouse (default-on)", () => {
  const original = process.env.WCT_DISABLE_MOUSE;
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

  afterEach(() => {
    if (original === undefined) {
      delete process.env.WCT_DISABLE_MOUSE;
    } else {
      process.env.WCT_DISABLE_MOUSE = original;
    }
  });

  test("writes enable bytes on mount", async () => {
    delete process.env.WCT_DISABLE_MOUSE;
    const probe = await renderMouseProbe();
    expect(probe.output()).toContain(MOUSE_ENABLE);
    probe.unmount();
  });

  test("writes disable bytes on unmount and removes the exit handler", async () => {
    delete process.env.WCT_DISABLE_MOUSE;
    const exitBefore = process.listenerCount("exit");

    const probe = await renderMouseProbe();
    probe.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(probe.output()).toContain(MOUSE_DISABLE);
    // The "exit" handler registered on mount must be removed on unmount.
    expect(process.listenerCount("exit")).toBe(exitBefore);
  });

  test("registers NO per-signal handlers (preserves Ink's signal-exit invariant)", async () => {
    // Extra signal listeners prevent signal-exit from re-raising and unmounting
    // Ink. Compare against an Ink-only control to exclude Ink's own listeners.
    delete process.env.WCT_DISABLE_MOUSE;

    const baseline = signals.map((s) => process.listenerCount(s));

    const control = await renderProbe(NullProbe);
    const controlCounts = signals.map((s) => process.listenerCount(s));
    control.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const probe = await renderMouseProbe();
    signals.forEach((s, i) => {
      expect(process.listenerCount(s)).toBe(controlCounts[i]);
    });

    probe.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    signals.forEach((s, i) => {
      expect(process.listenerCount(s)).toBe(baseline[i]);
    });
  });

  test("WCT_DISABLE_MOUSE is a complete no-op (no bytes, no handlers)", async () => {
    process.env.WCT_DISABLE_MOUSE = "1";
    const exitBefore = process.listenerCount("exit");
    const sigBefore = signals.map((s) => process.listenerCount(s));

    const probe = await renderMouseProbe();
    expect(probe.output()).not.toContain(MOUSE_ENABLE);
    // The opt-out registers no handlers of its own. (Ink itself may register a
    // signal-exit listener, but it removes it on unmount, so the
    // before-mount → after-unmount counts are the meaningful contract.)
    expect(process.listenerCount("exit")).toBe(exitBefore);

    probe.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(probe.output()).not.toContain(MOUSE_DISABLE);
    expect(process.listenerCount("exit")).toBe(exitBefore);
    sigBefore.forEach((count, i) => {
      expect(process.listenerCount(signals[i] as NodeJS.Signals)).toBe(count);
    });
  });
});
