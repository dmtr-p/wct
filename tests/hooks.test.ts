import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandDef, hooksCommand } from "../src/commands/hooks";
import * as bin from "../src/utils/bin";

const testDir = join(tmpdir(), `wct-test-hooks-${Date.now()}`);

describe("hooks commandDef", () => {
  test("has correct name and --install option", () => {
    expect(commandDef.name).toBe("hooks");
    const optionNames = commandDef.options?.map((o) => o.name) ?? [];
    expect(optionNames).toContain("install");
  });
});

describe("hooksCommand", () => {
  let binSpy: ReturnType<typeof spyOn>;
  let originalCwd: string;

  beforeEach(async () => {
    binSpy = spyOn(bin, "resolveWctBin").mockReturnValue("/usr/bin/wct");
    originalCwd = process.cwd();
    await mkdir(testDir, { recursive: true });
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    binSpy.mockRestore();
    await rm(testDir, { recursive: true, force: true });
  });

  test("default mode outputs JSON with Notification hooks to stdout", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await hooksCommand({});

      expect(result.success).toBe(true);
      expect(logSpy).toHaveBeenCalledTimes(1);

      const output = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
      expect(output.hooks.Notification).toBeDefined();
      expect(output.hooks.Notification).toHaveLength(2);
      expect(output.hooks.Notification[0].matcher).toBe("permission_prompt");
      expect(output.hooks.Notification[1].matcher).toBe("idle_prompt");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("--install creates .claude/settings.local.json with hooks", async () => {
    const result = await hooksCommand({ install: true });

    expect(result.success).toBe(true);

    const settingsPath = join(testDir, ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.Notification).toHaveLength(2);
  });

  test("--install merges with existing settings", async () => {
    const claudeDir = join(testDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    await Bun.write(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Read"] } }),
    );

    const result = await hooksCommand({ install: true });

    expect(result.success).toBe(true);

    const settings = await Bun.file(
      join(claudeDir, "settings.local.json"),
    ).json();
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.hooks.Notification).toHaveLength(2);
  });

  test("--install merges with existing non-Notification hooks", async () => {
    const claudeDir = join(testDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    await Bun.write(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] },
      }),
    );

    const result = await hooksCommand({ install: true });

    expect(result.success).toBe(true);

    const settings = await Bun.file(
      join(claudeDir, "settings.local.json"),
    ).json();
    // Existing hooks preserved
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    // New hooks added
    expect(settings.hooks.Notification).toHaveLength(2);
  });

  test("--install warns if Notification already configured", async () => {
    const claudeDir = join(testDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    await Bun.write(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({ hooks: { Notification: [{ matcher: "existing" }] } }),
    );

    const result = await hooksCommand({ install: true });

    // Should return ok without overwriting
    expect(result.success).toBe(true);

    const settings = await Bun.file(
      join(claudeDir, "settings.local.json"),
    ).json();
    // Original Notification should be preserved (not overwritten)
    expect(settings.hooks.Notification).toHaveLength(1);
    expect(settings.hooks.Notification[0].matcher).toBe("existing");
  });

  test("--install handles corrupt JSON gracefully", async () => {
    const claudeDir = join(testDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    await Bun.write(join(claudeDir, "settings.local.json"), "{not valid json");

    const result = await hooksCommand({ install: true });

    expect(result.success).toBe(true);

    const settings = await Bun.file(
      join(claudeDir, "settings.local.json"),
    ).json();
    expect(settings.hooks.Notification).toHaveLength(2);
  });
});
