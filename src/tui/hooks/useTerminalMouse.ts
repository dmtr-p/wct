import { useStdout } from "ink";
import { useEffect } from "react";

/** Enable basic button events using SGR coordinates for the lifetime of the TUI. */
export function useTerminalMouse(): void {
  const { stdout } = useStdout();

  useEffect(() => {
    if (!stdout.isTTY) return;
    stdout.write("\u001B[?1000h\u001B[?1006h");
    return () => {
      stdout.write("\u001B[?1006l\u001B[?1000l");
    };
  }, [stdout]);
}
