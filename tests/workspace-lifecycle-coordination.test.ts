import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const cliEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const tuiEntry = fileURLToPath(
  new URL("./fixtures/workspace-lifecycle.ts", import.meta.url),
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Each process has its own services, kernel descriptors and journal view.
describe("Workspace lifecycle across CLI and TUI processes", () => {
  let root: string;
  let repo: string;
  let env: Record<string, string | undefined>;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "wct-lifecycle-")));
    repo = join(root, "repo");
    await mkdir(repo);
    await mkdir(join(root, "home"));
    await mkdir(join(root, "bin"));
    env = {
      ...process.env,
      HOME: join(root, "home"),
      TMUX: "",
      TMUX_PANE: "",
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
    };
    for (const key of Object.keys(env))
      if (key.startsWith("GIT_")) delete env[key];
    await Bun.write(
      join(root, "bin/tmux"),
      "#!/bin/sh\necho 'no sessions' >&2\nexit 1\n",
    );
    const chmod = Bun.spawnSync(["chmod", "+x", join(root, "bin/tmux")]);
    expect(chmod.exitCode).toBe(0);
    git(["init", "-b", "main"]);
    await Bun.write(join(repo, ".gitignore"), ".wct.yaml\n");
    git(["add", ".gitignore"]);
    git([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-m",
      "fixture",
    ]);
  });
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  function git(args: string[]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo, env });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
  function cli(args: string[]) {
    const child = Bun.spawn([process.execPath, "run", cliEntry, ...args], {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    let diagnostics = "";
    const stderr = (async () => {
      for await (const chunk of child.stderr)
        diagnostics += new TextDecoder().decode(chunk);
      return diagnostics;
    })();
    return {
      child,
      stdout: new Response(child.stdout).text(),
      stderr,
      diagnostics: () => diagnostics,
    };
  }
  async function result(args: string[]) {
    const run = cli(args);
    const code = await run.child.exited;
    return { code, stdout: await run.stdout, stderr: await run.stderr };
  }
  async function until(check: () => Promise<boolean>) {
    const end = Date.now() + 8000;
    while (!(await check())) {
      if (Date.now() > end)
        throw new Error("Fixture synchronization timed out");
      await Bun.sleep(10);
    }
  }
  function tui(
    operation: "down" | "close" | "retry" | "open" = "down",
    previous?: unknown,
    gap?: string,
  ) {
    const messages: Array<{
      _tag: string;
      phase?: string;
      active?: number;
      message?: string;
      data?: import("../src/services/workspace-service").WorkspaceCloseResult;
    }> = [];
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        tuiEntry,
        JSON.stringify({
          repo,
          path: join(root, "trees/fixture-held"),
          branch: "held",
          operation,
          previous,
          gap,
        }),
      ],
      {
        cwd: repo,
        env,
        stdout: "pipe",
        stderr: "pipe",
        ipc: (message) => messages.push(message),
      },
    );
    children.push(child);
    const errors = new Response(child.stderr).text();
    return { child, messages, errors };
  }
  async function configure() {
    await Bun.write(
      join(repo, ".wct.yaml"),
      `version: 1\nproject_name: fixture\nworktree_dir: ../trees\nsetup:\n  - name: gated optional setup\n    optional: true\n    command: >-\n      if [ "$WCT_BRANCH" = held ]; then echo started >> ${quote(join(root, "trace"))}; touch ${quote(join(root, "started"))}; while [ -d ${quote(root)} ] && [ ! -f ${quote(join(root, "release"))} ]; do sleep 0.02; done; fi\ndown:\n  - name: cleanup\n    command: echo down >> ${quote(join(root, "trace"))}\n`,
    );
  }
  test("cancels only the TUI waiter while another Workspace completes", async () => {
    await configure();
    const owner = cli(["open", "held", "--json", "--no-attach"]);
    await until(() => Bun.file(join(root, "started")).exists());
    const worktree = join(root, "trees/fixture-held");
    const messages: Array<{
      _tag: string;
      phase?: string;
      active?: number;
      message?: string;
    }> = [];
    const waiter = Bun.spawn(
      [
        process.execPath,
        "run",
        tuiEntry,
        JSON.stringify({ repo, path: worktree, branch: "held" }),
      ],
      {
        cwd: repo,
        env,
        stdout: "pipe",
        stderr: "pipe",
        ipc: (message) => messages.push(message),
      },
    );
    children.push(waiter);
    const errors = new Response(waiter.stderr).text();
    await until(async () =>
      messages.some((message) => message.phase === "Waiting"),
    );
    const other = await result(["open", "other", "--json", "--no-attach"]);
    expect(other.code, other.stderr).toBe(0);
    waiter.send("cancel");
    expect(await waiter.exited, await errors).toBe(0);
    expect(messages).toContainEqual({ _tag: "Finished", active: 0 });
    expect(
      messages.some((message) =>
        message.message?.includes("Cancelled waiting"),
      ),
    ).toBe(true);
    expect(owner.child.exitCode).toBeNull();
    expect(await Bun.file(join(root, "trace")).text()).toBe("started\n");
    await Bun.write(join(root, "release"), "go");
    expect(await owner.child.exited, await owner.stderr).toBe(0);
    expect(JSON.parse(await owner.stdout).ok).toBe(true);
    const inspection = await result([
      "operations",
      "inspect",
      "held",
      "--json",
    ]);
    expect(JSON.parse(inspection.stdout).data.status).toBe("available");
  });

  test("crashed optional setup fences all callers until exact acknowledged reconciliation", async () => {
    await configure();
    const owner = cli(["open", "held", "--json", "--no-attach"]);
    await until(() => Bun.file(join(root, "started")).exists());
    const live = JSON.parse(
      (await result(["operations", "inspect", "held", "--json"])).stdout,
    ).data;
    expect(live.status).toBe("busy");
    const recovery = [
      "operations",
      "reconcile",
      "held",
      "--json",
      "--operation",
      live.reservation.operationId,
      "--generation",
      live.reservation.generation,
      "--reason",
      "Inspected fixture child",
      "--acknowledge-uncertain-side-effects",
    ];
    expect((await result(recovery)).code).not.toBe(0);
    owner.child.kill("SIGKILL");
    await owner.child.exited;
    const unknown = JSON.parse(
      (await result(["operations", "inspect", "held", "--json"])).stdout,
    ).data;
    expect(unknown.status).toBe("outcome-unknown");
    const blocked = await result(["down", "--branch", "held", "--json"]);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain(live.reservation.operationId);
    expect(blocked.stderr).toContain(live.reservation.generation);
    expect(await Bun.file(join(root, "trace")).text()).toBe("started\n");
    await Bun.write(join(root, "release"), "go");
    await owner.stdout;
    await owner.stderr;
    expect((await result(recovery.slice(0, -1))).code).not.toBe(0);
    const stale = [...recovery];
    stale[stale.indexOf("--generation") + 1] = "stale";
    expect((await result(stale)).code).not.toBe(0);
    const recovered = await result(recovery);
    expect(recovered.code, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout).data.status).toBe("reconciled");
    expect((await result(recovery)).code).not.toBe(0);
    const stopped = await result(["down", "--branch", "held", "--json"]);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(await Bun.file(join(root, "trace")).text()).toBe("started\ndown\n");
  }, 15000);
  test("revalidates configuration after a cross-process wait before running down", async () => {
    await configure();
    const owner = cli(["open", "held", "--json", "--no-attach"]);
    await until(() => Bun.file(join(root, "started")).exists());
    const waiter = tui();
    await until(async () =>
      waiter.messages.some((message) => message.phase === "Waiting"),
    );
    const config = join(repo, ".wct.yaml");
    await Bun.write(
      config,
      (await Bun.file(config).text()) + "work_dir: changed\n",
    );
    await Bun.write(join(root, "release"), "go");
    expect(await owner.child.exited, await owner.stderr).toBe(0);
    await owner.stdout;
    expect(await waiter.child.exited, await waiter.errors).toBe(0);
    expect(
      waiter.messages.some((message) =>
        message.message?.includes("configuration changed"),
      ),
    ).toBe(true);
    expect(await Bun.file(join(root, "trace")).text()).toBe("started\n");
  });

  test("removal-only retry rejects a replaced checkout and does not repeat down scripts", async () => {
    await configure();
    await Bun.write(join(root, "release"), "go");
    expect((await result(["open", "held", "--json", "--no-attach"])).code).toBe(
      0,
    );
    const path = join(root, "trees/fixture-held");
    await Bun.write(join(path, "dirty"), "keep");
    const close = tui("close");
    expect(await close.child.exited, await close.errors).toBe(0);
    const previous = close.messages.find(
      (message) => message._tag === "Result",
    )?.data;
    expect(previous?.status).toBe("blocked_by_changes");
    expect(previous?.removalTarget?.registration).toBeTruthy();
    git(["worktree", "remove", "--force", path]);
    git(["worktree", "add", path, "held"]);
    await Bun.write(join(path, "replacement"), "keep replacement");
    const retry = tui("retry", previous);
    expect(await retry.child.exited, await retry.errors).toBe(0);
    expect(
      retry.messages.some((message) => message.message?.includes("changed")),
    ).toBe(true);
    expect(await Bun.file(join(path, "replacement")).text()).toBe(
      "keep replacement",
    );
    expect(await Bun.file(join(root, "trace")).text()).toBe("started\ndown\n");
  });

  test("removal-only retry uses retained registration when the checkout disappears", async () => {
    await configure();
    await Bun.write(join(root, "release"), "go");
    expect((await result(["open", "held", "--json", "--no-attach"])).code).toBe(
      0,
    );
    const path = join(root, "trees/fixture-held");
    await Bun.write(join(path, "dirty"), "keep");
    const close = tui("close");
    expect(await close.child.exited, await close.errors).toBe(0);
    const previous = close.messages.find(
      (message) => message._tag === "Result",
    )?.data;
    expect(previous?.status).toBe("blocked_by_changes");
    await rm(path, { recursive: true });
    const retry = tui("retry", previous);
    expect(await retry.child.exited, await retry.errors).toBe(0);
    expect(
      retry.messages.find((message) => message._tag === "Result")?.data?.status,
    ).toBe("removed");
    expect(await Bun.file(join(root, "trace")).text()).toBe("started\ndown\n");
  });
  test("acknowledged setup retains the operation lease between steps and a CLI waiter can cancel", async () => {
    await configure();
    await Bun.write(join(root, "release"), "setup can finish");
    const gap = join(root, "release-gap");
    const owner = tui("open", undefined, gap);
    await until(async () =>
      owner.messages.some((message) => message._tag === "Gap"),
    );
    const waiter = cli(["down", "--branch", "held", "--json"]);
    await until(async () =>
      waiter.diagnostics().includes("Waiting for Workspace"),
    );
    expect(owner.child.exitCode).toBeNull();
    expect(await Bun.file(join(root, "trace")).text()).toBe("started\n");
    waiter.child.kill("SIGINT");
    await waiter.child.exited;
    expect(await waiter.stdout).toBe("");
    expect(await waiter.stderr).toContain("Ctrl-C cancels this wait");
    expect(owner.child.exitCode).toBeNull();
    await Bun.write(gap, "finish operation");
    expect(await owner.child.exited, await owner.errors).toBe(0);
    expect(owner.messages.some((message) => message._tag === "Result")).toBe(
      true,
    );
    expect(await Bun.file(join(root, "trace")).text()).toBe("started\n");
  });
});
