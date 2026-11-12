import { chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, vi } from "vitest";
import { runBunPromise } from "../../src/effect/runtime";
import { workspaceSessionName } from "../../src/services/session-identity";
import {
  type AttachmentLaunch,
  CLIENTS_FORMAT,
  nativeClientAction,
  parseAttachmentClients,
} from "../../src/services/terminal-attachments";
import { makeTmuxService, type TmuxClient } from "../../src/services/tmux";
import { test } from "../helpers/temp-dir";

const state = vi.hoisted(() => ({
  executable: "",
  unsupported: false,
  corruptIdentity: false,
  afterRecord: undefined as
    { key: string; run: () => Promise<void> } | undefined,
}));
vi.mock("../../src/services/process", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/services/process")
  >("../../src/services/process");
  const { Effect } = await import("effect");
  return {
    ...actual,
    execProcess: (
      program: string,
      args: string[],
      options?: import("../../src/services/process").ProcessOptions,
    ) => {
      if (program !== "tmux") return actual.execProcess(program, args, options);
      if (!state.executable)
        return Effect.die(new Error("Missing isolated tmux fixture"));
      if (state.unsupported && options?.env?.WCT_ATTACHMENT_PROBE)
        return actual.execProcess(
          state.executable,
          ["display-message", "-p", "#{socket_path}|#{pid}|#{start_time}\t"],
          options,
        );
      if (state.unsupported && args.includes(CLIENTS_FORMAT))
        return Effect.die(
          new Error("Older native discovery must not use client loops"),
        );
      return actual.execProcess(state.executable, args, options).pipe(
        Effect.flatMap((output) =>
          Effect.promise(async () => {
            if (
              args[0] === "show-options" &&
              state.afterRecord &&
              args.includes(state.afterRecord.key)
            ) {
              const callback = state.afterRecord.run;
              state.afterRecord = undefined;
              await callback();
            }
            if (state.corruptIdentity && args.includes(CLIENTS_FORMAT)) {
              return {
                ...output,
                stdout: output.stdout.replace(
                  /\t(\d+)\t(\d+)\t/g,
                  "\t99999999\t1\t",
                ),
              };
            }
            return output;
          }),
        ),
      );
    },
  };
});

const tmuxPath = Bun.which("tmux");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

describe("terminal attachment metadata", () => {
  test("preserves control clients without a tty and rejects missing identity", () => {
    expect(
      parseAttachmentClients("\tmain\t/socket|1|2\tclient-3\t\t3\t4\t$0\t\n"),
    ).toEqual([
      {
        tty: "",
        session: "main",
        server: "/socket|1|2",
        name: "client-3",
        pid: "3",
        created: "4",
        sessionId: "$0",
        marker: "",
      },
    ]);
    expect(parseAttachmentClients("/dev/tty\tmain\n")).toEqual([]);
  });
});

test.skipIf(!tmuxPath)(
  "isolated servers fence attachment ownership and support cross-process native discovery",
  async ({ tempDir, skip }) => {
    const socket = join(tempDir, "server.sock");
    const executable = join(tempDir, "tmux");
    await Bun.write(
      executable,
      `#!/bin/sh\nexec ${quote(tmuxPath ?? "")} -S ${quote(socket)} -f /dev/null "$@"\n`,
    );
    await chmod(executable, 0o755);
    state.executable = executable;
    state.unsupported = false;
    state.corruptIdentity = false;
    const processes: Bun.Subprocess[] = [];
    const terminals: Bun.Terminal[] = [];
    const processTerminals = new Map<number, Bun.Terminal>();
    async function command(...args: string[]) {
      const child = Bun.spawn([executable, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, TMUX: "" },
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(`Isolated tmux ${args[0]}: ${stderr}`);
      return stdout.trim();
    }
    function launch(
      description?: AttachmentLaunch,
      observer = false,
      existingTerminal?: Bun.Terminal,
    ) {
      const env = {
        ...process.env,
        TMUX: "",
        TERM: "xterm-256color",
        ...description?.env,
      };
      const args = description?.args ?? ["attach-session", "-t", "$0"];
      if (observer) {
        const child = Bun.spawn([executable, "-C", ...args], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env,
        });
        processes.push(child);
        return child;
      }
      const terminal =
        existingTerminal ?? new Bun.Terminal({ cols: 80, rows: 24, data() {} });
      if (!existingTerminal) terminals.push(terminal);
      const child = Bun.spawn([executable, ...args], { terminal, env });
      processes.push(child);
      processTerminals.set(child.pid, terminal);
      return child;
    }
    const target = {
      mainRepoPath: tempDir,
      worktreePath: tempDir,
      branch: "main",
    };
    const other = { ...target, branch: "other" };
    try {
      await command(
        "new-session",
        "-d",
        "-s",
        workspaceSessionName(target),
        "-c",
        tempDir,
      );
      const tmux = await runBunPromise(makeTmuxService());
      // Real resolution must establish the existing #332 ownership contract.
      await expect(
        runBunPromise(tmux.prepareAttachment(target, "browser")),
      ).rejects.toThrow();
      for (const item of [target, other]) {
        if (item === other)
          await command(
            "new-session",
            "-d",
            "-s",
            workspaceSessionName(item),
            "-c",
            tempDir,
          );
        for (const [key, value] of Object.entries({
          WCT_MAIN_DIR: tempDir,
          WCT_WORKTREE_DIR: tempDir,
          WCT_BRANCH: item.branch,
        }))
          await command(
            "set-environment",
            "-t",
            `=${workspaceSessionName(item)}`,
            key,
            value,
          );
      }
      const original = await runBunPromise(tmux.resolveSession(target));
      expect(original?.server).toBeTruthy();
      state.unsupported = true;
      await expect(
        runBunPromise(tmux.prepareAttachment(target, "browser")),
      ).rejects.toThrow("client-environment formats");
      expect(await command("show-options", "-s")).not.toContain(
        "@wct_attachment_",
      );
      expect(await runBunPromise(tmux.listClients)).toEqual([]);
      state.unsupported = false;

      const legacy = launch();
      state.unsupported = true;
      let legacyClient: TmuxClient | undefined;
      await vi.waitFor(async () => {
        legacyClient = (await runBunPromise(tmux.listClients))[0];
        expect(legacyClient?.pid).toBe(String(legacy.pid));
      });
      const legacyOther = await runBunPromise(tmux.resolveSession(other));
      if (!legacyClient || !legacyOther?.id)
        throw new Error("Missing legacy native fixture");
      await runBunPromise(
        tmux.switchClientToPane(legacyClient, legacyOther.id),
      );
      expect((await runBunPromise(tmux.listClients))[0]?.session).toBe(
        legacyOther.name,
      );
      await runBunPromise(tmux.detachClient(legacyClient));
      await legacy.exited;
      expect(await runBunPromise(tmux.listClients)).toEqual([]);
      state.unsupported = false;

      const first = await runBunPromise(
        tmux.prepareAttachment(target, "browser"),
      ).catch((error: unknown) => {
        if (
          error instanceof Error &&
          error.message.includes("client-environment formats")
        )
          skip(
            "Installed tmux lacks managed attachment client-environment formats; native/unsupported branches were exercised",
          );
        throw error;
      });
      const second = await runBunPromise(
        tmux.prepareAttachment(target, "browser"),
      );
      const observer = await runBunPromise(
        tmux.prepareAttachment(target, "observer"),
      );
      expect(first.attachment.id).not.toBe(second.attachment.id);
      expect(first.attachment.generation).not.toBe(
        second.attachment.generation,
      );
      const native = launch();
      const firstProcess = launch(first);
      launch(second);
      launch(observer, true);
      await vi.waitFor(async () =>
        expect(
          (await runBunPromise(tmux.listClients)).filter(
            (client) => client.attachment,
          ),
        ).toHaveLength(3),
      );
      const clients = await runBunPromise(tmux.listClients);
      expect(clients.filter((client) => !client.attachment)).toHaveLength(1);
      const nativeClient = clients.find((client) => !client.attachment);
      expect(nativeClient?.pid).toBe(String(native.pid));
      const observerClient = clients.find(
        (client) => client.attachment?.id === observer.attachment.id,
      );
      expect(observerClient?.tty).toBe("");
      expect(
        await command("list-clients", "-F", "#{client_pid}:#{client_flags}"),
      ).toContain(`${observerClient?.pid}:`);

      const childScript = `
      import { Effect } from "effect";
      import { runBunPromise } from ${JSON.stringify(resolve("src/effect/runtime.ts"))};
      import { makeTmuxService, TmuxService } from ${JSON.stringify(resolve("src/services/tmux.ts"))};
      import { makeLocalObservationService } from ${JSON.stringify(resolve("src/services/local-observation-service.ts"))};
      import { withTestServices } from ${JSON.stringify(resolve("tests/helpers/services.ts"))};
      const tmux = await runBunPromise(makeTmuxService());
      const result = await runBunPromise(withTestServices(Effect.gen(function* () {
        const observations = yield* makeLocalObservationService;
        return yield* observations.clients;
      }), { tmux }));
      process.stdout.write(JSON.stringify(result));
    `;
      async function discoverInAnotherProcess(): Promise<TmuxClient[]> {
        const child = Bun.spawn([process.execPath, "-e", childScript], {
          cwd: process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PATH: `${tempDir}:${process.env.PATH}`,
            TMUX: "",
          },
        });
        const [out, err, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exit, err).toBe(0);
        return JSON.parse(out) as TmuxClient[];
      }
      expect(
        (await discoverInAnotherProcess()).map((client) => client.pid),
      ).toEqual([String(native.pid)]);
      const native2 = launch({
        ...first,
        args: ["attach-session", "-E", "-t", original?.id ?? "$0"],
        env: {
          WCT_TERMINAL_ATTACHMENT: `wct1:browser:${crypto.randomUUID()}:${crypto.randomUUID()}`,
        },
      });
      await vi.waitFor(async () =>
        expect(
          (await runBunPromise(tmux.listClients)).filter(
            (client) => !client.attachment,
          ),
        ).toHaveLength(2),
      );
      expect(await discoverInAnotherProcess()).toHaveLength(2);
      native2.kill();
      await native2.exited;

      const otherSession = await runBunPromise(tmux.resolveSession(other));
      expect(otherSession?.id).toBeTruthy();
      const switched = await runBunPromise(
        tmux.switchAttachment(first.attachment, other),
      );
      expect(switched?.session).toBe(otherSession?.name);
      expect(
        (await runBunPromise(tmux.queryAttachment(second.attachment)))?.session,
      ).toBe(original?.name);
      expect(
        (await runBunPromise(tmux.queryAttachment(first.attachment)))
          ?.sessionId,
      ).toBe(otherSession?.id);
      await command(
        "switch-client",
        "-c",
        switched?.name ?? "",
        "-t",
        original?.id ?? "",
      );
      expect(
        (await runBunPromise(tmux.queryAttachment(first.attachment)))?.session,
      ).toBe(original?.name);

      await command("suspend-client", "-t", switched?.name ?? "");
      await expect(
        runBunPromise(tmux.queryAttachment(first.attachment)),
      ).rejects.toThrow("suspended");
      await expect(
        runBunPromise(tmux.detachAttachment(first.attachment)),
      ).rejects.toThrow("suspended");
      expect(
        await command(
          "show-options",
          "-s",
          "-qv",
          `@wct_attachment_${first.attachment.id}`,
        ),
      ).toContain(first.attachment.generation);
      firstProcess.kill("SIGCONT");
      await vi.waitFor(async () =>
        expect(
          await runBunPromise(tmux.queryAttachment(first.attachment)),
        ).not.toBeNull(),
      );

      // A suspended old client and its replacement can have the same tty.
      // The visible replacement must not redirect an action to the old one.
      if (!nativeClient?.name) throw new Error("Missing native client");
      await command("suspend-client", "-t", nativeClient.name);
      const sharedTerminal = processTerminals.get(native.pid);
      if (!sharedTerminal) throw new Error("Missing native PTY");
      const shadowed = launch(undefined, false, sharedTerminal);
      let shadowedClient: TmuxClient | undefined;
      await vi.waitFor(async () => {
        shadowedClient = (await runBunPromise(tmux.listClients)).find(
          (client) => client.pid === String(shadowed.pid),
        );
        expect(shadowedClient).toBeDefined();
      });
      if (!shadowedClient) throw new Error("Missing replacement client");
      await expect(
        runBunPromise(nativeClientAction(shadowedClient, otherSession?.id)),
      ).rejects.toThrow("shadowed");
      await expect(
        runBunPromise(nativeClientAction(shadowedClient)),
      ).rejects.toThrow("shadowed");
      expect(
        (await runBunPromise(tmux.listClients)).find(
          (client) => client.pid === String(shadowed.pid),
        )?.session,
      ).toBe(original?.name);
      shadowed.kill();
      await shadowed.exited;
      native.kill("SIGCONT");
      await vi.waitFor(async () =>
        expect(
          (await runBunPromise(tmux.listClients)).some(
            (client) => client.pid === String(native.pid),
          ),
        ).toBe(true),
      );

      const racing = await runBunPromise(
        tmux.prepareAttachment(target, "browser"),
      );
      state.afterRecord = {
        key: `@wct_attachment_${racing.attachment.id}`,
        run: async () => {
          const signaled = { ...racing, args: [...racing.args] };
          signaled.args[3] =
            (signaled.args[3] ?? "") + " ; wait-for -S wct-test-bound";
          launch(signaled);
          await command("wait-for", "wct-test-bound");
        },
      };
      await expect(
        runBunPromise(tmux.detachAttachment(racing.attachment)),
      ).rejects.toThrow("raced cleanup");
      expect(
        await runBunPromise(tmux.queryAttachment(racing.attachment)),
      ).not.toBeNull();
      await runBunPromise(tmux.detachAttachment(racing.attachment));

      // Replaying a consumed launch cannot overwrite the bound connection.
      const replay = launch(first);
      await replay.exited;
      expect(
        (await runBunPromise(tmux.queryAttachment(first.attachment)))?.pid,
      ).toBe(switched?.pid);
      const staleGeneration = {
        ...first.attachment,
        generation: crypto.randomUUID(),
      };
      expect(
        await runBunPromise(tmux.queryAttachment(staleGeneration)),
      ).toBeNull();
      await runBunPromise(tmux.detachAttachment(staleGeneration));
      expect(
        await runBunPromise(tmux.queryAttachment(first.attachment)),
      ).not.toBeNull();

      // A record cannot compensate for changed live PID/creation metadata.
      state.corruptIdentity = true;
      expect(
        (await runBunPromise(tmux.listClients)).filter(
          (client) => client.attachment,
        ),
      ).toHaveLength(0);
      state.corruptIdentity = false;
      if (nativeClient) {
        await expect(
          runBunPromise(
            nativeClientAction(
              { ...nativeClient, pid: "9999999" },
              original?.id,
            ),
          ),
        ).rejects.toThrow();
        await expect(
          runBunPromise(
            nativeClientAction({ ...nativeClient, created: "1" }, original?.id),
          ),
        ).rejects.toThrow();
      }
      const staleRecord = await command(
        "show-options",
        "-s",
        "-qv",
        `@wct_attachment_${first.attachment.id}`,
      );
      await runBunPromise(tmux.detachAttachment(first.attachment));
      await firstProcess.exited;
      expect(
        await runBunPromise(tmux.queryAttachment(first.attachment)),
      ).toBeNull();
      expect(await runBunPromise(tmux.resolveSession(target))).not.toBeNull();
      // A native replacement remains unmanaged even when an old record survives.
      await command(
        "set-option",
        "-s",
        `@wct_attachment_${first.attachment.id}`,
        staleRecord,
      );
      const replacement = launch();
      await vi.waitFor(async () =>
        expect(
          (await runBunPromise(tmux.listClients)).filter(
            (client) => !client.attachment,
          ),
        ).toHaveLength(2),
      );
      await runBunPromise(tmux.detachAttachment(first.attachment));
      expect(
        (await runBunPromise(tmux.listClients)).some(
          (client) => client.pid === String(replacement.pid),
        ),
      ).toBe(true);

      // PID reuse can conservatively prevent stale-record cleanup, but never
      // makes an unmarked native connection a managed client.
      const reusedPidRecord = staleRecord.split("\t");
      reusedPidRecord[4] = String(replacement.pid);
      await command(
        "set-option",
        "-s",
        `@wct_attachment_${first.attachment.id}`,
        reusedPidRecord.join("\t"),
      );
      await expect(
        runBunPromise(tmux.queryAttachment(first.attachment)),
      ).rejects.toThrow("unavailable");
      await expect(
        runBunPromise(tmux.detachAttachment(first.attachment)),
      ).rejects.toThrow("unavailable");
      expect(
        (await runBunPromise(tmux.listClients)).find(
          (client) => client.pid === String(replacement.pid),
        )?.attachment,
      ).toBeUndefined();

      await command("kill-server");
      await command("new-session", "-d", "-s", "replacement");
      const obsoleteLaunch = launch(second);
      await obsoleteLaunch.exited;
      expect(await runBunPromise(tmux.listClients)).toEqual([]);
      expect(await command("show-options", "-s")).not.toContain(
        "@wct_attachment_",
      );
      expect(
        await runBunPromise(tmux.queryAttachment(second.attachment)),
      ).toBeNull();
      await expect(
        runBunPromise(tmux.switchAttachment(second.attachment, target)),
      ).rejects.toThrow();
      await runBunPromise(tmux.detachAttachment(second.attachment));
      expect(await command("has-session", "-t", "replacement")).toBe("");
    } finally {
      state.corruptIdentity = false;
      state.unsupported = false;
      state.afterRecord = undefined;
      for (const child of processes) {
        child.kill("SIGCONT");
        child.kill();
      }
      await Promise.all(processes.map((child) => child.exited));
      for (const terminal of terminals) terminal.close();
      await command("kill-server").catch(() => undefined);
      state.executable = "";
    }
  },
  30_000,
);
