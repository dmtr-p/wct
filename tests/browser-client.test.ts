import { afterEach, expect, vi } from "vitest";
import {
  decode,
  decodeFrame,
  encodeFrame,
  type LocalHeader,
  LocalRef,
  policy,
} from "../src/browser/protocol";
import { test } from "./helpers/temp-dir";

const state = vi.hoisted(() => ({
  options: { disableStdin: true },
  cols: 80,
  rows: 24,
  resized: [] as number[][],
  disposed: 0,
  resize: () => {},
  writes: [] as { bytes: Uint8Array; done: () => void }[],
  data: (_text: string) => {},
  binary: (_text: string) => {},
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = state.cols;
    rows = state.rows;
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      state.resized.push([cols, rows]);
    }
    options = state.options;
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {
      state.disposed++;
    }
    onData(callback: (text: string) => void) {
      state.data = callback;
    }
    onBinary(callback: (text: string) => void) {
      state.binary = callback;
    }
    write(bytes: Uint8Array, done: () => void) {
      state.writes.push({ bytes, done });
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() {
      return { cols: state.cols, rows: state.rows };
    }
  },
}));

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function client() {
  vi.resetModules();
  state.options.disableStdin = true;
  state.writes = [];
  state.resized = [];
  state.disposed = 0;
  const ref = decode(LocalRef, {
    endpoint: "local",
    attachmentId: "11111111-1111-4111-8111-111111111111",
    generation: "22222222-2222-4222-8222-222222222222",
    server: "fixture",
  });
  const target = {
    server: "fixture",
    sessionId: "$1",
    mainRepoPath: "/repo",
    worktreePath: "/repo",
    branch: "main",
  };
  const streamId = "33333333-3333-4333-8333-333333333333";
  const status = { textContent: "" };
  const order: string[] = [];
  const urls: string[] = [];
  const replace = vi.fn(() => {
    order.push("clear-fragment");
  });
  vi.stubGlobal("location", {
    hash: "#private-bootstrap",
    pathname: "/",
    href: "http://127.0.0.1:1234/#private-bootstrap",
  });
  vi.stubGlobal("history", { replaceState: replace });
  vi.stubGlobal("document", {
    getElementById: (id: string) => (id === "status" ? status : {}),
  });
  vi.stubGlobal("window", {
    addEventListener: (_event: string, fn: () => void) => cleanup.push(fn),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(fn: () => void) {
        state.resize = fn;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit) => {
      order.push(path);
      expect(options.credentials).toBe("same-origin");
      if (path === "/api/bootstrap") {
        expect(options.body).toBe(
          JSON.stringify({ secret: "private-bootstrap" }),
        );
        return new Response(null, { status: 204 });
      }
      if (typeof options.body !== "string")
        throw new Error("Expected JSON body");
      return Response.json(
        path === "/api/attachments"
          ? {
              ref,
              target,
              policy,
              dimensions: JSON.parse(options.body).dimensions,
            }
          : { ticket: "one-use-ticket", streamId, expiresAt: 30000 },
      );
    }),
  );
  class Socket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    binaryType = "";
    onmessage?: (event: { data: ArrayBuffer }) => void;
    onclose?: (event: { reason: string }) => void;
    onerror?: () => void;
    sent: (Uint8Array | string)[] = [];
    constructor(url: URL) {
      urls.push(String(url));
      sockets.push(this);
    }
    send(bytes: Uint8Array | string) {
      this.sent.push(bytes);
    }
    close() {
      this.readyState = 3;
    }
  }
  const sockets: Socket[] = [];
  vi.stubGlobal("WebSocket", Socket);
  await import("../src/browser/client/main");
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0];
  if (!socket) throw new Error("Missing browser socket");
  let sequence = 0;
  const send = (
    kind: "target" | "output",
    current = target,
    bytes = new Uint8Array(),
  ) => {
    const frame = encodeFrame(
      {
        ref,
        streamId,
        kind,
        target: current,
        sequence: sequence++,
        byteLength: bytes.length,
      } as LocalHeader,
      bytes,
    );
    socket.onmessage?.({ data: frame.buffer });
  };
  return { ref, target, socket, sockets, send, status, order, urls };
}

test("clears bootstrap fragment before exchange and accepts ordered native target observations", async () => {
  const c = await client();
  expect(c.order).toEqual([
    "clear-fragment",
    "/api/bootstrap",
    "/api/attachments",
    "/api/tickets",
  ]);
  expect(c.urls).toEqual([
    "ws://127.0.0.1:1234/terminal?ticket=one-use-ticket",
  ]);
  c.send("target");
  expect(state.options.disableStdin).toBe(false);
  c.send("target", { ...c.target, sessionId: "$2", branch: "other" });
  expect(c.status.textContent).toContain("other");
  state.data("\x02nhello");
  expect(
    c.socket.sent.filter(
      (frame) =>
        typeof frame !== "string" && decodeFrame(frame).header.kind === "input",
    ),
  ).toHaveLength(1);
  c.send(
    "output",
    { ...c.target, sessionId: "$2", branch: "other" },
    new Uint8Array([65]),
  );
  expect(state.writes).toHaveLength(1);
  c.socket.onclose?.({
    reason: "Input budget exhausted; reload for a fresh attachment",
  });
  expect(c.status.textContent).toContain("Input budget exhausted");
});

test("bounds retained full renderer frames and does not credit before xterm callbacks", async () => {
  const c = await client();
  c.send("target");
  // One-byte views retain long JSON headers too; payload-only accounting would
  // admit these frames well beyond the advertised memory cap.
  const target = {
    ...c.target,
    mainRepoPath: `/${"x".repeat(3500)}`,
    worktreePath: `/${"y".repeat(3500)}`,
  };
  c.send("target", target);
  expect(c.socket.readyState).toBe(1);
  c.send("output", target, new Uint8Array([65]));
  expect(state.writes).toHaveLength(1);
  for (let i = 0; i < 180 && c.socket.readyState === 1; i++)
    c.send("output", target, new Uint8Array([65]));
  expect(c.socket.readyState).toBe(3);
  expect(state.writes.length).toBeLessThan(180);
  expect(c.status.textContent).toContain("stream rejected");
});

test("render callbacks release credit; socket input and oversized paste fail closed", async () => {
  const c = await client();
  c.send("target");
  for (let i = 0; i < 300; i++) {
    c.send("output", c.target, new Uint8Array([65]));
    state.writes.at(-1)?.done();
  }
  expect(c.socket.readyState).toBe(1);
  c.socket.bufferedAmount = policy.inputBytes;
  state.data("x");
  expect(
    c.socket.sent.filter(
      (frame) =>
        typeof frame !== "string" && decodeFrame(frame).header.kind === "input",
    ),
  ).toHaveLength(0);
  expect(c.socket.readyState).toBe(3);
  const next = await client();
  next.send("target");
  state.data("x".repeat(policy.inputBytes));
  expect(
    next.socket.sent.filter(
      (frame) =>
        typeof frame !== "string" && decodeFrame(frame).header.kind === "input",
    ),
  ).toHaveLength(0);
  expect(next.status.textContent).toContain("paste exceeds");
});

test("initial renderer grid matches bounded PTY dimensions on oversized containers", async () => {
  state.cols = 800;
  state.rows = 300;
  try {
    const c = await client();
    expect(state.resized).toEqual([[500, 200]]);
    c.send("target");
    expect(c.socket.readyState).toBe(1);
  } finally {
    state.cols = 80;
    state.rows = 24;
  }
});

test("cumulative renderer ACK waits for actual xterm consumption and has its own sequence space", async () => {
  const c = await client();
  c.send("target");
  c.socket.sent = [];
  c.send("output", c.target, new Uint8Array([65]));
  c.send("output", c.target, new Uint8Array([66]));
  expect(c.socket.sent).toHaveLength(0);
  state.writes[1]?.done();
  expect(c.socket.sent).toHaveLength(0);
  state.writes[0]?.done();
  expect(c.socket.sent).toHaveLength(1);
  const ack = c.socket.sent[0];
  if (typeof ack === "string" || !ack) throw new Error("Missing binary ACK");
  expect(decodeFrame(ack).header).toMatchObject({
    kind: "ack",
    sequence: 2,
    byteLength: 0,
  });
  state.data("x");
  const input = c.socket.sent[1];
  if (typeof input === "string" || !input) throw new Error("Missing input");
  expect(decodeFrame(input).header).toMatchObject({
    kind: "input",
    sequence: 0,
  });
});

test("fresh reconnect disposes the old screen and fences late socket and renderer callbacks", async () => {
  const c = await client();
  c.send("target");
  c.send("output", c.target, new Uint8Array([65]));
  const oldRender = state.writes[0]?.done;
  const oldInput = state.data;
  const sent = c.socket.sent.length;
  vi.useFakeTimers();
  c.socket.onclose?.({ reason: "Connection lost" });
  oldRender?.();
  oldInput("stale");
  expect(c.socket.sent).toHaveLength(sent);
  await vi.advanceTimersByTimeAsync(policy.reconnectMinMs * 1.3);
  expect(c.sockets).toHaveLength(2);
  expect(state.disposed).toBe(1);
  expect(state.options.disableStdin).toBe(true);
  const request = vi
    .mocked(fetch)
    .mock.calls.filter(([path]) => path === "/api/attachments")[1];
  const body = request?.[1]?.body;
  if (typeof body !== "string") throw new Error("Missing JSON body");
  expect(JSON.parse(body)).toEqual({
    dimensions: { cols: 80, rows: 24 },
    reconnect: c.ref,
  });
  c.send("target", { ...c.target, branch: "stale" });
  expect(state.options.disableStdin).toBe(true);
});

test("live fit sends an ordered resize with input watermark and waits before changing the grid", async () => {
  const c = await client();
  c.send("target");
  c.socket.sent = [];
  vi.useFakeTimers();
  state.cols = 100;
  state.rows = 30;
  try {
    state.resize();
    await vi.advanceTimersByTimeAsync(100);
    const resize = c.socket.sent[0];
    expect(typeof resize).toBe("string");
    expect(JSON.parse(String(resize))).toMatchObject({
      kind: "resize",
      controlSequence: 0,
      throughInput: null,
      dimensions: { cols: 100, rows: 30 },
      target: c.target,
    });
    expect(state.resized).toEqual([[80, 24]]);
    expect(state.options.disableStdin).toBe(true);
    const frame = encodeFrame({
      ref: c.ref,
      streamId: "33333333-3333-4333-8333-333333333333" as never,
      kind: "resized",
      target: c.target,
      sequence: 1,
      byteLength: 0,
      controlSequence: 0,
      dimensions: { cols: 100, rows: 30 },
    });
    c.socket.onmessage?.({ data: frame.buffer });
    expect(state.resized).toEqual([
      [80, 24],
      [100, 30],
    ]);
    expect(state.options.disableStdin).toBe(false);
  } finally {
    state.cols = 80;
    state.rows = 24;
  }
});

test("continuous rendering cannot postpone a scheduled container resize", async () => {
  const c = await client();
  c.send("target");
  c.socket.sent = [];
  vi.useFakeTimers();
  state.cols = 90;
  state.rows = 28;
  try {
    state.resize();
    for (let i = 0; i < 4; i++) {
      c.send("output", c.target, new Uint8Array([65]));
      state.writes.at(-1)?.done();
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(
      c.socket.sent.some(
        (frame) =>
          typeof frame === "string" && JSON.parse(frame).kind === "resize",
      ),
    ).toBe(true);
  } finally {
    state.cols = 80;
    state.rows = 24;
  }
});
