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

  test("enable bytes turn on ?1000 + ?1006; disable reverses ?1006 then ?1000", () => {
    expect(MOUSE_ENABLE).toBe("\x1b[?1000h\x1b[?1006h");
    expect(MOUSE_DISABLE).toBe("\x1b[?1006l\x1b[?1000l");
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
    // Regression guard: Ink tears down on signals via signal-exit, which only
    // re-raises (and runs Ink.unmount) when it is the SOLE listener for a
    // signal. Adding our own SIGINT/SIGTERM/SIGHUP listener breaks that and
    // hangs the process (notably on SIGHUP). useMouse must add ZERO per-signal
    // listeners.
    //
    // Ink itself registers one signal-exit listener per signal while mounted,
    // so the absolute count is non-zero. We isolate our contribution by
    // comparing a useMouse probe against a control probe that renders Ink but
    // does NOT call useMouse: the mounted-state per-signal counts must match.
    delete process.env.WCT_DISABLE_MOUSE;

    // Baseline before any probe mounts.
    const baseline = signals.map((s) => process.listenerCount(s));

    // Control: Ink alone (no useMouse). Capture its mounted-state counts.
    const control = await renderProbe(NullProbe);
    const controlCounts = signals.map((s) => process.listenerCount(s));
    control.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // useMouse probe: mounted-state per-signal counts must EQUAL the control,
    // i.e. useMouse contributes zero per-signal listeners on top of Ink's.
    const probe = await renderMouseProbe();
    signals.forEach((s, i) => {
      expect(process.listenerCount(s)).toBe(controlCounts[i]);
    });

    probe.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No leak: per-signal counts return to the pre-mount baseline.
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
    // No enable on mount means the early-return path ran, so nothing to
    // disable on unmount either.
    expect(probe.output()).not.toContain(MOUSE_DISABLE);
    expect(process.listenerCount("exit")).toBe(exitBefore);
    sigBefore.forEach((count, i) => {
      expect(process.listenerCount(signals[i] as NodeJS.Signals)).toBe(count);
    });
  });
});
