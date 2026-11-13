import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runBunPromise } from "../../src/effect/runtime";
import { runShellCommands } from "../../src/services/command-runner";
import { execShell } from "../../src/services/process";
import {
  CurrentWorkspaceLease,
  makeWorkspaceCoordinationService,
  type ReconcileWorkspaceOperation,
  type WorkspaceOperationFence,
} from "../../src/services/workspace-coordination";
import {
  processGeneration,
  sameProcessGeneration,
} from "../../src/services/workspace-lock";

const fixture = new URL(
  "../fixtures/workspace-coordination.ts",
  import.meta.url,
).pathname;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
interface Message {
  _tag: string;
  ownership?: WorkspaceOperationFence;
  pid?: number;
  error?: string;
}
describe("cross-process Workspace coordination", () => {
  let directory: string;
  let root: string;
  let children: Bun.Subprocess<"ignore", "pipe", "pipe">[];
  let detached: number[];
  const target = () => ({ mainRepoPath: directory, branch: "feature/test" });
  const service = () =>
    runBunPromise(
      makeWorkspaceCoordinationService({ root, pollMilliseconds: 10 }),
    );
  const inspect = async () => {
    const coordination = await service();
    return runBunPromise(coordination.inspect(target()));
  };
  function launch(mode: string, extra: Record<string, unknown> = {}) {
    const messages: Message[] = [];
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        fixture,
        JSON.stringify({ ...target(), root, mode, ...extra }),
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        ipc: (message: Message) => messages.push(message),
      },
    );
    children.push(child);
    const message = async (tag: string) => {
      await expect
        .poll(() => messages.find((item) => item._tag === tag), {
          timeout: 10000,
        })
        .toBeDefined();
      const result = messages.find((item) => item._tag === tag);
      if (!result) throw new Error(`Missing ${tag}`);
      return result;
    };
    return { child, messages, message };
  }
  async function kill(child: (typeof children)[number]) {
    child.kill("SIGKILL");
    await child.exited;
  }
  async function markerPid(path: string) {
    await expect
      .poll(async () => readFile(path, "utf8").catch(() => ""), {
        timeout: 10000,
      })
      .toMatch(/^\d+$/);
    return Number(await readFile(path, "utf8"));
  }
  const reconciliation = (
    ownership: WorkspaceOperationFence,
  ): ReconcileWorkspaceOperation => ({
    expectedOwnership: ownership,
    acknowledgeUncertainSideEffects: true,
    resolution: "release-after-inspection",
    requestId: "inspection-1",
    reason: "Fixture work terminated and inspected",
  });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "wct-coordination-"));
    root = join(directory, "ownership");
    children = [];
    detached = [];
  });
  afterEach(async () => {
    for (const pid of detached) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
    for (const child of children) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(directory, { recursive: true, force: true });
  });

  test("simultaneous processes serialize, aliases share ownership, and other Workspaces progress", async () => {
    const alias = join(directory, "alias");
    await symlink(directory, alias);
    const first = launch("hold");
    await first.message("Acquired");
    const second = launch("hold", { mainRepoPath: alias });
    const independent = launch("hold", { branch: "another" });
    await Promise.all([
      second.message("Waiting"),
      independent.message("Acquired"),
    ]);
    expect(second.messages.some((message) => message._tag === "Acquired")).toBe(
      false,
    );
    await first.message("Idle");
    first.child.send({ _tag: "Release" });
    expect(await first.child.exited).toBe(0);
    await second.message("Acquired");
    await second.message("Idle");
    second.child.send({ _tag: "Release" });
    expect(await second.child.exited).toBe(0);
  });

  test("waiting cancellation settles without releasing a separate live owner", async () => {
    const owner = launch("hold");
    await owner.message("Acquired");
    const coordination = await service();
    await runBunPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const waiter = yield* coordination
            .acquire(target())
            .pipe(Effect.forkChild);
          yield* Fiber.interrupt(waiter);
        }),
      ),
    );
    expect((await inspect()).status).toBe("busy");
    const waiter = launch("hold");
    await waiter.message("Waiting");
    await kill(waiter.child);
    expect((await inspect()).status).toBe("busy");
    const state = await inspect();
    if (state.status !== "busy" || !state.reservation)
      throw new Error("Missing live owner");
    const failure = await runBunPromise(
      Effect.flip(
        coordination.reconcile(target(), reconciliation(state.reservation)),
      ),
    );
    expect(failure.message).toContain("live custodian");
  });

  test.each(["idle", "command"])(
    "SIGKILL during %s leaves a durable fence until exact explicit reconciliation",
    async (phase) => {
      const script =
        phase === "command"
          ? `echo started > ${quote(join(directory, "started"))}; exec sleep 60`
          : undefined;
      const owner = launch("hold", { script });
      const acquired = await owner.message("Acquired");
      if (script)
        await expect
          .poll(() =>
            readFile(join(directory, "started"), "utf8").catch(() => ""),
          )
          .toBe("started\n");
      else await owner.message("Idle");
      const before = await inspect();
      const scriptPid =
        before.status === "busy"
          ? before.reservation?.command?.child?.pid
          : undefined;
      if (scriptPid) detached.push(scriptPid);
      await kill(owner.child);
      const state = await inspect();
      expect(state.status).toBe("outcome-unknown");
      const contender = launch("hold");
      await contender.message("Failed");
      expect(await contender.child.exited).toBe(1);
      const coordination = await service();
      const ownership = acquired.ownership;
      if (!ownership) throw new Error("Missing ownership");
      const stale = await runBunPromise(
        Effect.flip(
          coordination.reconcile(
            target(),
            reconciliation({
              ...ownership,
              generation: "reused-pid-generation",
            }),
          ),
        ),
      );
      expect(stale.message).toContain("Stale reconciliation");
      if (scriptPid) process.kill(scriptPid, "SIGKILL");
      await runBunPromise(
        coordination.reconcile(target(), reconciliation(ownership)),
      );
      expect((await inspect()).status).toBe("available");
      const newer = launch("hold");
      await newer.message("Acquired");
      expect(
        (
          await runBunPromise(
            Effect.flip(
              coordination.reconcile(target(), reconciliation(ownership)),
            ),
          )
        ).message,
      ).toContain("live custodian");
    },
  );

  test("surviving detached script work stays fenced after all custodians die", async () => {
    const marker = join(directory, "survivor");
    const background = `${quote(process.execPath)} run ${quote(fixture)} ${quote(JSON.stringify({ mode: "background", marker }))}`;
    const owner = launch("command", {
      script: `${background} >/dev/null 2>&1 & wait`,
    });
    const acquired = await owner.message("Acquired");
    const pid = await markerPid(marker);
    detached.push(pid);
    await kill(owner.child);
    expect(processGeneration(pid).pid).toBe(pid);
    const state = await inspect();
    expect(state.status).toBe("outcome-unknown");
    process.kill(pid, "SIGKILL");
    const coordination = await service();
    if (!acquired.ownership) throw new Error("Missing ownership");
    await runBunPromise(
      coordination.reconcile(target(), reconciliation(acquired.ownership)),
    );
    expect((await inspect()).status).toBe("available");
  });

  test("acknowledged background launch ends the command boundary but retains the encompassing operation", async () => {
    const marker = join(directory, "background");
    const background = `${quote(process.execPath)} run ${quote(fixture)} ${quote(JSON.stringify({ mode: "background", marker }))}`;
    const owner = launch("command", {
      script: `${background} >/dev/null 2>&1 &`,
    });
    await owner.message("CommandCompleted");
    detached.push(await markerPid(marker));
    const state = await inspect();
    expect(state.status).toBe("busy");
    if (state.status === "busy") expect(state.reservation?.phase).toBe("owned");
    await owner.message("Idle");
    owner.child.send({ _tag: "Release" });
    expect(await owner.child.exited).toBe(0);
    expect((await inspect()).status).toBe("available");
    expect(processGeneration(detached[0] ?? 0).pid).toBe(detached[0]);
  });

  test("known nonzero command completion releases normally and registry writes stay independent", async () => {
    const owner = launch("command", { script: "exit 7" });
    await owner.message("Failed");
    expect(await owner.child.exited).toBe(1);
    expect((await inspect()).status).toBe("available");
    const live = launch("hold");
    await live.message("Acquired");
    const writer = launch("registry", { home: directory });
    expect(
      await writer.child.exited,
      await new Response(writer.child.stderr).text(),
    ).toBe(0);
    expect(await readFile(join(directory, ".wct/wct.db"))).toBeDefined();
    expect((await inspect()).status).toBe("busy");
  });

  test("corrupt journals and process generation mismatch cannot authorize recovery", async () => {
    const owner = launch("hold");
    await owner.message("Acquired");
    await kill(owner.child);
    const file = (await readdir(root)).find((name) => name.endsWith(".json"));
    if (!file) throw new Error("Missing journal");
    const path = join(root, file);
    const journal = JSON.parse(await readFile(path, "utf8"));
    journal.reservation.owner = {
      ...processGeneration(process.pid),
      started: "mismatching-start-time",
    };
    await writeFile(path, JSON.stringify(journal));
    expect((await inspect()).status).toBe("outcome-unknown");
    expect(
      sameProcessGeneration(
        processGeneration(process.pid),
        journal.reservation.owner,
      ),
    ).toBe(false);
    await writeFile(path, "{");
    const coordination = await service();
    expect(
      (await runBunPromise(Effect.flip(coordination.inspect(target())))).code,
    ).toBe("workspace_coordination_error");
  });

  test("cancelling a script fences its generation and refuses further user code", async () => {
    const coordination = await service();
    await runBunPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* coordination.acquire(target());
          const command = yield* lease
            .command("cancelled", Effect.never)
            .pipe(Effect.forkChild);
          yield* Effect.sleep("20 millis");
          yield* Fiber.interrupt(command);
          const failure = yield* Effect.flip(
            execShell(
              `echo escaped > ${quote(join(directory, "escaped"))}`,
            ).pipe(Effect.provideService(CurrentWorkspaceLease, lease)),
          );
          expect(failure.message).toContain("uncertain");
        }),
      ),
    );
    expect((await inspect()).status).toBe("outcome-unknown");
    expect(
      await readFile(join(directory, "escaped"), "utf8").catch(() => "absent"),
    ).toBe("absent");
  });

  test("signal loss of a final optional script propagates uncertainty rather than a warning", async () => {
    const coordination = await service();
    const failure = await runBunPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* coordination.acquire(target());
          return yield* Effect.flip(
            runShellCommands(
              [
                {
                  name: "lost shell",
                  command: "kill -KILL $$",
                  optional: true,
                },
                {
                  name: "must not run",
                  command: `echo escaped > ${quote(join(directory, "escaped"))}`,
                },
              ],
              directory,
              {
                WCT_WORK_DIR: directory,
                WCT_WORKTREE_DIR: directory,
                WCT_MAIN_DIR: directory,
                WCT_BRANCH: "feature/test",
                WCT_PROJECT: "test",
              },
            ).pipe(Effect.provideService(CurrentWorkspaceLease, lease)),
          );
        }),
      ),
    );
    expect(failure.code).toBe("workspace_coordination_error");
    expect((await inspect()).status).toBe("outcome-unknown");
    expect(
      await readFile(join(directory, "escaped"), "utf8").catch(() => "absent"),
    ).toBe("absent");
  });

  test("output collection failure retains uncertainty even after the direct process is cleaned up", async () => {
    const coordination = await service();
    const failure = await runBunPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* coordination.acquire(target());
          return yield* Effect.flip(
            execShell("printf 'output exceeds limit'", {
              maxOutputBytes: 1,
            }).pipe(Effect.provideService(CurrentWorkspaceLease, lease)),
          );
        }),
      ),
    );
    expect(failure).toMatchObject({ code: "workspace_coordination_error" });
    expect((await inspect()).status).toBe("outcome-unknown");
  });

  test("Bun stdio inheritance shares custody through Ready/Start/Adopted without reacquisition", async () => {
    const marker = join(directory, "worker");
    const parent = launch("transfer", { marker });
    const original = await parent.message("Acquired");
    await parent.message("Ready");
    expect((await inspect()).status).toBe("busy");
    parent.child.send({ _tag: "Start" });
    const transferred = await parent.message("Transferred");
    if (!transferred.pid) throw new Error("Missing worker PID");
    detached.push(transferred.pid);
    expect(await markerPid(marker)).toBe(transferred.pid);
    const state = await inspect();
    expect(state.status).toBe("busy");
    if (state.status !== "busy" || !state.reservation)
      throw new Error("Missing worker owner");
    expect(state.reservation.operationId).toBe(original.ownership?.operationId);
    expect(state.reservation.generation).not.toBe(
      original.ownership?.generation,
    );
    await kill(parent.child);
    expect((await inspect()).status).toBe("busy");
    process.kill(transferred.pid, "SIGKILL");
    await expect
      .poll(async () => (await inspect()).status)
      .toBe("outcome-unknown");
    const coordination = await service();
    if (!original.ownership) throw new Error("Missing original ownership");
    expect(
      (
        await runBunPromise(
          Effect.flip(
            coordination.reconcile(
              target(),
              reconciliation(original.ownership),
            ),
          ),
        )
      ).message,
    ).toContain("Stale reconciliation");
    await runBunPromise(
      coordination.reconcile(target(), reconciliation(state.reservation)),
    );
  });

  test("worker rejection before Ready restores caller custody and permits normal release", async () => {
    const parent = launch("transfer", { workerStage: "reject" });
    await parent.message("Failed");
    expect(await parent.child.exited).toBe(1);
    expect((await inspect()).status).toBe("available");
  });

  test("normal worker completion releases only after the encompassing worker scope finishes", async () => {
    const marker = join(directory, "worker");
    const finishMarker = join(directory, "finish");
    const parent = launch("transfer", { marker, finishMarker, script: "true" });
    await parent.message("Ready");
    parent.child.send({ _tag: "Start" });
    const transferred = await parent.message("Transferred");
    if (transferred.pid) detached.push(transferred.pid);
    expect((await inspect()).status).toBe("busy");
    await writeFile(finishMarker, "finish");
    expect(await parent.child.exited).toBe(0);
    expect((await inspect()).status).toBe("available");
  });

  test("cancellation before Start reaps prospective custody before restoring the caller", async () => {
    const parent = launch("transfer", { cancelBeforeStart: true });
    await parent.message("Ready");
    parent.child.send({ _tag: "Start" });
    expect(await parent.child.exited).toBe(1);
    expect((await inspect()).status).toBe("available");
  });

  test("cancellation after Start cannot kill or restore authority over an unacknowledged worker", async () => {
    const marker = join(directory, "worker");
    const parent = launch("transfer", {
      marker,
      workerStage: "before-adopt",
      cancellableTransfer: true,
    });
    await parent.message("Ready");
    parent.child.send({ _tag: "Start" });
    const pid = await markerPid(`${marker}.before-adopt`);
    detached.push(pid);
    parent.child.send({ _tag: "Cancel" });
    expect(await parent.child.exited).toBe(1);
    expect((await inspect()).status).toBe("busy");
    process.kill(pid, "SIGKILL");
    await expect
      .poll(async () => (await inspect()).status)
      .toBe("outcome-unknown");
  });

  test("caller death after Ready and before Start preserves the durable transfer reservation", async () => {
    const parent = launch("transfer");
    await parent.message("Ready");
    await kill(parent.child);
    await expect
      .poll(async () => (await inspect()).status, { timeout: 10000 })
      .toBe("outcome-unknown");
  });

  test("caller death before the first ticket closes inherited custody even when the worker catches the error", async () => {
    const marker = join(directory, "worker");
    const parent = launch("transfer", { marker, omitTicket: true });
    const ready = await parent.message("Ready");
    if (!ready.pid) throw new Error("Missing prospective worker PID");
    detached.push(ready.pid);
    await kill(parent.child);
    expect(await markerPid(`${marker}.closed`)).toBe(ready.pid);
    expect(processGeneration(ready.pid).pid).toBe(ready.pid);
    expect((await inspect()).status).toBe("outcome-unknown");
  });

  test("loss after Start before Adopted retains outcome unknown", async () => {
    const marker = join(directory, "worker");
    const parent = launch("transfer", { marker, workerStage: "before-adopt" });
    await parent.message("Ready");
    parent.child.send({ _tag: "Start" });
    const pid = await markerPid(`${marker}.before-adopt`);
    detached.push(pid);
    await kill(parent.child);
    expect((await inspect()).status).toBe("busy");
    process.kill(pid, "SIGKILL");
    await expect
      .poll(async () => (await inspect()).status)
      .toBe("outcome-unknown");
  });

  test("lost Adopted acknowledgement preserves the new worker generation after caller cancellation", async () => {
    const marker = join(directory, "worker");
    const parent = launch("transfer", {
      marker,
      workerStage: "drop-adopted",
      cancellableTransfer: true,
    });
    const original = await parent.message("Acquired");
    await parent.message("Ready");
    parent.child.send({ _tag: "Start" });
    const pid = await markerPid(marker);
    detached.push(pid);
    const state = await inspect();
    if (state.status !== "busy" || !state.reservation || !original.ownership)
      throw new Error("Missing custody");
    expect(state.reservation.generation).not.toBe(
      original.ownership.generation,
    );
    parent.child.send({ _tag: "Cancel" });
    expect(await parent.child.exited).toBe(1);
    expect((await inspect()).status).toBe("busy");
    process.kill(pid, "SIGKILL");
    await expect
      .poll(async () => (await inspect()).status)
      .toBe("outcome-unknown");
    const coordination = await service();
    expect(
      (
        await runBunPromise(
          Effect.flip(
            coordination.reconcile(
              target(),
              reconciliation(original.ownership),
            ),
          ),
        )
      ).message,
    ).toContain("Stale reconciliation");
    await runBunPromise(
      coordination.reconcile(target(), reconciliation(state.reservation)),
    );
  });
});
