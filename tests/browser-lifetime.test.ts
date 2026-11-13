import { connect } from "node:net";
import { expect, vi } from "vitest";
import { encodeFrame, policy } from "../src/browser/protocol";
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
    raw = await rawSocket(e, (await e.ticket(a.ref)).ticket);
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
    ws.onmessage = (event) => {
      output += new TextDecoder().decode(
        new Uint8Array(event.data as ArrayBuffer),
      );
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
      if (holding) {
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
