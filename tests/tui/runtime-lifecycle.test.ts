import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, FileSystem } from "effect";
import { describe, expect, test } from "vitest";
import { WorkspaceService } from "../../src/services/workspace-service";
import { tuiRuntime } from "../../src/tui/runtime";

describe("tui runtime lifecycle", () => {
  test("keeps the managed runtime process-scoped with no explicit dispose path", () => {
    expect(typeof tuiRuntime.dispose).toBe("function");

    const tuiCommandSource = readFileSync(
      resolve(__dirname, "../../src/commands/tui.ts"),
      "utf-8",
    );
    const appSource = readFileSync(
      resolve(__dirname, "../../src/tui/App.tsx"),
      "utf-8",
    );

    // Input adapter cleanup is separate from disposing the ManagedRuntime.
    const runtimeDisposal = /\btuiRuntime\s*\.\s*dispose\s*\(/;
    expect(tuiCommandSource).not.toMatch(runtimeDisposal);
    expect(appSource).not.toMatch(runtimeDisposal);
  });

  test("provides WorkspaceService to TUI effects", async () => {
    const serviceShape = await tuiRuntime.runPromise(
      WorkspaceService.use((service) =>
        Effect.succeed({
          up: typeof service.up,
          down: typeof service.down,
        }),
      ),
    );

    expect(serviceShape).toEqual({
      up: "function",
      down: "function",
    });
    const filesystem = await tuiRuntime.runPromise(FileSystem.FileSystem);
    expect(typeof filesystem.lstat).toBe("function");
  });
});
