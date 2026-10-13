import type { EventEmitter } from "node:events";
import { useStdout } from "ink";
import { useEffect, useRef } from "react";

/** Enable click + pointer-motion reporting (?1003) with SGR coords (?1006). */
export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
/** Disable in reverse order so coordinate and motion modes unwind first. */
export const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";

interface MouseWriter {
  write: (data: string) => void;
}

/**
 * Quit, process exit, and unmount can all disable reporting; repeated calls
 * must be harmless.
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
 * Own mouse reporting for the React mount/unmount lifecycle. Quit handlers
 * must call disableMouse before exit(): Ink releases raw mode before React
 * cleanup, allowing mouse bytes to echo during that gap.
 * Any non-empty WCT_DISABLE_MOUSE value disables reporting.
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
      return;
    }

    const controller = controllerRef.current;
    if (!controller) return;
    controller.enable();

    // Separate signal listeners interfere with Ink's signal-exit ownership,
    // preventing unmount and terminal restoration. Use React cleanup for
    // signals and the process exit event for explicit exits; both are idempotent.
    const restore = () => controller.disable();
    const processEvents: EventEmitter = process;
    processEvents.once("exit", restore);

    return () => {
      controller.disable();
      processEvents.removeListener("exit", restore);
    };
  }, []);

  return {
    disableMouse: () => controllerRef.current?.disable(),
  };
}
