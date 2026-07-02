import { useStdout } from "ink";
import { useEffect, useRef } from "react";

/** Enable SGR mouse reporting: button press/release (?1000) + SGR coords (?1006). */
export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
/** Disable in REVERSE order (?1006 then ?1000) so ?1006 unwinds first. */
export const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";

interface MouseWriter {
  write: (data: string) => void;
}

/**
 * Stateful, idempotent enable/disable of mouse reporting on a single stdout
 * stream. The `enabled` flag makes `disable()` safe to call repeatedly (React
 * unmount, the `q` path, and any signal handler can all fire it harmlessly).
 */
export function createMouseController(stdout: MouseWriter) {
  let enabled = false;
  return {
    isEnabled: () => enabled,
    enable() {
      if (enabled) return;
      enabled = true;
      stdout.write(MOUSE_ENABLE);
    },
    disable() {
      if (!enabled) return;
      enabled = false;
      stdout.write(MOUSE_DISABLE);
    },
  };
}

export type MouseController = ReturnType<typeof createMouseController>;

/**
 * Enable mouse reporting for the lifetime of the TUI and guarantee the terminal
 * is restored on every exit path. Mirrors `useRefresh`: a plain React hook over
 * Node/Ink primitives, no Effect service. This is a DELIBERATE, lifecycle-only
 * exception to the repo's effect-first guideline — enabling/disabling mouse
 * reporting is pure terminal-lifecycle plumbing tied to React mount/unmount
 * and Ink's exit sequencing, with no business logic to lift into Effect.
 *
 * Returns `disableMouse()` — call it on the `q` quit path *before* `exit()`,
 * because Ink's `handleExit` turns off raw mode before React unmount runs, so
 * the unmount-cleanup disable would be too late to avoid echoed bytes.
 *
 * `WCT_DISABLE_MOUSE` (any non-empty value) makes the hook a complete no-op.
 */
export function useMouse(): { disableMouse: () => void } {
  const { stdout } = useStdout();
  const controllerRef = useRef<MouseController | null>(null);

  if (controllerRef.current === null) {
    const writer: MouseWriter = {
      write: (data) => {
        const target = stdout ?? process.stdout;
        target.write(data);
      },
    };
    controllerRef.current = createMouseController(writer);
  }

  useEffect(() => {
    if (process.env.WCT_DISABLE_MOUSE) {
      // Complete no-op: never enable, never register handlers.
      return;
    }

    const controller = controllerRef.current;
    if (!controller) return;
    controller.enable();

    // Synchronous restore for explicit-exit paths. Idempotent via the `enabled`
    // guard, so firing more than once (e.g. exit after the `q` disable) is
    // harmless.
    //
    // We deliberately do NOT register per-signal handlers
    // (process.on("SIGINT"/"SIGTERM"/"SIGHUP", …)). Ink tears down on signals
    // via signal-exit (ink.js:255 `signalExit(this.unmount)`), which only
    // re-raises the signal — and thus runs Ink's unmount — when it is the SOLE
    // owner of that signal: `process.listeners(sig).length === emitter.count`.
    // Adding our own listener breaks that invariant, so signal-exit bails: Ink
    // never unmounts (alt-screen/cursor/raw-mode left broken) and the signal is
    // never re-raised, hanging the process (notably on SIGHUP, which nothing
    // else owns). Instead we rely on the existing path — signal-exit →
    // Ink.unmount → React unmount → this effect's cleanup disable() — to write
    // the disable bytes while Ink restores the terminal. The "exit" event is
    // NOT signal-counted by signal-exit, so process.once("exit") is safe.
    const restore = () => controller.disable();
    process.once("exit", restore);

    return () => {
      controller.disable();
      process.removeListener("exit", restore);
    };
  }, []);

  return {
    disableMouse: () => controllerRef.current?.disable(),
  };
}
