import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { commandDef, hooksCommand } from "../src/commands/hooks";
import { runBunPromise } from "../src/effect/runtime";
import { provideWctServices } from "../src/effect/services";
import * as bin from "../src/utils/bin";

const testDir = join(tmpdir(), `wct-test-hooks-${Date.now()}`);

async function runCommand(options: { install?: boolean }) {
  await runBunPromise(provideWctServices(hooksCommand(options)));
}

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
    binSpy = spyOn(bin, "resolveWctBin").mockReturnValue({
      cmd: "/usr/bin/wct",
      args: [],
    });
    originalCwd = process.cwd();
    await $`mkdir -p ${testDir}`.quiet();
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    binSpy.mockRestore();
    await $`rm -rf ${testDir}`.quiet();
  });

  test("default mode outputs JSON with Notification hooks to stdout", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(runCommand({})).resolves.toBeUndefined();
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
    await expect(runCommand({ install: true })).resolves.toBeUndefined();

    const settingsPath = join(testDir, ".claude", "settings.local.json");
    const settings = await Bun.file(settingsPath).json();
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.Notification).toHaveLength(2);
  });

  test("--install merges with existing settings", async () => {
    const claudeDir = join(testDir, ".claude");
    await $`mkdir -p ${claudeDir}`.quiet();
    await Bun.write(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Read"] } }),
    );

    await expect(runCommand({ install: true })).resolves.toBeUndefined();

    const settings = await Bun.file(
      join(claudeDir, "settings.local.json"),
    ).json();
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.hooks.Notification).toHaveLength(2);
  });

  test("--install merges with existing non-Notification hooks", async () => {
    const claudeDir = join(testDir, ".claude");
    await $`mkdir -p ${claudeDir}`.quiet();
    await Bun.write(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] },
      }),
    );

    await expect(runCommand({ install: true })).resolves.toBeUndefined();

    const settings = await Bun.file(
      join(claudeDir, "settings.local.json"),
    ).json();
    // Existing hooks preserved
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    // New hooks added
    expect(settings.hooks.Notification).toHaveLength(2);
  });

  test("--install merges missing matchers into existing Notification hooks", async () => {
    const claudeDir = join(testDir, ".claude");
    await $`mkdir -p ${claudeDir}`.quiet();
    await Bun.write(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({ hooks: { Notification: [{ matcher: "existing" }] } }),
    );

    await expect(runCommand({ install: true })).resolves.toBeUndefined();

    const settings = await Bun.file(
      join(claudeDir, "settings.local.json"),
    ).json();
    expect(settings.hooks.Notification).toHaveLength(3);
    expect(settings.hooks.Notification[0].matcher).toBe("existing");
    expect(settings.hooks.Notification[1].matcher).toBe("permission_prompt");
    expect(settings.hooks.Notification[2].matcher).toBe("idle_prompt");
  });

  test("--install does not duplicate existing wct Notification matchers", async () => {
    const claudeDir = join(testDir, ".claude");
    await $`mkdir -p ${claudeDir}`.quiet();
    await Bun.write(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({
        hooks: {
          Notification: [
            {
              matcher: "permission_prompt",
              hooks: [
                {
                  type: "command",
                  command: "'/usr/bin/wct' 'notify'",
                  async: true,
                },
              ],
            },
            {
              matcher: "idle_prompt",
              hooks: [
                {
                  type: "command",
                  command: "'/usr/bin/wct' 'notify'",
                  async: true,
                },
              ],
            },
          ],
        },
      }),
    );

    await expect(runCommand({ install: true })).resolves.toBeUndefined();

    const settings = await Bun.file(
      join(claudeDir, "settings.local.json"),
    ).json();
    expect(settings.hooks.Notification).toHaveLength(2);
  });

  test("adds wct notify to an existing matcher with other hooks", async () => {
    const claudeDir = join(testDir, ".claude");
    await $`mkdir -p ${claudeDir}`.quiet();
    await Bun.write(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({
        hooks: {
          Notification: [
            {
              matcher: "permission_prompt",
              hooks: [{ type: "command", command: "echo custom", async: true }],
            },
          ],
        },
      }),
    );

    await expect(runCommand({ install: true })).resolves.toBeUndefined();

    const settings = await Bun.file(
      join(claudeDir, "settings.local.json"),
    ).json();
    expect(settings.hooks.Notification).toHaveLength(3);
    expect(settings.hooks.Notification[0].matcher).toBe("permission_prompt");
    expect(settings.hooks.Notification[0].hooks).toHaveLength(1);
    expect(settings.hooks.Notification[1].matcher).toBe("permission_prompt");
    expect(settings.hooks.Notification[1].hooks[0].command).toContain("notify");
    expect(settings.hooks.Notification[2].matcher).toBe("idle_prompt");
  });

  test("--install handles corrupt JSON gracefully", async () => {
    const claudeDir = join(testDir, ".claude");
    await $`mkdir -p ${claudeDir}`.quiet();
    await Bun.write(join(claudeDir, "settings.local.json"), "{not valid json");

    await expect(runCommand({ install: true })).resolves.toBeUndefined();

    const settings = await Bun.file(
      join(claudeDir, "settings.local.json"),
    ).json();
    expect(settings.hooks.Notification).toHaveLength(2);
  });
});
