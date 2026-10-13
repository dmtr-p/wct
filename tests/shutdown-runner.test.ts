import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import type { ShutdownOutcome } from "../src/services/shutdown-runner";

const CLI_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function gitEnv() {
  const env = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_PREFIX",
  ]) {
    delete env[name];
  }
  return env;
}

// The fake pane sends SIGHUP to the caller's entire process group, like a lost
// terminal. Each CLI starts in its own group so the test harness is unaffected.
describe("shutdown across terminal loss", () => {
  let buildDirectory: string;
  let compiled: string;
  let root: string;
  let main: string;
  let worktree: string;
  let trace: string;
  let environment: string;
  let session: string;
  let cli: ReturnType<typeof Bun.spawn> | undefined;
  let externalResults: string[];

  beforeAll(async () => {
    buildDirectory = await mkdtemp(join(tmpdir(), "wct-shutdown-build-"));
    compiled = join(buildDirectory, "wct");
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        CLI_ENTRY,
        "--compile",
        "--outfile",
        compiled,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stderr = new Response(build.stderr).text();
    expect(await build.exited, await stderr).toBe(0);
  }, 30000);

  afterAll(async () => {
    await rm(buildDirectory, { recursive: true, force: true });
  });

  function git(args: string[], cwd = main) {
    const result = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv() });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }

  beforeEach(async () => {
    externalResults = [];
    root = await realpath(
      await mkdtemp(join(tmpdir(), "wct-terminal-shutdown-")),
    );
    main = join(root, "project");
    worktree = join(root, "demo-feature");
    session = basename(worktree);
    trace = join(root, "trace");
    environment = join(root, "environment");
    await mkdir(main);
    await mkdir(join(root, "home"));
    await mkdir(join(root, "tmp"));
    await mkdir(join(root, "bin"));
    await Bun.write(trace, "");
    await Bun.write(join(root, "session"), "exists");
    git(["init", "-b", "main"]);
    git([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    git(["worktree", "add", "-b", "feature", worktree]);
    await mkdir(join(worktree, "apps/web"), { recursive: true });
    const fakeTmux = join(root, "bin", "tmux");
    await Bun.write(
      fakeTmux,
      `#!${process.execPath}
import { appendFile, rm } from "node:fs/promises";
const root = process.env.WCT_TEST_ROOT;
const command = process.argv[2];
if (command === "display-message") {
  if (!process.argv.includes("%42")) process.exit(90);
  await Bun.write(root + "/caller", String(process.ppid));
  console.log(process.env.WCT_TEST_SESSION);
} else if (command === "has-session") {
  process.exit(await Bun.file(root + "/session").exists() ? 0 : 1);
} else if (command === "new-session") {
  const name = process.argv[process.argv.indexOf("-s") + 1];
  const cwd = process.argv[process.argv.indexOf("-c") + 1];
  await Bun.write(root + "/started-session", name);
  await Bun.write(root + "/started-directory", cwd);
  await Bun.write(root + "/session", "exists");
} else if (command === "set-environment" || command === "select-window") {
  process.exit(0);
} else if (command === "kill-session") {
  if (!process.argv.includes("=" + process.env.WCT_TEST_SESSION)) process.exit(91);
  await appendFile(root + "/trace", "kill\\n");
  await rm(root + "/session", { force: true });
  if (await Bun.file(root + "/caller").exists()) {
    const caller = Number(await Bun.file(root + "/caller").text());
    process.kill(-caller, "SIGHUP");
  }
} else process.exit(92);
`,
    );
    await chmod(fakeTmux, 0o755);
    await configure(false);
  });

  afterEach(async () => {
    if (cli && cli.exitCode === null && cli.signalCode === null)
      cli.kill("SIGKILL");
    if (cli) await cli.exited;
    cli = undefined;
    // Wait for committed workers to finish before removing their fixture paths.
    const directories = await readdir(join(root, "tmp"));
    for (const directory of directories.filter((name) =>
      name.startsWith("wct-shutdown-"),
    )) {
      await vi.waitFor(
        async () => {
          expect(
            await Bun.file(
              join(root, "tmp", directory, "result.json"),
            ).exists(),
          ).toBe(true);
        },
        { timeout: 5000 },
      );
    }
    for (const resultPath of externalResults) {
      await vi.waitFor(
        async () => {
          expect(await Bun.file(resultPath).exists()).toBe(true);
        },
        { timeout: 5000 },
      );
      await rm(dirname(resultPath), { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  });

  async function configure(fail: boolean) {
    await Bun.write(
      join(main, ".wct.yaml"),
      JSON.stringify({
        project_name: "demo",
        work_dir: "apps/web",
        down: [
          {
            name: "cleanup",
            command: `test ! -e ${quote(join(root, "session"))} && printf '%s\\n' "$PWD" "$WCT_WORKTREE_DIR" "$WCT_WORK_DIR" "$WCT_MAIN_DIR" > ${quote(environment)} && printf 'cleanup\\n' >> ${quote(trace)}${fail ? "; exit 3" : ""}`,
          },
          { name: "after", command: `printf 'after\\n' >> ${quote(trace)}` },
        ],
      }),
    );
  }

  function start(
    runtime: "source" | "compiled",
    args: string[],
    insidePane: boolean,
    cwd = join(worktree, "apps/web"),
    env: Record<string, string> = {},
  ) {
    const child = Bun.spawn(
      runtime === "compiled"
        ? [compiled, ...args]
        : [process.execPath, "run", CLI_ENTRY, ...args],
      {
        cwd,
        env: {
          ...gitEnv(),
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          HOME: join(root, "home"),
          TMPDIR: join(root, "tmp"),
          TMUX: insidePane ? "/fake/socket,1,0" : "",
          TMUX_PANE: insidePane ? "%42" : "",
          WCT_TEST_ROOT: root,
          WCT_TEST_SESSION: session,
          ...env,
        },
        detached: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    cli = child;
    return child;
  }

  async function savedOutcome(resultPath?: string) {
    let outcome: ShutdownOutcome | undefined;
    await vi.waitFor(
      async () => {
        if (!resultPath) {
          const directories = await readdir(join(root, "tmp"));
          expect(directories).toHaveLength(1);
          resultPath = join(root, "tmp", directories[0] ?? "", "result.json");
        }
        outcome = JSON.parse(
          await Bun.file(resultPath).text(),
        ) as ShutdownOutcome;
      },
      { timeout: 5000 },
    );
    return outcome;
  }

  test.each([
    ["source", "down"],
    ["source", "close"],
    ["compiled", "down"],
    ["compiled", "close"],
  ] as const)(
    "%s %s completes after its invoking process group receives SIGHUP",
    async (runtime, operation) => {
      const process = start(
        runtime,
        operation === "down"
          ? ["down"]
          : ["close", "feature", "--yes", "--force"],
        true,
      );
      const stdout = new Response(process.stdout).text();
      const stderr = new Response(process.stderr).text();
      await process.exited;
      expect(process.signalCode, await stderr).toBe("SIGHUP");
      expect(await stdout).toContain(
        "Shutdown continues independently; result:",
      );
      expect(await savedOutcome()).toMatchObject({
        ok: true,
        data: {
          operation,
          worktreePath: worktree,
          status: operation === "down" ? "killed" : "removed",
        },
      });
      expect(await Bun.file(trace).text()).toBe("kill\ncleanup\nafter\n");
      expect((await Bun.file(environment).text()).trim().split("\n")).toEqual([
        join(worktree, "apps/web"),
        worktree,
        join(worktree, "apps/web"),
        main,
      ]);
      const worktrees = Bun.spawnSync(
        ["git", "worktree", "list", "--porcelain"],
        { cwd: main, env: gitEnv() },
      ).stdout.toString();
      expect(worktrees.includes(`worktree ${worktree}\n`)).toBe(
        operation === "down",
      );
    },
    // CLI and worker startup need time in addition to the bounded result wait.
    15000,
  );

  test("required failures still preserve the worktree after terminal loss", async () => {
    await configure(true);
    const process = start(
      "source",
      ["close", "feature", "--yes", "--force"],
      true,
    );
    const stdout = new Response(process.stdout).text();
    const stderr = new Response(process.stderr).text();
    await process.exited;
    expect(process.signalCode, await stderr).toBe("SIGHUP");
    expect(await stdout).toContain("Shutdown continues independently");
    expect(await savedOutcome()).toMatchObject({
      ok: false,
      error: { code: "down_failed" },
    });
    expect(await Bun.file(trace).text()).toBe("kill\ncleanup\nafter\n");
    const listed = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
      cwd: main,
      env: gitEnv(),
    }).stdout.toString();
    expect(listed).toContain(`worktree ${worktree}\n`);
  });

  test("close --yes retries dirty removal in the worker without repeating cleanup", async () => {
    await Bun.write(join(worktree, "dirty-file"), "untracked");
    const child = start("source", ["close", "feature", "--yes"], true);
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    await child.exited;
    expect(child.signalCode, await stderr).toBe("SIGHUP");
    expect(await stdout).toContain("Shutdown continues independently");
    expect(await savedOutcome()).toMatchObject({
      ok: true,
      data: { status: "removed" },
    });
    expect(await Bun.file(trace).text()).toBe("kill\ncleanup\nafter\n");
  });

  test.each([false, true])(
    "inline close retries after cleanup deletes its cwd (json=%s)",
    async (json) => {
      await Bun.write(join(worktree, "dirty-file"), "untracked");
      await Bun.write(
        join(main, ".wct.yaml"),
        JSON.stringify({
          work_dir: "apps/web",
          down: [
            {
              name: "cleanup",
              command: `printf 'cleanup\\n' >> ${quote(trace)}; rm -rf "$WCT_WORK_DIR"`,
            },
          ],
        }),
      );
      const child = start(
        "source",
        ["close", "feature", "--yes", ...(json ? ["--json"] : [])],
        false,
      );
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      expect(await child.exited, await stderr).toBe(0);
      if (json)
        expect(JSON.parse(await stdout)).toMatchObject({
          ok: true,
          data: [{ status: "removed" }],
        });
      else expect(await stdout).toContain("Removed worktree 'feature'");
      expect(await Bun.file(trace).text()).toBe("kill\ncleanup\n");
      await expect(realpath(worktree)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  test.each([
    ["source", false],
    ["source", true],
    ["compiled", false],
    ["compiled", true],
  ] as const)(
    "%s stages outside a project-local TMPDIR (symlink=%s)",
    async (runtime, alias) => {
      const localTmp = join(worktree, "tmp");
      await mkdir(localTmp);
      const configuredTmp = alias ? join(root, "temp-alias") : localTmp;
      if (alias) await symlink(localTmp, configuredTmp);
      await Bun.write(
        join(main, ".wct.yaml"),
        JSON.stringify({
          work_dir: "apps/web",
          down: [
            {
              name: "cleanup",
              command: `printf 'cleanup\\n' >> ${quote(trace)}; rm -rf "$TMPDIR"`,
            },
          ],
        }),
      );
      const child = start(
        runtime,
        ["close", "feature", "--yes", "--force"],
        true,
        join(worktree, "apps/web"),
        { TMPDIR: configuredTmp },
      );
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      await child.exited;
      expect(child.signalCode, await stderr).toBe("SIGHUP");
      const resultPath = (await stdout).match(/result: ([^\r\n]+)/)?.[1];
      expect(resultPath).toBeDefined();
      if (!resultPath) throw new Error("Missing independent result path");
      externalResults.push(resultPath);
      const stagingRoot = await realpath(dirname(resultPath));
      expect(relative(worktree, stagingRoot).startsWith(`..${sep}`)).toBe(true);
      expect(await savedOutcome(resultPath)).toMatchObject({
        ok: true,
        data: { status: "removed" },
      });
      expect(await Bun.file(trace).text()).toBe("kill\ncleanup\n");
      await expect(realpath(worktree)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    // CLI and worker startup need time in addition to the bounded result wait.
    15000,
  );

  test.each([
    ["current directory", false],
    ["current directory", true],
    ["explicit path", false],
    ["explicit path", true],
  ] as const)(
    "up and down share the checkout-root session via %s (configured work_dir=%s)",
    async (target, configuredWorkDir) => {
      const config = await Bun.file(join(main, ".wct.yaml")).json();
      if (!configuredWorkDir) delete config.work_dir;
      config.tmux = { windows: [{ name: "main" }] };
      await Bun.write(join(main, ".wct.yaml"), JSON.stringify(config));
      await rm(join(root, "session"));
      const subdirectory = join(worktree, "apps/web");
      const args = [
        "up",
        "--no-attach",
        "--json",
        ...(target === "explicit path" ? ["--path", subdirectory] : []),
      ];
      const up = start(
        "source",
        args,
        false,
        target === "explicit path" ? main : subdirectory,
      );
      const upStdout = new Response(up.stdout).text();
      const upStderr = new Response(up.stderr).text();
      expect(await up.exited, await upStderr).toBe(0);
      const workingDir = configuredWorkDir ? subdirectory : worktree;
      expect(JSON.parse(await upStdout)).toMatchObject({
        ok: true,
        data: {
          worktreePath: worktree,
          sessionName: session,
          env: { WCT_WORKTREE_DIR: worktree, WCT_WORK_DIR: workingDir },
          attempts: {
            tmux: {
              attempted: true,
              ok: true,
              value: { _tag: "Created" },
            },
          },
        },
      });
      expect(await Bun.file(join(root, "started-session")).text()).toBe(
        session,
      );
      expect(await Bun.file(join(root, "started-directory")).text()).toBe(
        workingDir,
      );
      expect(await Bun.file(join(root, "session")).exists()).toBe(true);

      const down = start("source", ["down", "--json"], false);
      const downStdout = new Response(down.stdout).text();
      const downStderr = new Response(down.stderr).text();
      expect(await down.exited, await downStderr).toBe(0);
      expect(JSON.parse(await downStdout)).toMatchObject({
        ok: true,
        data: {
          worktreePath: worktree,
          sessionName: session,
          status: "killed",
        },
      });
      expect(await Bun.file(join(root, "session")).exists()).toBe(false);
      expect(await Bun.file(trace).text()).toBe("kill\ncleanup\nafter\n");
      expect((await Bun.file(environment).text()).trim().split("\n")).toEqual([
        workingDir,
        worktree,
        workingDir,
        main,
      ]);
    },
    // Allow for two CLI startups plus their Git and tmux subprocesses.
    15000,
  );

  test.each(["current directory", "explicit path"])(
    "down resolves a checkout subdirectory via %s",
    async (target) => {
      const args = [
        "down",
        "--json",
        ...(target === "explicit path"
          ? ["--path", join(worktree, "apps/web")]
          : []),
      ];
      const process = start("source", args, false);
      const stdout = new Response(process.stdout).text();
      const stderr = new Response(process.stderr).text();
      expect(await process.exited, await stderr).toBe(0);
      expect(JSON.parse(await stdout)).toMatchObject({
        ok: true,
        data: {
          worktreePath: worktree,
          sessionName: session,
          status: "killed",
        },
      });
      expect((await Bun.file(environment).text()).trim().split("\n")).toEqual([
        join(worktree, "apps/web"),
        worktree,
        join(worktree, "apps/web"),
        main,
      ]);
      expect(await readdir(join(root, "tmp"))).toEqual([]);
    },
  );

  test("down resolves the main checkout root from its configured pane directory", async () => {
    await mkdir(join(main, "apps/web"), { recursive: true });
    session = basename(main);
    const process = start(
      "source",
      ["down", "--json"],
      false,
      join(main, "apps/web"),
    );
    const stdout = new Response(process.stdout).text();
    const stderr = new Response(process.stderr).text();
    expect(await process.exited, await stderr).toBe(0);
    expect(JSON.parse(await stdout)).toMatchObject({
      ok: true,
      data: { worktreePath: main, sessionName: session },
    });
    expect((await Bun.file(environment).text()).trim().split("\n")).toEqual([
      join(main, "apps/web"),
      main,
      join(main, "apps/web"),
      main,
    ]);
  });
});
