import { connect } from "node:net";
import { expect, vi } from "vitest";
import { decodeFrame, encodeFrame, policy } from "../src/browser/protocol";
import { browserEndpoint } from "./helpers/browser-endpoint";
import { test } from "./helpers/temp-dir";

function closed(ws: WebSocket) {
  return vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED), {
    timeout: 7000,
  });
}

test("only one concurrent ticket consumer activates a stream; reuse and active reissuance fail", async ({
  tempDir,
}) => {
  const e = await browserEndpoint(tempDir);
  try {
    const a = await e.create();
    const key = await e.ticket(a.ref);
    const attempts = await Promise.all(
      Array.from(
        { length: 2 },
        () =>
          new Promise<boolean>((resolve) => {
            const ws = e.connect(key.ticket);
            ws.onopen = () => resolve(true);
            ws.onerror = () => resolve(false);
          }),
      ),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect((await e.post("/api/tickets", { ref: a.ref })).status).toBe(409);
    const reuse = e.connect(key.ticket);
    await new Promise<void>((resolve) => {
      reuse.onerror = () => resolve();
    });
    expect(reuse.readyState).not.toBe(WebSocket.OPEN);
  } finally {
    await e.dispose();
  }
});

test("expired ticket is rejected even before the handshake sweeper runs", async ({
  tempDir,
}) => {
  let clock = 0;
  const e = await browserEndpoint(tempDir, { now: () => clock });
  try {
    const a = await e.create();
    const key = await e.ticket(a.ref);
    clock += policy.ticketMs;
    const ws = e.connect(key.ticket);
    await new Promise<void>((resolve) => {
      ws.onerror = () => resolve();
    });
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  } finally {
    await e.dispose();
  }
});

test("successful slow launch gets a fresh handshake clock and session expiry closes its stream", async ({
  tempDir,
}) => {
  let clock = 0;
  const e = await browserEndpoint(tempDir, {
    now: () => clock,
    prepare: async () => {
      clock += 9000;
    },
  });
  try {
    const a = await e.create();
    clock += 9000;
    const ws = await e.open((await e.ticket(a.ref)).ticket);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    clock = policy.sessionMs;
    await closed(ws);
    expect((await e.post("/api/tickets", { ref: a.ref })).status).toBe(401);
  } finally {
    await e.dispose();
  }
});

test("a launch crossing its deadline is cleaned up without returning a usable attachment", async ({
  tempDir,
}) => {
  let clock = 0;
  const e = await browserEndpoint(tempDir, {
    now: () => clock,
    prepare: async () => {
      clock = policy.handshakeMs;
    },
  });
  try {
    expect(
      (await e.post("/api/attachments", { dimensions: { cols: 80, rows: 24 } }))
        .status,
    ).toBe(400);
    expect(e.detach).toHaveBeenCalledOnce();
    expect(e.pids.size).toBe(0);
  } finally {
    await e.dispose();
  }
});

test("oversized and saturated input close only their own attachment", async ({
  tempDir,
}) => {
  const e = await browserEndpoint(tempDir);
  try {
    const a = await e.create(),
      b = await e.create();
    const key = await e.ticket(a.ref);
    const one = await e.open(key.ticket);
    const two = await e.open((await e.ticket(b.ref)).ticket);
    one.send(new Uint8Array(4 + policy.controlBytes + policy.dataBytes + 1));
    await closed(one);
    expect(two.readyState).toBe(WebSocket.OPEN);
    const c = await e.create(),
      ck = await e.ticket(c.ref);
    const three = await e.open(ck.ticket);
    for (let sequence = 0; sequence < 6; sequence++) {
      three.send(
        encodeFrame(
          {
            ref: c.ref,
            streamId: ck.streamId as never,
            kind: "input",
            sequence,
            byteLength: policy.dataBytes,
          },
          new Uint8Array(policy.dataBytes),
        ),
      );
    }
    await closed(three);
    expect(two.readyState).toBe(WebSocket.OPEN);
  } finally {
    await e.dispose();
  }
});

test("oversized output is bounded without blocking a second attachment", async ({
  tempDir,
}) => {
  let holding = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const e = await browserEndpoint(tempDir, {
    query: async () => {
      if (holding) await gate;
    },
  });
  try {
    const a = await e.create(),
      key = await e.ticket(a.ref);
    const one = await e.open(key.ticket);
    // An output producer is held behind observation so its bounded application
    // queue fills regardless of how quickly the test client reads its socket.
    const b = await e.create(),
      bk = await e.ticket(b.ref);
    const two = await e.open(bk.ticket);
    let received = 0;
    two.onmessage = () => {
      received++;
    };
    holding = true;
    one.send(
      encodeFrame(
        {
          ref: a.ref,
          streamId: key.streamId as never,
          kind: "input",
          sequence: 0,
          byteLength: 5,
        },
        new TextEncoder().encode("FLOOD"),
      ),
    );
    await closed(one);
    holding = false;
    release();
    two.send(
      encodeFrame(
        {
          ref: b.ref,
          streamId: bk.streamId as never,
          kind: "input",
          sequence: 0,
          byteLength: 1,
        },
        new Uint8Array([65]),
      ),
    );
    await vi.waitFor(() => expect(received).toBeGreaterThan(0));
    expect(two.readyState).toBe(WebSocket.OPEN);
  } finally {
    release();
    await e.dispose();
  }
});

test("stop cancels a streaming HTTP body before it can prepare a child", async ({
  tempDir,
}) => {
  const e = await browserEndpoint(tempDir);
  const address = new URL(e.url);
  const socket = connect(Number(address.port), "127.0.0.1");
  try {
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      `POST /api/attachments HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${address.origin}\r\nCookie: ${e.cookie}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n`,
    );
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    // A second request establishes that the listener is processing requests;
    // shutdown must not wait for the unfinished body's ten-second deadline.
    await fetch(e.url);
    const start = Date.now();
    await Promise.all([e.stop(), e.stop()]);
    expect(Date.now() - start).toBeLessThan(3000);
    expect(e.ids).toEqual([]);
    expect(response).not.toContain("201 Created");
  } finally {
    socket.destroy();
    await e.dispose();
  }
});

test("suspended unavailable child is KILLed after owned TERM and awaited before stop returns", async ({
  tempDir,
}) => {
  const e = await browserEndpoint(tempDir, {
    ignoreTerm: true,
    unavailableDetach: true,
  });
  const kill = vi.spyOn(process, "kill");
  try {
    const a = await e.create();
    const pid = e.pids.get(a.ref.attachmentId);
    if (!pid) throw new Error("Missing child PID");
    process.kill(pid, "SIGSTOP");
    const start = Date.now();
    await e.stop();
    expect(Date.now() - start).toBeGreaterThanOrEqual(
      policy.drainMs + policy.termMs - 100,
    );
    expect(() => process.kill(pid, 0)).toThrow();
    expect(
      e.diagnostics.some((message) => message.includes("detach unavailable")),
    ).toBe(true);
    // No session/server command exists in the fake detach backend. The real
    // isolated-tmux fixture separately verifies native clients and workloads.
    expect(kill.mock.calls.filter(([target]) => target !== pid)).toEqual([]);
  } finally {
    kill.mockRestore();
    await e.dispose();
  }
}, 15_000);

test("full-acceptance writes consume conservative credit until an actual drain, never guessed idle credit", async ({
  tempDir,
}) => {
  const e = await browserEndpoint(tempDir);
  const write = vi
    .spyOn(Bun.Terminal.prototype, "write")
    .mockImplementation((data) =>
      typeof data === "string" ? Buffer.byteLength(data) : data.byteLength,
    );
  try {
    const a = await e.create(),
      key = await e.ticket(a.ref);
    const ws = await e.open(key.ticket);
    const bytes = new Uint8Array(60 * 1024);
    for (let sequence = 0; sequence < 4; sequence++) {
      ws.send(
        encodeFrame(
          {
            ref: a.ref,
            streamId: key.streamId as never,
            kind: "input",
            sequence,
            byteLength: bytes.length,
          },
          bytes,
        ),
      );
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(sequence + 1));
    }
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.send(
      encodeFrame(
        {
          ref: a.ref,
          streamId: key.streamId as never,
          kind: "input",
          sequence: 4,
          byteLength: bytes.length,
        },
        bytes,
      ),
    );
    await closed(ws);
    expect(write).toHaveBeenCalledTimes(4);
  } finally {
    write.mockRestore();
    await e.dispose();
  }
});

async function rawSocket(
  e: Awaited<ReturnType<typeof browserEndpoint>>,
  ticket: string,
) {
  const address = new URL(e.url);
  const socket = connect(Number(address.port), "127.0.0.1");
  let received = "";
  socket.on("data", (chunk) => {
    received += chunk.toString("latin1");
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(
        `GET /terminal?ticket=${ticket} HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${e.origin}\r\nCookie: ${e.cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n\r\n`,
      );
    });
    const inspect = () => {
      if (received.includes("\r\n\r\n")) {
        socket.off("data", inspect);
        if (received.startsWith("HTTP/1.1 101")) resolve();
        else reject(new Error("Raw upgrade rejected"));
      }
    };
    socket.on("data", inspect);
  });
  return { socket, received: () => received };
}

test("no-pong raw client expires after two intervals without affecting another tab", async ({
  tempDir,
}) => {
  let clock = 0;
  const e = await browserEndpoint(tempDir, { now: () => clock });
  let raw: Awaited<ReturnType<typeof rawSocket>> | undefined;
  try {
    const a = await e.create(),
      b = await e.create();
    const rawTicket = await e.ticket(a.ref);
    raw = await rawSocket(e, rawTicket.ticket);
    // ACK target consumption, but deliberately never answer ping frames. This
    // isolates the heartbeat deadline from the shorter renderer deadline.
    const ack = encodeFrame({
      ref: a.ref,
      streamId: rawTicket.streamId as never,
      target: a.target,
      kind: "ack",
      sequence: 0,
      byteLength: 0,
    });
    const wire = new Uint8Array(8 + ack.length);
    wire[0] = 0x82;
    wire[1] = 0xfe;
    new DataView(wire.buffer).setUint16(2, ack.length);
    const mask = crypto.getRandomValues(new Uint8Array(4));
    wire.set(mask, 4);
    for (let i = 0; i < ack.length; i++)
      wire[8 + i] = (ack[i] ?? 0) ^ (mask[i % 4] ?? 0);
    raw.socket.write(wire);
    const two = await e.open((await e.ticket(b.ref)).ticket);
    clock = policy.pingMs;
    await vi.waitFor(() => expect(raw?.received().length).toBeGreaterThan(0));
    // Raw TCP deliberately sends no pong. Keep the other tab's pong fresh by
    // letting a full sweep at the first interval complete before advancing time.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    clock = policy.heartbeatMs;
    await vi.waitFor(
      () =>
        expect(
          e.detach.mock.calls.some(([ref]) => ref.id === a.ref.attachmentId),
        ).toBe(true),
      { timeout: 4000 },
    );
    expect(two.readyState).toBe(WebSocket.OPEN);
    expect(raw.received()).toContain("heartbeat expired");
  } finally {
    raw?.socket.destroy();
    await e.dispose();
  }
});

test("non-reading transport is disconnected and its output cannot stall another attachment", async ({
  tempDir,
}) => {
  const e = await browserEndpoint(tempDir);
  let raw: Awaited<ReturnType<typeof rawSocket>> | undefined;
  try {
    const a = await e.create(),
      b = await e.create(),
      key = await e.ticket(b.ref);
    raw = await rawSocket(e, (await e.ticket(a.ref)).ticket);
    raw.socket.pause();
    const two = await e.open(key.ticket);
    const pid = e.pids.get(a.ref.attachmentId);
    if (!pid) throw new Error("Missing noisy child");
    process.kill(pid, "SIGUSR1");
    await vi.waitFor(
      () =>
        expect(
          e.detach.mock.calls.some(([ref]) => ref.id === a.ref.attachmentId),
        ).toBe(true),
      { timeout: 7000 },
    );
    expect(two.readyState).toBe(WebSocket.OPEN);
  } finally {
    raw?.socket.destroy();
    await e.dispose();
  }
}, 15_000);

test("unconditional upgrade rejection, ticket supersession, stale streams and malformed frames", async ({
  tempDir,
}) => {
  const e = await browserEndpoint(tempDir);
  try {
    const a = await e.create();
    const old = await e.ticket(a.ref);
    const current = await e.ticket(a.ref);
    const rejected = e.connect(old.ticket);
    await new Promise<void>((resolve) => {
      rejected.onerror = () => resolve();
    });
    const wsUrl = `${e.url.replace("http:", "ws:")}terminal?ticket=${current.ticket}`;
    const rejectedHeaders: Record<string, string>[] = [
      { origin: e.origin },
      { origin: "null", cookie: e.cookie },
      { origin: "http://foreign.example", cookie: e.cookie },
    ];
    for (const headers of rejectedHeaders) {
      const response = await fetch(wsUrl.replace("ws:", "http:"), {
        headers: {
          ...headers,
          upgrade: "websocket",
          connection: "upgrade",
          "sec-websocket-version": "13",
          "sec-websocket-key": "MDEyMzQ1Njc4OWFiY2RlZg==",
        },
      });
      expect([401, 403]).toContain(response.status);
    }
    const good = await e.open(current.ticket);
    good.close();
    await closed(good);
    const changes = [
      { ref: { endpoint: "foreign" } },
      { ref: { server: "foreign" } },
      { ref: { generation: "44444444-4444-4444-8444-444444444444" } },
      { streamId: "44444444-4444-4444-8444-444444444444" },
      { sequence: 1 },
      { kind: "target", target: a.target },
      { byteLength: 1 },
    ];
    for (const change of changes) {
      const attachment = await e.create(),
        ticket = await e.ticket(attachment.ref);
      const ws = await e.open(ticket.ticket);
      const header = {
        streamId: ticket.streamId,
        kind: "input",
        sequence: 0,
        byteLength: 0,
        ...change,
        ref: { ...attachment.ref, ...("ref" in change ? change.ref : {}) },
      };
      const json = new TextEncoder().encode(JSON.stringify(header));
      const frame = new Uint8Array(4 + json.length);
      new DataView(frame.buffer).setUint32(0, json.length);
      frame.set(json, 4);
      ws.send(frame);
      await closed(ws);
    }
    const last = await e.create(),
      ticket = await e.ticket(last.ref),
      ws = await e.open(ticket.ticket);
    const frame = encodeFrame({
      ref: last.ref,
      streamId: ticket.streamId as never,
      kind: "input",
      sequence: 0,
      byteLength: 0,
    });
    ws.send(frame);
    ws.send(frame);
    await closed(ws);
  } finally {
    await e.dispose();
  }
}, 20_000);

test("real buffered Bun PTY drain replenishes conservative credit without resending bytes", async ({
  tempDir,
}) => {
  const e = await browserEndpoint(tempDir, { quiet: true });
  let pid: number | undefined;
  try {
    const a = await e.create(),
      key = await e.ticket(a.ref),
      ws = await e.open(key.ticket);
    pid = e.pids.get(a.ref.attachmentId);
    if (!pid) throw new Error("Missing child");
    let output = "";
    const decoder = new TextDecoder();
    ws.onmessage = (event) => {
      const { header, bytes } = decodeFrame(
        new Uint8Array(event.data as ArrayBuffer),
      );
      if (header.kind === "output")
        output += decoder.decode(bytes, { stream: true });
    };
    process.kill(pid, "SIGSTOP");
    const bytes = new Uint8Array(60 * 1024);
    for (let sequence = 0; sequence < 4; sequence++) {
      ws.send(
        encodeFrame(
          {
            ref: a.ref,
            streamId: key.streamId as never,
            kind: "input",
            sequence,
            byteLength: bytes.length,
          },
          bytes,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(ws.readyState).toBe(WebSocket.OPEN);
    process.kill(pid, "SIGCONT");
    await vi.waitFor(() => expect(output).toContain("READ:245760"));
    ws.send(
      encodeFrame(
        {
          ref: a.ref,
          streamId: key.streamId as never,
          kind: "input",
          sequence: 4,
          byteLength: bytes.length,
        },
        bytes,
      ),
    );
    await vi.waitFor(() => expect(output).toContain("READ:307200"));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGCONT");
      } catch {}
    }
    await e.dispose();
  }
});

test("shutdown retains closing callbacks after child exit until observation settles", async ({
  tempDir,
}) => {
  let holding = false,
    observing = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const e = await browserEndpoint(tempDir, {
    query: async () => {
      if (holding && !observing) {
        observing = true;
        await gate;
      }
    },
  });
  let stopping: Promise<void> | undefined;
  try {
    const a = await e.create(),
      ticket = await e.ticket(a.ref),
      ws = await e.open(ticket.ticket);
    const pid = e.pids.get(a.ref.attachmentId);
    if (!pid) throw new Error("Missing owned child");
    holding = true;
    ws.send(
      encodeFrame(
        {
          ref: a.ref,
          streamId: ticket.streamId as never,
          kind: "input",
          sequence: 0,
          byteLength: 1,
        },
        new Uint8Array([65]),
      ),
    );
    await vi.waitFor(() => expect(observing).toBe(true));
    ws.close();
    await closed(ws);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    let stopped = false;
    stopping = e.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  } finally {
    release();
    await stopping;
    await e.dispose();
  }
});

test("renderer credit is cumulative, independent of input, and a stalled reader expires alone", async ({
  tempDir,
}) => {
  let clock = 0;
  const e = await browserEndpoint(tempDir, { now: () => clock });
  try {
    const a = await e.create(),
      key = await e.ticket(a.ref);
    const slow = e.connect(key.ticket);
    let initial: ReturnType<typeof decodeFrame>["header"] | undefined;
    await new Promise<void>((resolve) => {
      slow.onmessage = (event) => {
        initial = decodeFrame(new Uint8Array(event.data as ArrayBuffer)).header;
        resolve();
      };
    });
    if (!initial || !("target" in initial)) throw new Error("Missing target");
    // Reading WS bytes without consuming them in xterm grants no credit.
    const b = await e.create(),
      bk = await e.ticket(b.ref),
      fast = await e.open(bk.ticket);
    clock = policy.renderMs;
    await closed(slow);
    expect(fast.readyState).toBe(WebSocket.OPEN);
    fast.send(
      encodeFrame(
        {
          ref: b.ref,
          streamId: bk.streamId as never,
          kind: "input",
          sequence: 0,
          byteLength: 1,
        },
        new Uint8Array([65]),
      ),
    );
    await new Promise<void>((resolve) => {
      fast.onmessage = () => resolve();
    });
    expect(fast.readyState).toBe(WebSocket.OPEN);
  } finally {
    await e.dispose();
  }
});

test("invalid cumulative ACKs cannot mint credit or affect a second attachment", async ({
  tempDir,
}) => {
  const e = await browserEndpoint(tempDir);
  try {
    const b = await e.create(),
      two = await e.open((await e.ticket(b.ref)).ticket);
    for (const variant of [
      "future",
      "duplicate",
      "stream",
      "target",
      "generation",
    ]) {
      const a = await e.create(),
        key = await e.ticket(a.ref),
        ws = await e.open(key.ticket);
      const ack = {
        ref:
          variant === "generation"
            ? { ...a.ref, generation: b.ref.generation }
            : a.ref,
        streamId:
          variant === "stream"
            ? "44444444-4444-4444-8444-444444444444"
            : key.streamId,
        target:
          variant === "target" ? { ...a.target, sessionId: "$99" } : a.target,
        kind: "ack" as const,
        sequence: variant === "future" ? 500 : 0,
        byteLength: 0 as const,
      };
      // e.open has already ACKed sequence zero. Repeating it is invalid.
      ws.send(encodeFrame(ack as Parameters<typeof encodeFrame>[0]));
      await closed(ws);
      expect(two.readyState).toBe(WebSocket.OPEN);
    }
  } finally {
    await e.dispose();
  }
});

test("fresh recovery waits for old child exit and captures unreported native navigation", async ({
  tempDir,
}) => {
  let native = false;
  const prepared: unknown[] = [];
  const initial = {
    server: "/tmp/fixture|1|2",
    sessionId: "$1",
    mainRepoPath: tempDir,
    worktreePath: tempDir,
    branch: "main",
  };
  const navigated = {
    server: initial.server,
    sessionId: "$2",
    sessionName: "native-navigation",
  };
  const e = await browserEndpoint(tempDir, {
    prepared: (expected) => prepared.push(expected),
    client: () =>
      native ? { sessionId: "$2", session: "native-navigation" } : {},
    verify: async (client) => (client.sessionId === "$2" ? navigated : initial),
  });
  try {
    const a = await e.create(),
      ws = await e.open((await e.ticket(a.ref)).ticket);
    const pid = e.pids.get(a.ref.attachmentId);
    if (!pid) throw new Error("Missing old child");
    ws.close();
    await closed(ws);
    let result: Response | undefined;
    await vi.waitFor(async () => {
      result = await e.post("/api/attachments", {
        reconnect: a.ref,
        dimensions: { cols: 80, rows: 24 },
      });
      expect(result.status).toBe(201);
    });
    if (!result) throw new Error("Missing recovery response");
    const replacement = (await result.json()) as { ref: typeof a.ref };
    expect(replacement.ref).not.toEqual(a.ref);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(prepared[1]).toEqual(initial);
    // A stale reference cannot issue a ticket for the new client.
    expect((await e.post("/api/tickets", { ref: a.ref })).status).toBe(409);
    const second = await e.open((await e.ticket(replacement.ref)).ticket);
    native = true;
    second.close();
    await closed(second);
    await vi.waitFor(async () => {
      expect(
        (
          await e.post("/api/attachments", {
            reconnect: replacement.ref,
            dimensions: { cols: 80, rows: 24 },
          })
        ).status,
      ).toBe(201);
    });
    expect(prepared[2]).toEqual(navigated);
  } finally {
    await e.dispose();
  }
});

test("resize verifies its target, drains renderer credit and input watermark, and stays attachment-local", async ({
  tempDir,
}) => {
  const e = await browserEndpoint(tempDir);
  const resize = vi.spyOn(Bun.Terminal.prototype, "resize");
  try {
    const a = await e.create(),
      key = await e.ticket(a.ref),
      one = await e.open(key.ticket);
    const b = await e.create(),
      two = await e.open((await e.ticket(b.ref)).ticket);
    const reply = new Promise<ReturnType<typeof decodeFrame>["header"]>(
      (resolve) => {
        one.onmessage = (event) => {
          const { header } = decodeFrame(
            new Uint8Array(event.data as ArrayBuffer),
          );
          if (header.kind === "resized") resolve(header);
        };
      },
    );
    one.send(
      JSON.stringify({
        ref: a.ref,
        streamId: key.streamId,
        target: a.target,
        kind: "resize",
        dimensions: { cols: 100, rows: 30 },
        controlSequence: 0,
        throughInput: null,
      }),
    );
    expect(await reply).toMatchObject({
      kind: "resized",
      dimensions: { cols: 100, rows: 30 },
      controlSequence: 0,
    });
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(100, 30);
    one.send(
      JSON.stringify({
        ref: a.ref,
        streamId: key.streamId,
        target: a.target,
        kind: "resize",
        dimensions: { cols: 110, rows: 30 },
        controlSequence: 1,
        throughInput: 4,
      }),
    );
    await closed(one);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(two.readyState).toBe(WebSocket.OPEN);
  } finally {
    resize.mockRestore();
    await e.dispose();
  }
});

test("Workspace disappearance stops recovery rather than attaching to an automatically selected replacement", async ({
  tempDir,
}) => {
  let gone = false;
  const initial = {
    server: "/tmp/fixture|1|2",
    sessionId: "$1",
    mainRepoPath: tempDir,
    worktreePath: tempDir,
    branch: "main",
  };
  const e = await browserEndpoint(tempDir, {
    client: () => (gone ? { sessionId: "$2", session: "replacement" } : {}),
    verify: async (client) => {
      if (gone && client.sessionId === "$1")
        throw new Error("Workspace Session disappeared");
      return client.sessionId === "$2"
        ? {
            server: initial.server,
            sessionId: "$2",
            sessionName: "replacement",
          }
        : initial;
    },
  });
  try {
    const a = await e.create(),
      ws = await e.open((await e.ticket(a.ref)).ticket);
    gone = true;
    ws.close();
    await closed(ws);
    await vi.waitFor(async () => {
      expect(
        (
          await e.post("/api/attachments", {
            reconnect: a.ref,
            dimensions: { cols: 80, rows: 24 },
          })
        ).status,
      ).toBe(410);
    });
    expect(e.ids).toHaveLength(1);
  } finally {
    await e.dispose();
  }
});

test("initial creation refuses tmux's automatic substitute even when it is another verified Workspace", async ({
  tempDir,
}) => {
  const other = {
    server: "/tmp/fixture|1|2",
    sessionId: "$2",
    mainRepoPath: tempDir,
    worktreePath: tempDir,
    branch: "other",
  };
  const e = await browserEndpoint(tempDir, {
    client: () => ({ sessionId: "$2" }),
    verify: async () => other,
  });
  try {
    expect(
      (await e.post("/api/attachments", { dimensions: { cols: 80, rows: 24 } }))
        .status,
    ).toBe(400);
    expect(e.detach).toHaveBeenCalled();
    for (const pid of e.pids.values())
      expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await e.dispose();
  }
});

test("recovery retries return the same pending creation after a lost response and never affect its activated stream", async ({
  tempDir,
}) => {
  const e = await browserEndpoint(tempDir);
  try {
    const a = await e.create(),
      ws = await e.open((await e.ticket(a.ref)).ticket);
    ws.close();
    await closed(ws);
    let reply!: Response;
    await vi.waitFor(async () => {
      reply = await e.post("/api/attachments", {
        reconnect: a.ref,
        dimensions: { cols: 80, rows: 24 },
      });
      expect(reply.status).toBe(201);
    });
    const original = (await reply.json()) as typeof a;
    const retry = await e.post("/api/attachments", {
      reconnect: a.ref,
      dimensions: { cols: 100, rows: 30 },
    });
    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({
      ref: original.ref,
      dimensions: { cols: 80, rows: 24 },
    });
    expect(e.ids).toHaveLength(2);
    const replacement = await e.open((await e.ticket(original.ref)).ticket);
    expect(
      (
        await e.post("/api/attachments", {
          reconnect: a.ref,
          dimensions: { cols: 80, rows: 24 },
        })
      ).status,
    ).toBe(410);
    expect(replacement.readyState).toBe(WebSocket.OPEN);
    expect(e.ids).toHaveLength(2);
  } finally {
    await e.dispose();
  }
});

test("resize rechecks render drain after asynchronous target verification publishes intervening output", async ({
  tempDir,
}) => {
  let checking = false,
    observations = 0,
    blocked = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const target = {
    server: "/tmp/fixture|1|2",
    sessionId: "$1",
    mainRepoPath: tempDir,
    worktreePath: tempDir,
    branch: "main",
  };
  const e = await browserEndpoint(tempDir, {
    verify: async () => {
      if (checking && ++observations === 2) {
        blocked = true;
        await gate;
      }
      return target;
    },
  });
  const resize = vi.spyOn(Bun.Terminal.prototype, "resize");
  try {
    const a = await e.create(),
      key = await e.ticket(a.ref),
      ws = await e.open(key.ticket);
    await new Promise((resolve) => setTimeout(resolve, 30));
    let output: ReturnType<typeof decodeFrame>["header"] | undefined;
    ws.onmessage = (event) => {
      const { header } = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
      if (header.kind === "output") output = header;
    };
    checking = true;
    ws.send(
      JSON.stringify({
        ref: a.ref,
        streamId: key.streamId,
        target: a.target,
        kind: "resize",
        dimensions: { cols: 100, rows: 30 },
        controlSequence: 0,
        throughInput: null,
      }),
    );
    await vi.waitFor(() => expect(blocked).toBe(true));
    const pid = e.pids.get(a.ref.attachmentId);
    if (!pid) throw new Error("Missing owned child");
    process.kill(pid, "SIGUSR2");
    await vi.waitFor(() => expect(output?.kind).toBe("output"));
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resize).not.toHaveBeenCalled();
    if (!output || !("target" in output))
      throw new Error("Missing output header");
    ws.send(
      encodeFrame({
        ref: output.ref,
        streamId: output.streamId,
        target: output.target,
        kind: "ack",
        sequence: output.sequence,
        byteLength: 0,
      }),
    );
    await vi.waitFor(() => expect(resize).toHaveBeenCalledWith(100, 30));
  } finally {
    release();
    resize.mockRestore();
    await e.dispose();
  }
});

test("cumulative render ACKs sustain bounded bursts beyond the total output budget", async ({
  tempDir,
}) => {
  const e = await browserEndpoint(tempDir);
  try {
    const a = await e.create(),
      ws = await e.open((await e.ticket(a.ref)).ticket);
    const pid = e.pids.get(a.ref.attachmentId);
    if (!pid) throw new Error("Missing child");
    let bytes = 0;
    let complete = () => {};
    ws.onmessage = (event) => {
      const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
      if (!("target" in frame.header) || frame.header.kind === "ack") return;
      ws.send(
        encodeFrame({
          ref: frame.header.ref,
          streamId: frame.header.streamId,
          target: frame.header.target,
          kind: "ack",
          sequence: frame.header.sequence,
          byteLength: 0,
        }),
      );
      bytes += frame.bytes.length;
      complete();
    };
    for (let burst = 0; burst < 12; burst++) {
      const through = (burst + 1) * 128 * 1024;
      await new Promise<void>((resolve) => {
        complete = () => {
          if (bytes >= through) resolve();
        };
        process.kill(pid, "SIGUSR2");
      });
    }
    expect(bytes).toBeGreaterThan(policy.outputBytes);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  } finally {
    await e.dispose();
  }
});

test("resize cannot report success when asynchronous verification crosses its deadline", async ({
  tempDir,
}) => {
  let clock = 0,
    checking = false,
    observations = 0;
  const target = {
    server: "/tmp/fixture|1|2",
    sessionId: "$1",
    mainRepoPath: tempDir,
    worktreePath: tempDir,
    branch: "main",
  };
  const e = await browserEndpoint(tempDir, {
    now: () => clock,
    verify: async () => {
      if (checking && ++observations === 2) clock = policy.drainMs;
      return target;
    },
  });
  const resize = vi.spyOn(Bun.Terminal.prototype, "resize");
  try {
    const a = await e.create(),
      key = await e.ticket(a.ref),
      ws = await e.open(key.ticket);
    await new Promise((resolve) => setTimeout(resolve, 30));
    checking = true;
    ws.send(
      JSON.stringify({
        ref: a.ref,
        streamId: key.streamId,
        target: a.target,
        kind: "resize",
        dimensions: { cols: 100, rows: 30 },
        controlSequence: 0,
        throughInput: null,
      }),
    );
    await closed(ws);
    expect(resize).not.toHaveBeenCalled();
  } finally {
    resize.mockRestore();
    await e.dispose();
  }
});

test("native rename followed by navigation and recovery keeps targeting session IDs", async ({
  tempDir,
}) => {
  const workspace = {
    server: "/tmp/fixture|1|2",
    sessionId: "$1",
    mainRepoPath: tempDir,
    worktreePath: tempDir,
    branch: "main",
  };
  let current = "$1";
  const names: Record<string, string> = {
    $2: "before-rename",
    $3: "destination",
  };
  const e = await browserEndpoint(tempDir, {
    client: () => ({
      sessionId: current,
      session: names[current] ?? "workspace",
    }),
    verify: async (client) => {
      if (client.sessionId === "$1") return workspace;
      const sessionId = client.sessionId;
      const sessionName = sessionId ? names[sessionId] : undefined;
      if (!sessionId || !sessionName) throw new Error("Missing native session");
      return { server: workspace.server, sessionId, sessionName };
    },
  });
  try {
    const a = await e.create(),
      ws = await e.open((await e.ticket(a.ref)).ticket);
    const pid = e.pids.get(a.ref.attachmentId);
    if (!pid) throw new Error("Missing child");
    let observed = "$1";
    ws.onmessage = (event) => {
      const { header } = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
      if (!("target" in header) || header.kind === "ack") return;
      observed = header.target.sessionId;
      ws.send(
        encodeFrame({
          ref: header.ref,
          streamId: header.streamId,
          target: header.target,
          kind: "ack",
          sequence: header.sequence,
          byteLength: 0,
        }),
      );
    };
    current = "$2";
    process.kill(pid, "SIGUSR2");
    await vi.waitFor(() => expect(observed).toBe("$2"));
    names.$2 = "renamed";
    current = "$3";
    process.kill(pid, "SIGUSR2");
    await vi.waitFor(() => expect(observed).toBe("$3"));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await closed(ws);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    names.$3 = "renamed-after-disconnect";
    let reply!: Response;
    await vi.waitFor(async () => {
      reply = await e.post("/api/attachments", {
        reconnect: a.ref,
        dimensions: { cols: 80, rows: 24 },
      });
      expect(reply.status).toBe(201);
    });
    expect(await reply.json()).toMatchObject({
      target: {
        server: workspace.server,
        sessionId: "$3",
        sessionName: "renamed-after-disconnect",
      },
    });
  } finally {
    await e.dispose();
  }
});
