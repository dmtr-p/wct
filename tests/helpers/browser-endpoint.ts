import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import {
  decodeFrame,
  type LocalRef,
  type LocalTarget,
} from "../../src/browser/protocol";
import { startLocalTerminal } from "../../src/browser/server";
import type { TerminalAttachment } from "../../src/services/terminal-attachments";

const Socket = WebSocket as unknown as {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};
/** Real Bun PTY/HTTP/WS with a deterministic process; tmux ownership has a separate live fixture. */
export async function browserEndpoint(
  tempDir: string,
  options: {
    now?: () => number;
    prepare?: () => Promise<void>;
    query?: () => Promise<void>;
    ignoreTerm?: boolean;
    quiet?: boolean;
    unavailableDetach?: boolean;
  } = {},
) {
  const script = join(tempDir, "terminal.ts");
  const executable = join(tempDir, "tmux");
  await Bun.write(
    script,
    `
await Bun.write(process.argv[2], String(process.pid));
process.stdin.setRawMode(true);
${options.ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
let read = 0;
process.on("SIGUSR1", () => process.stdout.write(Buffer.alloc(32 * 1024 * 1024, 120)));
process.stdin.on("data", bytes => {
  if (bytes.toString().includes("FLOOD")) process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 120));
  else ${options.quiet ? '{ read += bytes.length; process.stdout.write("READ:" + read + "\\n"); }' : "process.stdout.write(bytes);"}
});
process.stdin.resume();
`,
  );
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  await Bun.write(
    executable,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
  );
  await chmod(executable, 0o755);
  const ids: string[] = [];
  const pids = new Map<string, number>();
  const diagnostics: string[] = [];
  const initialTarget = {
    server: "/tmp/fixture|1|2",
    sessionId: "$1",
    mainRepoPath: tempDir,
    worktreePath: tempDir,
    branch: "main",
  };
  const detach = vi.fn(async (ref: TerminalAttachment) => {
    if (options.unavailableDetach)
      throw new Error("Unavailable/suspended client");
    const pid = pids.get(ref.id);
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  });
  const endpoint = await startLocalTerminal({
    now: options.now,
    env: { ...process.env, PATH: `${tempDir}:${process.env.PATH}` },
    diagnostic: (message) => diagnostics.push(message),
    backend: {
      prepare: async () => {
        await options.prepare?.();
        const id = randomUUID();
        ids.push(id);
        return {
          attachment: {
            id,
            generation: randomUUID(),
            kind: "browser",
            server: initialTarget.server,
          },
          command: "tmux",
          args: [join(tempDir, `${id}.pid`)],
          env: {},
        };
      },
      query: async (ref) => {
        await options.query?.();
        const file = Bun.file(join(tempDir, `${ref.id}.pid`));
        if (!(await file.exists())) return null;
        const pid = Number(await file.text());
        pids.set(ref.id, pid);
        return {
          tty: "/dev/fixture",
          server: initialTarget.server,
          sessionId: "$1",
          session: "fixture",
          pid: String(pid),
        };
      },
      detach,
      verify: async () => initialTarget,
    },
  });
  const origin = new URL(endpoint.url).origin;
  const post = (path: string, body: unknown, auth = cookie) =>
    fetch(new URL(path, endpoint.url), {
      method: "POST",
      headers: { origin, cookie: auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  let cookie = "";
  const auth = await post("/api/bootstrap", {
    secret: new URL(endpoint.bootstrapUrl).hash.slice(1),
  });
  expect(auth.status).toBe(204);
  cookie = auth.headers.get("set-cookie")?.split(";")[0] ?? "";
  const sockets: WebSocket[] = [];
  const create = async () => {
    const response = await post("/api/attachments", {
      dimensions: { cols: 80, rows: 24 },
    });
    expect(response.status).toBe(201);
    return response.json() as Promise<{ ref: LocalRef; target: LocalTarget }>;
  };
  const ticket = async (ref: LocalRef) => {
    const response = await post("/api/tickets", { ref });
    expect(response.status).toBe(201);
    return response.json() as Promise<{ ticket: string; streamId: string }>;
  };
  const connect = (key: string) => {
    const ws = new Socket(
      `${endpoint.url.replace("http:", "ws:")}terminal?ticket=${key}`,
      { headers: { cookie, origin } },
    );
    ws.binaryType = "arraybuffer";
    sockets.push(ws);
    return ws;
  };
  const open = async (key: string) => {
    const ws = connect(key);
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (event) => {
        const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
        if (frame.header.kind === "target") resolve();
      };
      ws.onerror = () => reject(new Error("Expected accepted stream"));
    });
    return ws;
  };
  return {
    ...endpoint,
    ids,
    pids,
    detach,
    diagnostics,
    origin,
    cookie,
    post,
    create,
    ticket,
    connect,
    open,
    async dispose() {
      sockets.forEach((ws) => ws.close());
      await endpoint.stop();
    },
  };
}
