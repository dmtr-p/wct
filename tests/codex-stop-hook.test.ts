import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const HOOK = fileURLToPath(new URL("../.codex/hooks/stop.sh", import.meta.url));

describe("Codex stop hook", () => {
  let root: string;
  let repo: string;
  let log: string;
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "wct-stop-hook-"));
    repo = join(root, "repo");
    log = join(root, "verification.log");
    for (const path of [
      repo,
      join(root, "bin"),
      join(root, "tmp"),
      join(root, "home"),
    ]) {
      await mkdir(path);
    }
    env = { ...process.env };
    for (const name of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_COMMON_DIR",
      "GIT_PREFIX",
    ])
      delete env[name];
    env.HOME = join(root, "home");
    env.TMPDIR = join(root, "tmp");
    await Bun.write(join(repo, "tracked file.txt"), "original\n");
    for (const args of [
      ["init", "-q"],
      ["add", "tracked file.txt"],
    ]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: repo, env });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    }
    await Bun.write(
      join(root, "bin", "bunx"),
      `#!/bin/sh
case "$WCT_HOOK_MODE" in
  modify) printf 'formatted\\n' > "tracked file.txt" ;;
  untracked) printf 'formatted\\n' > "new file.txt" ;;
  create) printf 'formatted\\n' > "created file.txt" ;;
  delete) rm "tracked file.txt" ;;
  error) printf 'Biome failure "quoted"\\n'; exit 1 ;;
esac
printf 'Biome complete\\n'
`,
    );
    await Bun.write(
      join(root, "bin", "bun"),
      `#!/bin/sh
if [ "$1" = "-e" ]; then exec "$WCT_HOOK_BUN" "$@"; fi
printf '%s\\n' "$*" >> "$WCT_HOOK_LOG"
`,
    );
    await chmod(join(root, "bin", "bunx"), 0o755);
    await chmod(join(root, "bin", "bun"), 0o755);
    env.PATH = `${join(root, "bin")}:${process.env.PATH}`;
    env.WCT_HOOK_BUN = process.execPath;
    env.WCT_HOOK_LOG = log;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function runHook(mode: string) {
    const result = Bun.spawnSync(["sh", HOOK], {
      cwd: repo,
      env: { ...env, WCT_HOOK_MODE: mode },
      stdin: "ignore",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return JSON.parse(result.stdout.toString());
  }

  test.each([
    ["tracked", "modify"],
    ["already dirty", "modify"],
    ["untracked", "untracked"],
    ["created", "create"],
    ["deleted", "delete"],
  ])("blocks when Biome changes a %s file", async (kind, mode) => {
    if (kind === "already dirty")
      await Bun.write(join(repo, "tracked file.txt"), "dirty\n");
    if (kind === "untracked")
      await Bun.write(join(repo, "new file.txt"), "unformatted\n");
    expect(runHook(mode)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("Biome modified files"),
    });
    expect(await Bun.file(log).exists()).toBe(false);
  });

  test.each([false, true])(
    "continues when Biome makes no edits (dirty=%s)",
    async (dirty) => {
      if (dirty) {
        await Bun.write(join(repo, "tracked file.txt"), "dirty\n");
        await Bun.write(join(repo, "new file.txt"), "untracked\n");
      }
      expect(runHook("unchanged")).toEqual({ continue: true });
      expect(await Bun.file(log).text()).toBe(
        "run typecheck\nrun test -- --reporter=agent\n",
      );
    },
  );

  test("blocks on Biome errors and emits valid JSON", async () => {
    expect(runHook("error")).toMatchObject({
      decision: "block",
      reason: expect.stringContaining('Biome failure "quoted"'),
    });
    expect(await Bun.file(log).exists()).toBe(false);
  });
});
