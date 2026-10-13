import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
      join(root, "bin", "bun"),
      `#!/bin/sh
if [ "$1" = "-e" ]; then exec "$WCT_HOOK_BUN" "$@"; fi
printf '%s\\n' "$*" >> "$WCT_HOOK_LOG"
if [ "$2" = "$WCT_HOOK_STAGE" ]; then
  case "$2" in
    lint:fix) tool=Oxlint ;;
    format) tool=Oxfmt ;;
    test) tool=Tests ;;
  esac
  case "$WCT_HOOK_MODE" in
    modify) printf 'formatted\\n' > "tracked file.txt" ;;
    untracked) printf 'formatted\\n' > "new file.txt" ;;
    create) printf 'formatted\\n' > "created file.txt" ;;
    temporary) printf 'formatted\\n' > "$TMPDIR/user-file.txt" ;;
    delete) rm "tracked file.txt" ;;
    error) printf '%s failure "quoted"\\n' "$tool"; exit 1 ;;
  esac
  printf '%s complete\\n' "$tool"
fi
`,
    );
    await chmod(join(root, "bin", "bun"), 0o755);
    env.PATH = `${join(root, "bin")}:${process.env.PATH}`;
    env.WCT_HOOK_BUN = process.execPath;
    env.WCT_HOOK_LOG = log;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function runHook(mode: string, stage = "format") {
    const result = Bun.spawnSync(["sh", HOOK], {
      cwd: repo,
      env: { ...env, WCT_HOOK_MODE: mode, WCT_HOOK_STAGE: stage },
      stdin: "ignore",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return JSON.parse(result.stdout.toString());
  }

  test.each(
    ["lint:fix", "format"].flatMap((stage) =>
      (
        [
          ["tracked", "modify"],
          ["already dirty", "modify"],
          ["untracked", "untracked"],
          ["created", "create"],
          ["deleted", "delete"],
        ] as const
      ).map(([kind, mode]) => [stage, kind, mode] as const),
    ),
  )("blocks when %s changes a %s file", async (stage, kind, mode) => {
    if (kind === "already dirty")
      await Bun.write(join(repo, "tracked file.txt"), "dirty\n");
    if (kind === "untracked")
      await Bun.write(join(repo, "new file.txt"), "unformatted\n");
    expect(runHook(mode, stage)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("Oxlint or Oxfmt modified files"),
    });
    expect(await Bun.file(log).text()).toBe("run lint:fix\nrun format\n");
  });

  test.each([false, true])(
    "continues when lint and format make no edits (dirty=%s)",
    async (dirty) => {
      if (dirty) {
        await Bun.write(join(repo, "tracked file.txt"), "dirty\n");
        await Bun.write(join(repo, "new file.txt"), "untracked\n");
      }
      expect(runHook("unchanged")).toEqual({ continue: true });
      expect(await Bun.file(log).text()).toBe(
        "run lint:fix\nrun format\nrun test -- --reporter=agent\n",
      );
    },
  );

  test.each(["absolute", "relative", "symlink"])(
    "ignores its own logs in a project-local TMPDIR (%s)",
    async (kind) => {
      const temporaryDirectory = join(repo, "tmp");
      await mkdir(temporaryDirectory);
      if (kind === "symlink") {
        env.TMPDIR = join(root, "temp-alias");
        await symlink(temporaryDirectory, env.TMPDIR);
      } else {
        env.TMPDIR = kind === "relative" ? "./tmp" : temporaryDirectory;
      }
      expect(runHook("unchanged")).toEqual({ continue: true });
      expect(await Bun.file(log).text()).toBe(
        "run lint:fix\nrun format\nrun test -- --reporter=agent\n",
      );
      for (const mode of ["modify", "temporary"]) {
        expect(runHook(mode)).toMatchObject({
          decision: "block",
          reason: expect.stringContaining("Oxlint or Oxfmt modified files"),
        });
      }
    },
    // Each case runs three hooks with real Bun/Git snapshot subprocesses.
    15_000,
  );

  test.each([
    ["lint:fix", "Oxlint", "run lint:fix\n"],
    ["format", "Oxfmt", "run lint:fix\nrun format\n"],
    [
      "test",
      "Tests",
      "run lint:fix\nrun format\nrun test -- --reporter=agent\n",
    ],
  ])(
    "blocks on %s errors and emits valid JSON",
    async (stage, tool, commands) => {
      expect(runHook("error", stage)).toMatchObject({
        decision: "block",
        reason: expect.stringContaining(`${tool} failure "quoted"`),
      });
      expect(await Bun.file(log).text()).toBe(commands);
    },
  );
});
