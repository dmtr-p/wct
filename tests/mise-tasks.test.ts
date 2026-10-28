import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const mise = Bun.which("mise");
const config = new URL("../mise.toml", import.meta.url);
const tasks = ["lint:fix", "format", "test"];

describe.skipIf(!mise)("mise task freshness", () => {
  let root: string;
  let repo: string;
  let log: string;
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "wct-mise-"));
    repo = join(root, "repo");
    log = join(root, "tasks.log");
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, ".githooks"));
    await Bun.write(join(repo, ".githooks", "pre-commit"), "#!/bin/sh\n");
    await mkdir(join(root, "bin"));
    const toml = (await Bun.file(config).text()).replace(
      /^bun = "[^"]+"$/m,
      'bun = "system"',
    );
    await Bun.write(join(repo, "mise.toml"), toml);
    await Bun.write(join(repo, "src", "example.ts"), "original\n");
    await Bun.write(join(repo, "README.md"), "documentation\n");
    await Bun.write(join(repo, "package.json"), "{}\n");
    await Bun.write(join(repo, "bun.lock"), "dependencies\n");
    await Bun.write(join(repo, ".oxfmtrc.json"), "{}\n");
    await Bun.write(join(root, "global.toml"), "");
    await Bun.write(log, "");
    await Bun.write(
      join(root, "bin", "bun"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then printf '1.4.3\\n'; exit 0; fi
printf '%s\\n' "$2" >> "$WCT_TASK_LOG"
if [ "$2" = "$WCT_TASK_FAIL" ]; then exit 1; fi
if [ "$2" = "format" ] && [ "$WCT_TASK_MODIFY" = "1" ]; then
  printf 'formatted\\n' > src/example.ts
fi
`,
    );
    await chmod(join(root, "bin", "bun"), 0o755);
    env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("MISE_")) delete env[key];
    }
    Object.assign(env, {
      PATH: `${join(root, "bin")}:${dirname(process.execPath)}:${process.env.PATH}`,
      MISE_CONFIG_DIR: join(root, "config"),
      MISE_GLOBAL_CONFIG_FILE: join(root, "global.toml"),
      MISE_SYSTEM_CONFIG_FILE: join(root, "global.toml"),
      MISE_CACHE_DIR: join(root, "cache"),
      MISE_DATA_DIR: join(root, "data"),
      MISE_STATE_DIR: join(root, "state"),
      MISE_TRUSTED_CONFIG_PATHS: repo,
      MISE_TASK_RUN_AUTO_INSTALL: "false",
      WCT_TASK_LOG: log,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function run(task: string, force = false) {
    if (!mise) throw new Error("mise is required");
    return Bun.spawnSync([mise, "run", ...(force ? ["--force"] : []), task], {
      cwd: repo,
      env,
      stdin: "ignore",
    });
  }

  function succeed(task: string, force = false) {
    const result = run(task, force);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }

  async function calls() {
    return (await Bun.file(log).text()).trim().split("\n").filter(Boolean);
  }

  test.each(tasks)(
    "caches %s separately and supports --force",
    async (task) => {
      succeed(task);
      succeed(task);
      expect(await calls()).toEqual([task]);
      succeed(task, true);
      expect(await calls()).toEqual([task, task]);
    },
  );

  test("documentation changes rerun formatting alone", async () => {
    for (const task of tasks) succeed(task);
    await Bun.write(join(repo, "README.md"), "updated documentation\n");
    for (const task of tasks) succeed(task);
    expect(await calls()).toEqual([...tasks, "format"]);
  });

  test("formatter configuration does not invalidate lint or tests", async () => {
    for (const task of tasks) succeed(task);
    await Bun.write(join(repo, ".oxfmtrc.json"), '{"printWidth":100}\n');
    for (const task of tasks) succeed(task);
    expect(await calls()).toEqual([...tasks, "format"]);
  });

  test("dependency changes invalidate all three tasks", async () => {
    for (const task of tasks) succeed(task);
    await Bun.write(join(repo, "bun.lock"), "updated dependencies\n");
    for (const task of tasks) succeed(task);
    expect(await calls()).toEqual([...tasks, ...tasks]);
  });

  test("source additions and deletions invalidate successful tests", async () => {
    succeed("test");
    const added = join(repo, "src", "added.ts");
    await Bun.write(added, "added\n");
    succeed("test");
    await rm(added);
    succeed("test");
    expect(await calls()).toEqual(["test", "test", "test"]);
  });

  test("hook changes invalidate successful tests", async () => {
    succeed("test");
    await Bun.write(
      join(repo, ".githooks", "pre-commit"),
      "#!/bin/sh\nexit 1\n",
    );
    succeed("test");
    expect(await calls()).toEqual(["test", "test"]);
  });

  test("records formatted contents after a successful fix", async () => {
    env.WCT_TASK_MODIFY = "1";
    succeed("format");
    succeed("format");
    expect(await Bun.file(join(repo, "src", "example.ts")).text()).toBe(
      "formatted\n",
    );
    expect(await calls()).toEqual(["format"]);
  });

  test("does not cache failed runs", async () => {
    env.WCT_TASK_FAIL = "test";
    expect(run("test").exitCode).not.toBe(0);
    expect(run("test").exitCode).not.toBe(0);
    delete env.WCT_TASK_FAIL;
    succeed("test");
    succeed("test");
    expect(await calls()).toEqual(["test", "test", "test"]);
  });

  test("pre-commit shares the full-suite test cache with stop hooks", async () => {
    succeed("test");
    succeed("pre-commit");
    succeed("pre-commit");
    expect((await calls()).sort()).toEqual(["format:check", "lint", "test"]);
  });

  test("hook installation selects the versioned hooks directory", () => {
    const initialized = Bun.spawnSync(["git", "init", "-q"], {
      cwd: repo,
      env,
    });
    expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
    succeed("hooks:install");
    const configured = Bun.spawnSync(
      ["git", "config", "--local", "--get", "core.hooksPath"],
      { cwd: repo, env },
    );
    expect(configured.exitCode, configured.stderr.toString()).toBe(0);
    expect(configured.stdout.toString().trim()).toBe(".githooks");
  });
});
