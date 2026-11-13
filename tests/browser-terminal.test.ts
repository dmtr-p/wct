import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import {
  boundedJson,
  LocalAuth,
  validRequestAuthority,
} from "../src/browser/auth";
import {
  decode,
  decodeFrame,
  encodeFrame,
  LocalDimensions,
  type LocalHeader,
  policy,
} from "../src/browser/protocol";
import { startLocalTerminal } from "../src/browser/server";
import { runBunPromise } from "../src/effect/runtime";
import { workspaceSessionName } from "../src/services/session-identity";
import { makeTmuxService } from "../src/services/tmux";
import { test } from "./helpers/temp-dir";

const isolated = vi.hoisted(() => ({ executable: "" }));
vi.mock("../src/services/process", async () => {
  const actual = await vi.importActual<
    typeof import("../src/services/process")
  >("../src/services/process");
  const { Effect } = await import("effect");
  return {
    ...actual,
    execProcess: (
      command: string,
      args: string[],
      options?: import("../src/services/process").ProcessOptions,
    ) => {
      if (command !== "tmux") return actual.execProcess(command, args, options);
      if (!isolated.executable)
        return Effect.die(new Error("Missing isolated tmux fixture"));
      return actual.execProcess(isolated.executable, args, options);
    },
  };
});
// The browser entry enables lib.dom; retain Bun's documented headers extension here.
const Socket = WebSocket as unknown as {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const request = (host: string, origin?: string) =>
  new Request(`http://${host}/`, {
    headers: { host, ...(origin === undefined ? {} : { origin }) },
  });

describe("local browser authentication", () => {
  test("cancels a blocked body reader on shutdown without waiting for its deadline", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const request = new Request("http://127.0.0.1/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
    });
    const reading = boundedJson(request, controller.signal);
    controller.abort();
    await expect(reading).rejects.toThrow("HTTP body deadline exceeded");
    expect(cancelled).toBe(true);
  });
  test("uses a one-use secret, server-specific host-only cookie and absolute expiry", () => {
    let clock = 10;
    const auth = new LocalAuth(() => clock);
    expect(Buffer.from(auth.bootstrap, "base64url")).toHaveLength(32);
    const cookie = auth.exchange(auth.bootstrap);
    expect(cookie).toMatch(/; HttpOnly; SameSite=Strict; Path=\//);
    expect(cookie).not.toContain("Domain=");
    const req = new Request("http://127.0.0.1/", {
      headers: { cookie: cookie?.split(";")[0] ?? "" },
    });
    expect(auth.owner(req)).toBeTruthy();
    expect(auth.exchange(auth.bootstrap)).toBeUndefined();
    clock += policy.sessionMs - 1;
    expect(auth.owner(req)).toBeTruthy();
    clock++;
    expect(auth.owner(req)).toBeUndefined();
    expect(new LocalAuth().cookieName).not.toBe(auth.cookieName);
  });
  test("bounds failed exchanges and expires bootstrap without extending it", () => {
    let clock = 0;
    const auth = new LocalAuth(() => clock);
    for (let i = 0; i < 10; i++) expect(auth.exchange("bad")).toBeUndefined();
    expect(auth.exchange(auth.bootstrap)).toBeUndefined();
    clock = 60_000;
    expect(auth.exchange(auth.bootstrap)).toBeTruthy();
    const expired = new LocalAuth(() => clock);
    clock += policy.bootstrapMs;
    expect(expired.exchange(expired.bootstrap)).toBeUndefined();
  });
  test("rejects foreign, absent, null and malformed privileged origins and nonexact hosts", () => {
    const host = "127.0.0.1:1234";
    expect(
      validRequestAuthority(request(host, `http://${host}`), host, true),
    ).toBe(true);
    for (const origin of [
      undefined,
      "null",
      "http://localhost:1234",
      "http://127.0.0.1:1235",
      `http://${host}/`,
      `http://${host}.evil`,
      "https://127.0.0.1:1234",
      "broken",
    ]) {
      expect(validRequestAuthority(request(host, origin), host, true)).toBe(
        false,
      );
    }
    expect(validRequestAuthority(request(host), host, false)).toBe(true);
    for (const value of [
      "localhost:1234",
      "127.0.0.1",
      "127.0.0.1:01234",
      "[::1]:1234",
    ])
      expect(
        validRequestAuthority(request(value, `http://${host}`), host, true),
      ).toBe(false);
  });
  test("bounds declared and streamed bodies, dimensions and binary frames", async () => {
    const body = (text: string, headers = {}) =>
      new Request("http://127.0.0.1/", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: text,
      });
    await expect(boundedJson(body('{"ok":true}'))).resolves.toEqual({
      ok: true,
    });
    await expect(
      boundedJson(
        body("x", { "content-length": String(policy.controlBytes + 1) }),
      ),
    ).rejects.toThrow();
    await expect(
      boundedJson(body("x".repeat(policy.controlBytes + 1))),
    ).rejects.toThrow();
    for (const dimensions of [
      { cols: 0, rows: 1 },
      { cols: 501, rows: 1 },
      { cols: 1, rows: 201 },
      { cols: 1.5, rows: 2 },
      { cols: 80, rows: 24, extra: true },
    ])
      expect(() => decode(LocalDimensions, dimensions)).toThrow();
    expect(decode(LocalDimensions, { cols: 500, rows: 200 })).toEqual({
      cols: 500,
      rows: 200,
    });
    expect(() => decodeFrame(new Uint8Array(3))).toThrow();
    const oversizedHeader = new Uint8Array(4);
    new DataView(oversizedHeader.buffer).setUint32(0, policy.controlBytes + 1);
    expect(() => decodeFrame(oversizedHeader)).toThrow();
  });
});

test("malformed bootstrap bodies count toward the bounded failure limit", async () => {
  const endpoint = await startLocalTerminal({
    env: {},
    backend: {
      prepare: async () => {
        throw new Error("No launch expected");
      },
      query: async () => null,
      detach: async () => {},
      verify: async () => {
        throw new Error("No target");
      },
    },
  });
  try {
    const origin = new URL(endpoint.url).origin;
    const post = (body: string) =>
      fetch(new URL("/api/bootstrap", endpoint.url), {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body,
      });
    for (let count = 0; count < 10; count++)
      expect((await post("{")).status).toBe(400);
    expect(
      (
        await post(
          JSON.stringify({
            secret: new URL(endpoint.bootstrapUrl).hash.slice(1),
          }),
        )
      ).status,
    ).toBe(403);
  } finally {
    await endpoint.stop();
  }
});

const tmuxPath = Bun.which("tmux");
test.skipIf(!tmuxPath)(
  "real Bun PTY/WebSocket attachments coexist with native clients and clean up without stopping workloads",
  async ({ tempDir, skip }) => {
    const socket = join(tempDir, "tmux.sock");
    const executable = join(tempDir, "tmux");
    await Bun.write(
      executable,
      `#!/bin/sh\nexec ${quote(tmuxPath ?? "")} -S ${quote(socket)} -f /dev/null "$@"\n`,
    );
    await chmod(executable, 0o755);
    isolated.executable = executable;
    async function command(...args: string[]) {
      const child = Bun.spawn([executable, ...args], {
        env: { ...process.env, TMUX: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code) throw new Error(err);
      return out.trim();
    }
    const target = {
      mainRepoPath: tempDir,
      worktreePath: tempDir,
      branch: "main",
    };
    let endpoint: Awaited<ReturnType<typeof startLocalTerminal>> | undefined;
    const sockets: WebSocket[] = [];
    let native: Bun.Subprocess | undefined;
    let nativeTerminal: Bun.Terminal | undefined;
    let clock = Date.now();
    const launched: Bun.Subprocess[] = [];
    try {
      const tmux = await runBunPromise(makeTmuxService());
      await runBunPromise(
        tmux.createSession(workspaceSessionName(target), tempDir, undefined, {
          WCT_MAIN_DIR: tempDir,
          WCT_WORKTREE_DIR: tempDir,
          WCT_BRANCH: "main",
          WCT_WORK_DIR: tempDir,
          WCT_PROJECT: "fixture",
        }),
      );
      let probe;
      try {
        probe = await runBunPromise(tmux.prepareAttachment(target, "browser"));
      } catch (error) {
        if (String(error).includes("V/c")) {
          skip(true, "Live tmux lacks client-environment format capability");
          return;
        }
        throw error;
      }
      await runBunPromise(tmux.detachAttachment(probe.attachment));
      const session = await runBunPromise(
        tmux.resolveSession(target, undefined, { readOnly: true }),
      );
      if (!session?.id || !session.server)
        throw new Error("Missing verified fixture session");
      endpoint = await startLocalTerminal({
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH}`,
          TMUX: "",
        },
        now: () => clock,
        backend: {
          prepare: () =>
            runBunPromise(tmux.prepareAttachment(target, "browser")),
          query: (ref) => runBunPromise(tmux.queryAttachment(ref)),
          detach: (ref) => runBunPromise(tmux.detachAttachment(ref)),
          verify: async (client) => {
            const current = await runBunPromise(
              tmux.resolveSession(target, session, { readOnly: true }),
            );
            if (
              client.sessionId !== current?.id ||
              client.server !== current?.server
            )
              throw new Error("Wrong target");
            return {
              ...target,
              server: session.server ?? "",
              sessionId: session.id ?? "",
            };
          },
        },
      });
      const url = endpoint.url;
      const origin = new URL(url).origin;
      const post = (path: string, body: unknown, cookie = "", headers = {}) =>
        fetch(new URL(path, url), {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            cookie,
            ...headers,
          },
          body: JSON.stringify(body),
        });
      expect((await fetch(url)).status).toBe(200);
      expect((await fetch(new URL("/src/index.ts", url))).status).toBe(404);
      expect(
        (
          await post("/api/bootstrap", { secret: "bad" }, "", {
            origin: "null",
          })
        ).status,
      ).toBe(403);
      const bootstrap = await post("/api/bootstrap", {
        secret: new URL(endpoint.bootstrapUrl).hash.slice(1),
      });
      expect(bootstrap.status).toBe(204);
      const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
      expect(
        (
          await post("/api/bootstrap", {
            secret: new URL(endpoint.bootstrapUrl).hash.slice(1),
          })
        ).status,
      ).toBe(403);
      expect(
        (await post("/api/attachments", { dimensions: { cols: 80, rows: 24 } }))
          .status,
      ).toBe(401);
      expect(
        (
          await post(
            "/api/attachments",
            { dimensions: { cols: 501, rows: 24 } },
            cookie,
          )
        ).status,
      ).toBe(400);
      nativeTerminal = new Bun.Terminal({ cols: 80, rows: 24, data() {} });
      native = Bun.spawn([executable, "attach-session", "-t", session.id], {
        terminal: nativeTerminal,
        env: { ...process.env, TMUX: "", TERM: "xterm-256color" },
      });
      launched.push(native);
      const create = async () => {
        const response = await post(
          "/api/attachments",
          { dimensions: { cols: 80, rows: 24 } },
          cookie,
        );
        expect(response.status).toBe(201);
        return response.json() as Promise<{
          ref: LocalHeader["ref"];
          target: import("../src/browser/protocol").LocalTarget;
        }>;
      };
      const [first, second] = await Promise.all([create(), create()]);
      expect(first.ref.attachmentId).not.toBe(second.ref.attachmentId);
      expect(
        (
          await post(
            "/api/tickets",
            { ref: { ...first.ref, generation: second.ref.generation } },
            cookie,
          )
        ).status,
      ).toBe(409);
      const issue = async (ref: LocalHeader["ref"]) => {
        const res = await post("/api/tickets", { ref }, cookie);
        expect(res.status).toBe(201);
        return res.json() as Promise<{
          ticket: string;
          streamId: LocalHeader["streamId"];
        }>;
      };
      const superseded = await issue(first.ref);
      const fresh = await issue(first.ref);
      const wsUrl = (key: string) =>
        `${url.replace("http:", "ws:")}terminal?ticket=${key}`;
      const reject = (key: string, auth = cookie, from = origin) =>
        new Promise<void>((resolve, reject) => {
          const ws = new Socket(wsUrl(key), {
            headers: { cookie: auth, origin: from },
          });
          sockets.push(ws);
          ws.onopen = () => reject(new Error("Unexpected accepted socket"));
          ws.onerror = () => resolve();
        });
      await reject(superseded.ticket);
      await reject(fresh.ticket, "");
      await reject(fresh.ticket, cookie, "http://foreign.example");
      const frames: LocalHeader[][] = [[], []];
      const output: string[] = ["", ""];
      async function open(
        attachment: typeof first,
        ticket: typeof fresh,
        index: number,
      ) {
        return new Promise<WebSocket>((resolve, reject) => {
          const ws = new Socket(wsUrl(ticket.ticket), {
            headers: { cookie, origin },
          });
          sockets.push(ws);
          ws.binaryType = "arraybuffer";
          ws.onerror = () => reject(new Error("WebSocket failed"));
          ws.onmessage = (event) => {
            if (!(event.data instanceof ArrayBuffer)) return;
            const { header, bytes } = decodeFrame(new Uint8Array(event.data));
            frames[index]?.push(header);
            if (header.kind === "target") {
              if (frames[index]?.length === 1) {
                expect(header.target).toEqual(attachment.target);
                resolve(ws);
              }
            }
            if (header.kind === "output")
              output[index] += new TextDecoder().decode(bytes);
          };
        });
      }
      const one = await open(first, fresh, 0);
      const two = await open(second, await issue(second.ref), 1);
      await reject(fresh.ticket);
      const send = (
        ws: WebSocket,
        a: typeof first,
        streamId: LocalHeader["streamId"],
        text: string,
        sequence = 0,
      ) => {
        const bytes = new TextEncoder().encode(text);
        ws.send(
          encodeFrame(
            {
              kind: "input",
              ref: a.ref,
              streamId,
              sequence,
              byteLength: bytes.length,
            },
            bytes,
          ),
        );
      };
      send(one, first, fresh.streamId, "printf 'WCT_BROWSER_342\\n'\r");
      await vi.waitFor(() => expect(output[0]).toContain("WCT_BROWSER_342"));
      await vi.waitFor(() => expect(output[1]).toContain("WCT_BROWSER_342"));
      const clients = await runBunPromise(tmux.listClients);
      expect(
        clients.filter((client) => client.attachment?.kind === "browser"),
      ).toHaveLength(2);
      expect(
        clients
          .filter((client) => !client.attachment)
          .map((client) => client.pid),
      ).toContain(String(native.pid));
      expect(frames[0]?.[0]?.kind).toBe("target");
      frames[0]?.forEach((frame, index) => expect(frame.sequence).toBe(index));
      const other = await command(
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{session_id}",
        "-s",
        "native-navigation",
        "-c",
        tempDir,
      );
      await command("bind-key", "n", "switch-client", "-t", other);
      // A native prefix switch and later bytes in one write have normal tmux
      // semantics. Only the stream/attachment, not an expected session, is fenced.
      send(one, first, fresh.streamId, "\x02nprintf 'RAW_SWITCH_OK\\n'\r", 1);
      await vi.waitFor(() =>
        expect(
          frames[0]?.some(
            (frame) =>
              frame.kind === "target" && frame.target.sessionId === other,
          ),
        ).toBe(true),
      );
      await vi.waitFor(async () =>
        expect(await command("capture-pane", "-p", "-t", other)).toContain(
          "RAW_SWITCH_OK",
        ),
      );
      expect(one.readyState).toBe(WebSocket.OPEN);
      expect(output[1]).not.toContain("RAW_SWITCH_OK");
      send(one, { ...first, ref: second.ref }, fresh.streamId, "echo BAD\r", 2);
      await vi.waitFor(() => expect(one.readyState).toBe(WebSocket.CLOSED));
      expect(two.readyState).toBe(WebSocket.OPEN);
      expect(await command("has-session", "-t", session.id)).toBe("");
      const suspended = await runBunPromise(
        tmux.queryAttachment({
          id: second.ref.attachmentId,
          generation: second.ref.generation,
          kind: "browser",
          server: second.ref.server,
        }),
      );
      if (!suspended?.pid) throw new Error("Missing owned tmux client");
      await command("suspend-client", "-t", suspended.name ?? suspended.tty);
      process.kill(Number(suspended.pid), "SIGSTOP");
      clock += policy.sessionMs;
      await vi.waitFor(() => expect(two.readyState).toBe(WebSocket.CLOSED), {
        timeout: 4000,
      });
      await endpoint.stop();
      endpoint = undefined;
      expect(() => process.kill(Number(suspended.pid), 0)).toThrow();
      const remaining = await runBunPromise(tmux.listClients);
      expect(remaining.filter((client) => client.attachment)).toHaveLength(0);
      expect(
        remaining.some((client) => client.pid === String(native?.pid)),
      ).toBe(true);
      expect(await command("has-session", "-t", session.id)).toBe("");
    } finally {
      for (const ws of sockets) ws.close();
      await endpoint?.stop();
      for (const child of launched) {
        child.kill();
        await child.exited;
      }
      nativeTerminal?.close();
      await command("kill-server").catch(() => {});
      isolated.executable = "";
    }
  },
  30_000,
);

test("HTTP security and pending launch limits do not depend on tmux capability", async () => {
  let pending = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const endpoint = await startLocalTerminal({
    env: {},
    backend: {
      prepare: async () => {
        pending++;
        await gate;
        throw new Error("Unsupported fixture capability");
      },
      query: async () => null,
      detach: async () => {},
      verify: async () => {
        throw new Error("No target");
      },
    },
  });
  const origin = new URL(endpoint.url).origin;
  const post = (path: string, body: unknown, cookie = "", extra = {}) =>
    fetch(new URL(path, endpoint.url), {
      method: "POST",
      headers: { origin, "content-type": "application/json", cookie, ...extra },
      body: JSON.stringify(body),
    });
  let launches: Promise<Response>[] = [];
  try {
    const secret = new URL(endpoint.bootstrapUrl).hash.slice(1);
    for (const from of ["null", "http://foreign.example", `${origin}/`])
      expect(
        (await post("/api/bootstrap", { secret }, "", { origin: from })).status,
      ).toBe(403);
    const paired = await post("/api/bootstrap", { secret });
    expect(paired.status).toBe(204);
    const cookie = paired.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(
      (await post("/api/attachments", { dimensions: { cols: 80, rows: 24 } }))
        .status,
    ).toBe(401);
    expect(
      (
        await post(
          "/api/attachments",
          { dimensions: { cols: 80, rows: 24 }, shell: "evil" },
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (await fetch(endpoint.url, { headers: { host: "localhost:1234" } }))
        .status,
    ).toBe(403);
    launches = Array.from({ length: policy.maxAttachments }, () =>
      post("/api/attachments", { dimensions: { cols: 80, rows: 24 } }, cookie),
    );
    await vi.waitFor(() => expect(pending).toBe(policy.maxAttachments));
    expect(
      (
        await post(
          "/api/attachments",
          { dimensions: { cols: 80, rows: 24 } },
          cookie,
        )
      ).status,
    ).toBe(429);
    release();
    for (const result of await Promise.all(launches))
      expect(result.status).toBe(400);
    expect(
      (
        await post(
          "/api/attachments",
          { dimensions: { cols: 80, rows: 24 } },
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(pending).toBe(policy.maxAttachments + 1);
  } finally {
    release();
    await Promise.allSettled(launches);
    await endpoint.stop();
  }
});

test("shutdown retains pending preparation until its late handle can be detached without spawning", async () => {
  const ref = {
    id: "11111111-1111-4111-8111-111111111111",
    generation: "22222222-2222-4222-8222-222222222222",
    kind: "browser" as const,
    server: "/tmp/fixture|1|2",
  };
  let prepared = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const detach = vi.fn(async () => {});
  const query = vi.fn(async () => null);
  const endpoint = await startLocalTerminal({
    env: {},
    backend: {
      prepare: async () => {
        prepared = true;
        await gate;
        return { attachment: ref, command: "tmux", args: [], env: {} };
      },
      query,
      detach,
      verify: async () => {
        throw new Error("No target expected");
      },
    },
  });
  const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("No child may be started during shutdown");
  });
  let creation: Promise<Response> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    const origin = new URL(endpoint.url).origin;
    const bootstrap = await fetch(new URL("/api/bootstrap", endpoint.url), {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        secret: new URL(endpoint.bootstrapUrl).hash.slice(1),
      }),
    });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
    creation = fetch(new URL("/api/attachments", endpoint.url), {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({ dimensions: { cols: 80, rows: 24 } }),
    });
    await vi.waitFor(() => expect(prepared).toBe(true));
    let stopped = false;
    stopping = endpoint.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(detach).not.toHaveBeenCalled();
    release();
    expect((await creation).status).toBe(400);
    await stopping;
    expect(detach).toHaveBeenCalledExactlyOnceWith(ref);
    expect(query).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    release();
    await creation?.catch(() => {});
    await stopping;
    await endpoint.stop();
    spawn.mockRestore();
  }
});
