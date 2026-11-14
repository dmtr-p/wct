import { randomBytes, randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type {
  AttachmentLaunch,
  TerminalAttachment,
  TmuxClient,
} from "../services/terminal-attachments";
import { boundedJson, LocalAuth, validRequestAuthority } from "./auth";
import { loadBrowserAssets } from "./load-assets";
import {
  Bootstrap,
  CreateLocalAttachment,
  decode,
  decodeFrame,
  encodeFrame,
  LocalControl,
  type LocalHeader,
  LocalHeader as LocalHeaderSchema,
  type LocalRef,
  LocalRef as LocalRefSchema,
  type LocalTarget,
  LocalTarget as LocalTargetSchema,
  policy,
  same,
  sameLocalTarget,
  TicketRequest,
  WorkspaceTarget as WorkspaceTargetSchema,
} from "./protocol";

export interface AttachmentBackend {
  prepare(
    expected?: LocalTarget,
  ): Promise<AttachmentLaunch & { target: LocalTarget }>;
  query(ref: TerminalAttachment): Promise<TmuxClient | null>;
  detach(ref: TerminalAttachment): Promise<void>;
  /** Must reverify both Workspace ownership and the exact tmux session generation. */
  verify(client: TmuxClient): Promise<LocalTarget>;
}
interface Connection {
  attachment: Attachment;
  streamId: string;
}
interface Ticket extends Connection {
  owner: string;
  expires: number;
}
interface Attachment {
  owner: string;
  dimensions: { cols: number; rows: number };
  readyAt?: number;
  ref: LocalRef;
  launch: AttachmentLaunch;
  terminal?: Bun.Terminal;
  child?: Bun.Subprocess;
  exited: boolean;
  closing?: Promise<void>;
  socket?: ServerWebSocket<Connection>;
  streamId?: string;
  activated: boolean;
  target?: LocalTarget;
  lastPong: number;
  lastPing: number;
  inputSequence: number;
  outputSequence: number;
  controlSequence: number;
  inputBytes: number;
  inputFrames: number;
  ptyBytes: number;
  output: Uint8Array[];
  outputBytes: number;
  sent: { sequence: number; cost: number; target: LocalTarget; at: number }[];
  sentBytes: number;
  lastAck: number;
  pumping?: Promise<void>;
  actions: Promise<void>;
}

function response(status: number, value: unknown) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Local terminal deadline exceeded")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Imperative Bun callbacks are owned by the caller's Effect acquire/release scope. */
export async function startLocalTerminal(options: {
  backend: AttachmentBackend;
  port?: number;
  env: Record<string, string | undefined>;
  now?: () => number;
  diagnostic?: (message: string) => void;
}) {
  const now = options.now ?? (() => Date.now());
  const auth = new LocalAuth(now);
  const endpoint = randomUUID();
  const assets = await loadBrowserAssets();
  const attachments = new Map<string, Attachment>();
  const tickets = new Map<string, Ticket>();
  const recoveries = new Map<
    string,
    {
      ref: LocalRef;
      owner: string;
      expires: number;
      target?: LocalTarget;
      settled: boolean;
      creation?: Promise<Attachment>;
    }
  >();
  const preparations = new Set<Promise<unknown>>();
  const inFlight = new Map<AbortController, Promise<void>>();
  let reserved = 0;
  let requests = 0;
  let stopping = false;
  const diagnostic = options.diagnostic ?? (() => {});
  const forgetTickets = (a: Attachment) => {
    for (const [key, ticket] of tickets)
      if (ticket.attachment === a) tickets.delete(key);
  };
  const valid = (a: Attachment, ws?: ServerWebSocket<Connection>) =>
    !stopping &&
    !a.closing &&
    auth.alive(a.owner) &&
    (!ws || (a.socket === ws && a.streamId === ws.data.streamId));

  async function observe(a: Attachment) {
    const client = await options.backend.query(a.launch.attachment);
    if (!client || client.server !== a.ref.server || !client.sessionId)
      throw new Error("Attachment unavailable");
    const previous = a.target;
    if (previous && previous.sessionId !== client.sessionId) {
      const stillPresent = decode(
        LocalTargetSchema,
        await options.backend.verify({
          tty: "",
          session: "sessionName" in previous ? previous.sessionName : "",
          server: previous.server,
          sessionId: previous.sessionId,
        }),
      );
      if (!sameLocalTarget(stillPresent, previous))
        throw new Error("Previous Workspace or session disappeared");
    }
    const target = decode(
      LocalTargetSchema,
      await options.backend.verify(client),
    );
    if (
      target.server !== client.server ||
      target.sessionId !== client.sessionId
    )
      throw new Error("Inconsistent target observation");
    if (
      a.target &&
      "mainRepoPath" in a.target &&
      a.target.sessionId === target.sessionId &&
      !same(a.target, target)
    )
      throw new Error("Workspace ownership changed or disappeared");
    return target;
  }

  function send(a: Attachment, header: LocalHeader, bytes?: Uint8Array) {
    const ws = a.socket;
    if (!ws || !valid(a, ws)) throw new Error("Terminal stream closed");
    const frame = encodeFrame(header, bytes);
    // Bun checks its backpressure limit before adding a frame. Account for
    // this frame and our application queue before calling send.
    if (
      a.sent.length + a.output.length >= 256 ||
      ws.getBufferedAmount() +
        a.outputBytes +
        a.sentBytes +
        frame.length +
        128 >
        policy.outputBytes
    )
      throw new Error("Terminal output limit exceeded");
    if (header.kind === "input" || header.kind === "ack")
      throw new Error("Invalid server direction");
    a.sent.push({
      sequence: header.sequence,
      cost: frame.length + 128,
      target: header.target,
      at: now(),
    });
    a.sentBytes += frame.length + 128;
    if (ws.sendBinary(frame) === 0)
      throw new Error("Terminal transport unavailable");
  }
  function header(
    a: Attachment,
    kind: "target" | "output",
    byteLength: number,
  ): LocalHeader {
    if (!a.target || !a.streamId)
      throw new Error("Unestablished terminal target");
    return decodeHeader({
      ref: a.ref,
      streamId: a.streamId,
      target: a.target,
      kind,
      sequence: a.outputSequence++,
      byteLength,
    });
  }
  function decodeHeader(value: unknown): LocalHeader {
    // The shared frame codec validates this on the browser as well.
    return decode(LocalHeaderSchema, value);
  }
  function pump(a: Attachment) {
    if (a.pumping || !a.socket || !a.activated || a.closing) return;
    a.pumping = (async () => {
      try {
        const target = await observe(a);
        if (!valid(a)) return;
        if (!same(a.target, target)) {
          a.target = target;
          send(a, header(a, "target", 0));
        }
        while (a.output.length && valid(a)) {
          const bytes = a.output[0];
          if (!bytes) break;
          a.output.shift();
          a.outputBytes -= bytes.length + policy.controlBytes + 4 + 128;
          send(a, header(a, "output", bytes.length), bytes);
        }
      } catch {
        void close(a, "Terminal output or target validation failed");
      }
    })().finally(() => {
      a.pumping = undefined;
    });
  }
  function output(a: Attachment, data: Uint8Array) {
    if (a.closing) return;
    if (
      a.output.length +
        a.sent.length +
        Math.ceil(data.length / policy.dataBytes) >
        256 ||
      data.length +
        Math.ceil(data.length / policy.dataBytes) *
          (policy.controlBytes + 4 + 128) +
        a.sentBytes +
        a.outputBytes +
        (a.socket?.getBufferedAmount() ?? 0) >
        policy.outputBytes
    ) {
      void close(a, "Terminal output limit exceeded");
      return;
    }
    for (let offset = 0; offset < data.length; offset += policy.dataBytes) {
      const chunk = data.slice(offset, offset + policy.dataBytes);
      a.output.push(chunk);
      a.outputBytes += chunk.length + policy.controlBytes + 4 + 128;
    }
    pump(a);
  }
  async function cleanup(a: Attachment, reason: string) {
    const recovery = recoveries.get(a.ref.attachmentId);
    forgetTickets(a);
    a.socket?.close(1000, reason.slice(0, 100));
    const finalObservation = recovery ? observe(a) : undefined;
    // Capture native navigation even when its last target header was lost.
    // Failure leaves recovery unavailable rather than guessing the old target.
    if (recovery && finalObservation) {
      try {
        recovery.target = await within(finalObservation, policy.drainMs);
      } catch {
        recovery.target = undefined;
      }
    }
    a.output = [];
    a.outputBytes = 0;
    a.sent = [];
    a.sentBytes = 0;
    // PTY buffers and the tmux reservation stay exclusive until confirmed exit.
    const child = a.child;
    if (child && !a.exited) {
      try {
        await within(
          (async () => {
            try {
              await options.backend.detach(a.launch.attachment);
            } catch {
              diagnostic(
                `Attachment ${a.ref.attachmentId}: detach unavailable; retaining ownership until child exit`,
              );
            }
            await child.exited;
          })(),
          policy.drainMs,
        );
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          diagnostic(
            `Attachment ${a.ref.attachmentId}: TERM failed; retaining child ownership`,
          );
        }
        try {
          await within(child.exited, policy.termMs);
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            diagnostic(
              `Attachment ${a.ref.attachmentId}: KILL failed; awaiting confirmed child exit`,
            );
          }
        }
        await child.exited;
      }
      a.exited = true;
    }
    a.terminal?.close();
    try {
      await options.backend.detach(a.launch.attachment);
    } catch {
      diagnostic(
        `Attachment ${a.ref.attachmentId}: record cleanup failed after child exit`,
      );
    }
    // Retain the slot while ordered callbacks still hold input buffers or an
    // observation. Closing fences new work; the existing callbacks must settle.
    await Promise.allSettled([a.actions, a.pumping, finalObservation]);
    attachments.delete(a.ref.attachmentId);
    if (recovery) recovery.settled = true;
  }
  function close(a: Attachment, reason = "Terminal disconnected") {
    if (a.closing) return a.closing;
    if (a.readyAt !== undefined && !stopping) {
      if (recoveries.size >= policy.maxRecoveries) {
        const oldest = recoveries.keys().next().value;
        if (oldest) recoveries.delete(oldest);
      }
      recoveries.set(a.ref.attachmentId, {
        ref: a.ref,
        owner: a.owner,
        expires: now() + policy.recoveryMs,
        settled: false,
      });
    }
    // Set the fence before cleanup performs its first asynchronous operation.
    let finish!: () => void;
    a.closing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    void cleanup(a, reason)
      .catch(() => {
        diagnostic(
          `Attachment ${a.ref.attachmentId}: cleanup failed; ownership and PTY retained`,
        );
      })
      .finally(finish);
    return a.closing;
  }
  async function launch(
    owner: string,
    dimensions: { cols: number; rows: number },
    expected?: LocalTarget,
  ) {
    if (stopping) throw new Error("Endpoint stopped");
    reserved++;
    const started = now();
    let pending = true;
    let prepared: (AttachmentLaunch & { target: LocalTarget }) | undefined;
    let a: Attachment | undefined;
    let expired = false;
    const launchTimer = setTimeout(() => {
      expired = true;
      if (a) void close(a, "Attachment launch timed out");
      else
        diagnostic(
          "Attachment preparation timed out; retaining its pending reservation until preparation settles",
        );
    }, policy.handshakeMs);
    try {
      prepared = await options.backend.prepare(expected);
      if (
        stopping ||
        expired ||
        !auth.alive(owner) ||
        now() - started >= policy.handshakeMs
      )
        throw new Error("Endpoint closed");
      const selected = decode(
        expected ? LocalTargetSchema : WorkspaceTargetSchema,
        prepared.target,
      );
      if (expected && !sameLocalTarget(selected, expected))
        throw new Error("Recovery preparation target changed");
      a = {
        owner,
        dimensions,
        ref: decode(LocalRefSchema, {
          endpoint,
          attachmentId: prepared.attachment.id,
          generation: prepared.attachment.generation,
          server: prepared.attachment.server,
        }),
        launch: prepared,
        exited: false,
        activated: false,
        lastPong: now(),
        lastPing: now(),
        inputSequence: 0,
        outputSequence: 0,
        controlSequence: 0,
        inputBytes: 0,
        inputFrames: 0,
        ptyBytes: 0,
        output: [],
        outputBytes: 0,
        sent: [],
        sentBytes: 0,
        lastAck: -1,
        actions: Promise.resolve(),
      };
      const attachment = a;
      attachments.set(a.ref.attachmentId, a);
      reserved--;
      pending = false;
      a.terminal = new Bun.Terminal({
        ...dimensions,
        name: "xterm-256color",
        data: (_terminal, bytes) => output(attachment, bytes),
        // Bun accepts full writes, including internally buffered tails. Credit
        // only an actual drain; idle time and output prove nothing about input.
        drain: () => {
          attachment.ptyBytes = 0;
        },
        exit: () => {
          void close(attachment, "Terminal PTY closed");
        },
      });
      a.child = Bun.spawn([prepared.command, ...prepared.args], {
        terminal: a.terminal,
        env: {
          ...options.env,
          TMUX: "",
          TERM: "xterm-256color",
          ...prepared.env,
        },
      });
      void a.child.exited.then(() => {
        attachment.exited = true;
        return close(attachment, "Tmux client exited");
      });
      const deadline = started + policy.handshakeMs;
      for (;;) {
        if (!valid(a) || a.exited || now() >= deadline)
          throw new Error("Attachment launch failed");
        const client = await options.backend.query(prepared.attachment);
        if (client) {
          a.target = decode(
            expected ? LocalTargetSchema : WorkspaceTargetSchema,
            await options.backend.verify(client),
          );
          if (
            client.server !== a.ref.server ||
            a.target.server !== a.ref.server ||
            client.sessionId !== a.target.sessionId ||
            !sameLocalTarget(selected, a.target)
          )
            throw new Error("Attachment launch target changed");
          break;
        }
        await delay(20);
      }
      if (!valid(a) || expired || now() >= deadline)
        throw new Error("Attachment launch cancelled");
      a.readyAt = now();
      return a;
    } catch (error) {
      if (a) await close(a, "Attachment launch failed");
      else if (prepared) await options.backend.detach(prepared.attachment);
      throw error;
    } finally {
      clearTimeout(launchTimer);
      if (pending) reserved--;
    }
  }
  function receive(ws: ServerWebSocket<Connection>, message: string | Buffer) {
    const a = ws.data.attachment;
    if (!valid(a, ws)) {
      void close(a);
      return;
    }
    const length =
      typeof message === "string" ? Buffer.byteLength(message) : message.length;
    if (
      a.inputFrames >= 256 ||
      length + a.inputBytes + a.ptyBytes > policy.inputBytes ||
      (typeof message === "string" && length > policy.controlBytes)
    ) {
      void close(a, "Input budget exhausted; reload for a fresh attachment");
      return;
    }
    if (typeof message !== "string") {
      try {
        const { header: ack } = decodeFrame(message);
        if (ack.kind === "ack") {
          const through = a.sent.findIndex(
            (frame) => frame.sequence === ack.sequence,
          );
          if (
            !same(ack.ref, a.ref) ||
            ack.streamId !== a.streamId ||
            ack.sequence <= a.lastAck ||
            through < 0 ||
            !same(a.sent[through]?.target, ack.target)
          )
            throw new Error("Invalid renderer acknowledgement");
          for (const frame of a.sent.splice(0, through + 1))
            a.sentBytes -= frame.cost;
          a.lastAck = ack.sequence;
          return;
        }
      } catch {
        void close(a, "Terminal frame rejected");
        return;
      }
    }
    a.inputBytes += length;
    a.inputFrames++;
    // One bounded ordered queue per attachment; a busy attachment cannot hold
    // another attachment's controls or output behind it.
    a.actions = a.actions
      .then(async () => {
        if (!valid(a, ws)) return;
        if (typeof message === "string") {
          const control = decode(LocalControl, JSON.parse(message));
          const deadline = now() + policy.drainMs;
          const started = Date.now();
          const expired = () =>
            now() >= deadline || Date.now() - started >= policy.drainMs;
          const target = await observe(a);
          if (!valid(a, ws)) return;
          if (
            !same(a.ref, control.ref) ||
            control.streamId !== a.streamId ||
            !sameLocalTarget(target, control.target) ||
            control.controlSequence !== a.controlSequence
          )
            throw new Error("Stale terminal control");
          a.controlSequence++;
          if (control.kind === "close") {
            void close(a);
            return;
          }
          if (
            control.throughInput !==
            (a.inputSequence === 0 ? null : a.inputSequence - 1)
          )
            throw new Error("Resize input watermark mismatch");
          const drained = () =>
            !a.ptyBytes &&
            !a.output.length &&
            !a.pumping &&
            a.lastAck === a.outputSequence - 1;
          for (;;) {
            if (!valid(a, ws)) return;
            if (expired()) throw new Error("Resize drain deadline exceeded");
            if (!drained()) {
              await delay(10);
              continue;
            }
            const current = await observe(a);
            if (!valid(a, ws)) return;
            if (expired())
              throw new Error("Resize verification deadline exceeded");
            if (!sameLocalTarget(current, control.target))
              throw new Error("Resize target changed");
            // Verification is asynchronous: output published meanwhile must be
            // consumed before changing xterm's grid. Recheck without an await gap.
            if (drained()) break;
          }
          a.terminal?.resize(control.dimensions.cols, control.dimensions.rows);
          // Bun's ioctl does not reliably signal this spawned client on Darwin.
          // Signal only the exclusive child, whose exit fences PID reuse.
          if (!a.child || a.exited) throw new Error("Resize child unavailable");
          a.child.kill("SIGWINCH");
          a.dimensions = control.dimensions;
          const resized = decodeHeader({
            ...header(a, "target", 0),
            kind: "resized",
            dimensions: control.dimensions,
            controlSequence: control.controlSequence,
          });
          send(a, resized);
          return;
        } else {
          const { header: input, bytes } = decodeFrame(message);
          if (
            input.kind !== "input" ||
            !same(a.ref, input.ref) ||
            input.streamId !== a.streamId ||
            input.sequence !== a.inputSequence
          )
            throw new Error("Stale terminal input");
          a.inputSequence++;
          if (bytes.length + a.ptyBytes > policy.inputBytes)
            throw new Error("PTY input limit exceeded");
          a.ptyBytes += bytes.length;
          a.terminal?.write(bytes);
        }
      })
      .catch(() => {
        void close(a, "Terminal input or control rejected");
      })
      .finally(() => {
        a.inputBytes -= length;
        a.inputFrames--;
      });
  }
  const server = Bun.serve<Connection>({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    maxRequestBodySize: policy.controlBytes,
    idleTimeout: 10,
    async fetch(request, bunServer) {
      const authority = `127.0.0.1:${bunServer.port}`;
      const url = new URL(request.url);
      const privileged =
        url.pathname.startsWith("/api/") || url.pathname === "/terminal";
      if (stopping || !validRequestAuthority(request, authority, privileged))
        return response(403, { error: "Request rejected" });
      if (!privileged) {
        if (request.method !== "GET" || url.search)
          return response(404, { error: "Not found" });
        const asset = assets.browserAssetResponse(url.pathname);
        if (!asset) return response(404, { error: "Not found" });
        asset.headers.set(
          "content-security-policy",
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        );
        asset.headers.set("referrer-policy", "no-referrer");
        return asset;
      }
      if (requests >= 32)
        return response(429, { error: "Request capacity reached" });
      requests++;
      const controller = new AbortController();
      let settled!: () => void;
      inFlight.set(
        controller,
        new Promise<void>((resolve) => {
          settled = resolve;
        }),
      );
      try {
        if (
          url.pathname === "/api/bootstrap" &&
          request.method === "POST" &&
          !url.search
        ) {
          let body: typeof Bootstrap.Type;
          try {
            body = decode(
              Bootstrap,
              await boundedJson(request, controller.signal),
            );
          } catch {
            auth.exchange("");
            return response(400, { error: "Bootstrap rejected" });
          }
          if (stopping) return response(503, { error: "Endpoint stopped" });
          const cookie = auth.exchange(body.secret);
          return cookie
            ? new Response(null, {
                status: 204,
                headers: { "set-cookie": cookie, "cache-control": "no-store" },
              })
            : response(403, { error: "Bootstrap rejected" });
        }
        const owner = auth.owner(request);
        if (!owner)
          return response(401, { error: "Browser authentication required" });
        if (
          url.pathname === "/api/attachments" &&
          request.method === "POST" &&
          !url.search
        ) {
          const body = decode(
            CreateLocalAttachment,
            await boundedJson(request, controller.signal),
          );
          if (stopping) return response(503, { error: "Endpoint stopped" });
          let expected: LocalTarget | undefined;
          let recovery: ReturnType<typeof recoveries.get>;
          if (body.reconnect) {
            const previous = attachments.get(body.reconnect.attachmentId);
            if (
              previous &&
              previous.owner === owner &&
              same(previous.ref, body.reconnect) &&
              !previous.closing
            )
              void close(previous, "Replacing attachment for fresh recovery");
            recovery = recoveries.get(body.reconnect.attachmentId);
            if (
              !recovery ||
              recovery.owner !== owner ||
              !same(recovery.ref, body.reconnect) ||
              now() >= recovery.expires
            )
              return response(410, {
                error:
                  "Recovery expired or unavailable; open a new terminal explicitly",
              });
            if (!recovery.settled)
              return response(409, {
                error: "Previous attachment cleanup is still in progress",
              });
            if (!recovery.target)
              return response(410, {
                error: "Workspace or session disappeared; recovery stopped",
              });
            expected = recovery.target;
          }
          let task = recovery?.creation;
          if (!task) {
            if (attachments.size + reserved >= policy.maxAttachments)
              return response(429, { error: "Attachment capacity reached" });
            task = launch(owner, body.dimensions, expected);
            if (recovery) recovery.creation = task;
            preparations.add(task);
            const preparation = task;
            void task
              .finally(() => preparations.delete(preparation))
              .catch(() => {});
          }
          const a = await within(task, policy.handshakeMs);
          if (
            !valid(a) ||
            a.activated ||
            a.readyAt === undefined ||
            now() - a.readyAt >= policy.handshakeMs
          )
            return response(410, {
              error: "Recovery attachment expired or already connected",
            });
          return response(201, {
            ref: a.ref,
            target: a.target,
            dimensions: a.dimensions,
            policy,
          });
        }

        if (
          url.pathname === "/api/tickets" &&
          request.method === "POST" &&
          !url.search
        ) {
          const body = decode(
            TicketRequest,
            await boundedJson(request, controller.signal),
          );
          const a = attachments.get(body.ref.attachmentId);
          if (
            !a ||
            a.owner !== owner ||
            !same(a.ref, body.ref) ||
            !valid(a) ||
            a.activated
          )
            return response(409, { error: "Attachment unavailable" });
          for (const [key, ticket] of tickets)
            if (now() >= ticket.expires) tickets.delete(key);
          forgetTickets(a);
          if (tickets.size >= policy.maxTickets)
            return response(429, { error: "Ticket capacity reached" });
          const key = randomBytes(32).toString("base64url");
          const ticket = {
            attachment: a,
            owner,
            streamId: randomUUID(),
            expires: now() + policy.ticketMs,
          };
          tickets.set(key, ticket);
          return response(201, {
            ticket: key,
            streamId: ticket.streamId,
            expiresAt: ticket.expires,
          });
        }
        if (
          url.pathname === "/terminal" &&
          request.method === "GET" &&
          request.headers.get("upgrade")?.toLowerCase() === "websocket"
        ) {
          if ([...url.searchParams.keys()].join() !== "ticket")
            return response(403, { error: "Ticket rejected" });
          const key = url.searchParams.get("ticket") ?? "";
          const ticket = tickets.get(key);
          if (
            !ticket ||
            ticket.owner !== owner ||
            now() >= ticket.expires ||
            !valid(ticket.attachment) ||
            ticket.attachment.readyAt === undefined ||
            now() - ticket.attachment.readyAt >= policy.handshakeMs ||
            ticket.attachment.activated
          )
            return response(403, { error: "Ticket rejected" });
          const a = ticket.attachment;
          // No await between validation, consumption, and stream fencing.
          forgetTickets(a);
          a.activated = true;
          a.streamId = ticket.streamId;
          if (
            bunServer.upgrade(request, {
              data: { attachment: a, streamId: ticket.streamId },
            })
          )
            return;
          void close(a, "WebSocket upgrade failed");
          return response(400, { error: "Upgrade failed" });
        }
        return response(404, { error: "Not found" });
      } catch {
        return response(400, {
          error:
            "Local terminal request rejected; Workspace or session may have disappeared",
        });
      } finally {
        requests--;
        inFlight.delete(controller);
        settled();
      }
    },
    websocket: {
      maxPayloadLength: 4 + policy.controlBytes + policy.dataBytes,
      backpressureLimit:
        policy.outputBytes - policy.controlBytes - policy.dataBytes - 4,
      closeOnBackpressureLimit: true,
      perMessageDeflate: false,
      idleTimeout: 0,
      sendPings: false,
      open(ws) {
        const a = ws.data.attachment;
        if (!valid(a) || a.streamId !== ws.data.streamId) {
          ws.terminate();
          return;
        }
        a.socket = ws;
        a.lastPong = now();
        try {
          send(a, header(a, "target", 0));
          pump(a);
        } catch {
          void close(a);
        }
      },
      message: receive,
      pong(ws) {
        if (valid(ws.data.attachment, ws)) ws.data.attachment.lastPong = now();
      },
      close(ws) {
        if (ws.data.attachment.socket === ws) void close(ws.data.attachment);
      },
      drain(ws) {
        pump(ws.data.attachment);
      },
    },
    error() {
      return response(500, { error: "Local terminal failure" });
    },
  });
  const timer = setInterval(() => {
    for (const [key, ticket] of tickets)
      if (now() >= ticket.expires) tickets.delete(key);
    for (const [key, recovery] of recoveries)
      if (now() >= recovery.expires) recoveries.delete(key);
    for (const a of attachments.values()) {
      if (a.closing) continue;
      if (
        !auth.alive(a.owner) ||
        (!a.socket &&
          a.readyAt !== undefined &&
          now() - a.readyAt >= policy.handshakeMs) ||
        (a.socket && now() - a.lastPong >= policy.heartbeatMs)
      ) {
        void close(a, "Terminal authentication or heartbeat expired");
        continue;
      }
      if (a.sent[0] && now() - a.sent[0].at >= policy.renderMs) {
        void close(a, "Terminal renderer acknowledgement timed out");
        continue;
      }
      if (a.socket) pump(a);
      if (a.socket && now() - a.lastPing >= policy.pingMs) {
        a.lastPing = now();
        a.socket.ping();
      }
    }
  }, 1000);
  let stopped: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${server.port}/`,
    bootstrapUrl: `http://127.0.0.1:${server.port}/#${auth.bootstrap}`,
    stop() {
      if (stopped) return stopped;
      stopping = true;
      stopped = (async () => {
        clearInterval(timer);
        tickets.clear();
        auth.clear();
        for (const controller of inFlight.keys()) controller.abort();
        await Promise.allSettled(inFlight.values());
        await Promise.allSettled(
          [...attachments.values()].map((a) => close(a, "Endpoint stopped")),
        );
        await Promise.allSettled(preparations);
        await server.stop(true);
      })();
      return stopped;
    },
  };
}
