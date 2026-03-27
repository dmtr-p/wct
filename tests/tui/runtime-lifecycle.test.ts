import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { tuiRuntime } from "../../src/tui/runtime";

describe("tui runtime lifecycle", () => {
  test("keeps the managed runtime process-scoped with no explicit dispose path", () => {
    // The runtime has a dispose method (it's a ManagedRuntime)
    expect(typeof tuiRuntime.dispose).toBe("function");

    // But the TUI command and App startup intentionally do NOT call it
    const tuiCommandSource = readFileSync(
      resolve(__dirname, "../../src/commands/tui.ts"),
      "utf-8",
    );
    const appSource = readFileSync(
      resolve(__dirname, "../../src/tui/App.tsx"),
      "utf-8",
    );

    expect(tuiCommandSource).not.toContain(".dispose(");
    expect(appSource).not.toContain(".dispose(");
  });
});
