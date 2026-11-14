/// <reference lib="dom" />
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Data } from "effect";
import {
  AttachmentCreated,
  decode,
  decodeFrame,
  encodeFrame,
  type LocalHeader,
  type LocalRef,
  type LocalTarget,
  policy,
  same,
  TicketIssued,
} from "../protocol";

const secret = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const container = document.getElementById("terminal");
const status = document.getElementById("status");
function display(message: string) {
  if (status) status.textContent = message;
}
class RequestFailure extends Data.TaggedError("BrowserRequestFailure")<{
  status: number;
  message: string;
}> {
  constructor(status: number) {
    super({
      status,
      message:
        status === 401 || status === 403
          ? "Authentication expired or rejected. Use the CLI bootstrap link."
          : status === 410 || status === 400
            ? "Workspace or session disappeared, changed, or recovery expired. Open a new terminal explicitly."
            : "Terminal unavailable. Retrying within the recovery window.",
    });
  }
}
async function post(path: string, body: unknown) {
  const result = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!result.ok) throw new RequestFailure(result.status);
  return result.status === 204 ? undefined : result.json();
}
async function supervise(container: HTMLElement) {
  if (secret) await post("/api/bootstrap", { secret });
  let stopped = false;
  let generation = 0;
  let recovery: LocalRef | undefined;
  let recoveryStarted = 0;
  let retry = policy.reconnectMinMs as number;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dispose = () => {};
  function schedule(message: string) {
    if (stopped) return;
    if (!recoveryStarted) recoveryStarted = Date.now();
    if (Date.now() - recoveryStarted >= policy.recoveryMs) {
      stopped = true;
      display(
        "Recovery expired. Open a new terminal explicitly; Workspace workloads keep running.",
      );
      return;
    }
    display(
      `${message}. Reconnecting with a fresh screen; Workspace workloads keep running.`,
    );
    timer = setTimeout(
      () => void attempt(),
      retry * (0.8 + Math.random() * 0.4),
    );
    retry = Math.min(policy.reconnectMaxMs, retry * 2);
  }
  async function attempt() {
    const current = ++generation;
    dispose();
    const terminal = new Terminal({ disableStdin: true, scrollback: 5000 });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();
    const bounded = (size: { cols: number; rows: number }) => ({
      cols: Math.min(500, Math.max(1, size.cols)),
      rows: Math.min(200, Math.max(1, size.rows)),
    });
    let dimensions = bounded(terminal);
    terminal.resize(dimensions.cols, dimensions.rows);
    let socket: WebSocket | undefined;
    let observer: ResizeObserver | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const active = () => alive && !stopped && current === generation;
    dispose = () => {
      alive = false;
      clearTimeout(resizeTimer);
      observer?.disconnect();
      socket?.close();
      terminal.dispose();
    };
    function fail(message: string) {
      if (!active()) return;
      terminal.options.disableStdin = true;
      stopped = true;
      display(message);
      socket?.close();
    }
    try {
      const attachment = decode(
        AttachmentCreated,
        await post("/api/attachments", {
          dimensions,
          ...(recovery ? { reconnect: recovery } : {}),
        }),
      );
      if (!active()) return;
      // Once creation succeeds, a failed handshake recovers this new attachment,
      // never retries the old reference as a new target selection.
      recovery = attachment.ref;
      if (!same(dimensions, attachment.dimensions)) {
        dimensions = attachment.dimensions;
        terminal.resize(dimensions.cols, dimensions.rows);
      }
      const ticket = decode(
        TicketIssued,
        await post("/api/tickets", { ref: attachment.ref }),
      );
      if (!active()) return;
      const url = new URL("/terminal", location.href);
      url.protocol = "ws:";
      url.searchParams.set("ticket", ticket.ticket);
      const ws = (socket = new WebSocket(url));
      ws.binaryType = "arraybuffer";
      let target: LocalTarget | undefined;
      let inputSequence = 0;
      let outputSequence = 0;
      let controlSequence = 0;
      let resizing: { cols: number; rows: number } | undefined;
      let renderBytes = 0;
      const rendering: {
        header: LocalHeader & { target: LocalTarget };
        cost: number;
        done: boolean;
      }[] = [];
      let connectedAt: number | undefined;
      function send(frame: Uint8Array<ArrayBuffer> | string) {
        const length =
          typeof frame === "string"
            ? new TextEncoder().encode(frame).length
            : frame.length;
        if (!active() || ws.readyState !== WebSocket.OPEN) return false;
        if (ws.bufferedAmount + length > policy.inputBytes) {
          fail("Terminal input limit reached. Reload for a fresh attachment.");
          return false;
        }
        ws.send(frame);
        return true;
      }
      function consumed() {
        if (!active()) return;
        let through: (typeof rendering)[number] | undefined;
        while (rendering[0]?.done) {
          through = rendering.shift();
          if (through) renderBytes -= through.cost;
        }
        if (through)
          send(
            encodeFrame({
              ref: attachment.ref,
              streamId: ticket.streamId,
              kind: "ack",
              target: through.header.target,
              sequence: through.header.sequence,
              byteLength: 0,
            }),
          );
      }
      function resize() {
        if (
          !active() ||
          !target ||
          resizing ||
          rendering.length ||
          ws.readyState !== WebSocket.OPEN
        )
          return;
        const proposed = fit.proposeDimensions();
        if (!proposed) return;
        const next = bounded(proposed);
        if (same(next, dimensions)) return;
        resizing = next;
        terminal.options.disableStdin = true;
        send(
          JSON.stringify({
            ref: attachment.ref,
            streamId: ticket.streamId,
            target,
            kind: "resize",
            controlSequence: controlSequence++,
            dimensions: next,
            throughInput: inputSequence === 0 ? null : inputSequence - 1,
          }),
        );
      }
      function queueResize() {
        if (resizeTimer !== undefined) return;
        resizeTimer = setTimeout(() => {
          resizeTimer = undefined;
          resize();
        }, 100);
      }
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(queueResize);
        observer.observe(container);
      }
      ws.onmessage = (event) => {
        if (!active()) return;
        try {
          if (!(event.data instanceof ArrayBuffer))
            throw new Error("Expected binary terminal frame");
          const { header, bytes } = decodeFrame(new Uint8Array(event.data));
          if (
            !same(header.ref, attachment.ref) ||
            header.streamId !== ticket.streamId ||
            header.sequence !== outputSequence++ ||
            header.kind === "input" ||
            header.kind === "ack"
          )
            throw new Error("Stale terminal stream");
          const cost = event.data.byteLength + 128;
          if (
            rendering.length >= 256 ||
            renderBytes + cost > policy.outputBytes
          )
            throw new Error("Terminal renderer limit reached");
          const retained = { header, cost, done: header.kind !== "output" };
          rendering.push(retained);
          renderBytes += cost;
          if (header.kind === "target") {
            if (!target && !same(header.target, attachment.target))
              throw new Error("Unexpected terminal target");
            connectedAt ??= Date.now();
            target = header.target;
            terminal.options.disableStdin = !!resizing;
            terminal.focus();
            display(
              `Connected · ${"sessionName" in target ? target.sessionName : target.branch} · Ctrl-B D detaches this tab`,
            );
          } else if (header.kind === "resized") {
            if (
              !resizing ||
              header.controlSequence !== controlSequence - 1 ||
              !same(header.dimensions, resizing) ||
              !same(header.target, target)
            )
              throw new Error("Unexpected resize acknowledgement");
            if (rendering.some((frame) => frame !== retained && !frame.done))
              throw new Error("Resize overtook renderer consumption");
            dimensions = header.dimensions;
            terminal.resize(dimensions.cols, dimensions.rows);
            resizing = undefined;
            terminal.options.disableStdin = false;
            queueResize();
          } else if (target && same(target, header.target)) {
            terminal.write(bytes, () => {
              if (!active()) return;
              retained.done = true;
              consumed();
              queueResize();
            });
          } else throw new Error("Unestablished terminal target");
          consumed();
        } catch {
          fail("Terminal stream rejected. Reload for a fresh attachment.");
        }
      };
      function input(bytes: Uint8Array) {
        if (
          !active() ||
          !target ||
          resizing ||
          ws.readyState !== WebSocket.OPEN
        )
          return;
        if (ws.bufferedAmount + bytes.length > policy.inputBytes) {
          fail("Terminal input limit reached. Reload for a fresh attachment.");
          return;
        }
        for (
          let offset = 0;
          offset < bytes.length;
          offset += policy.dataBytes
        ) {
          const part = bytes.subarray(offset, offset + policy.dataBytes);
          if (
            !send(
              encodeFrame(
                {
                  ref: attachment.ref,
                  streamId: ticket.streamId,
                  kind: "input",
                  sequence: inputSequence++,
                  byteLength: part.length,
                },
                part,
              ),
            )
          )
            return;
        }
      }
      terminal.onData((text) => {
        if (text.length > policy.inputBytes / 3) {
          fail("Terminal paste exceeds input bound.");
          return;
        }
        input(new TextEncoder().encode(text));
      });
      terminal.onBinary((text) => {
        if (text.length > policy.inputBytes) {
          fail("Terminal input exceeds bound.");
          return;
        }
        input(Uint8Array.from(text, (char) => char.charCodeAt(0)));
      });
      ws.onclose = (event) => {
        if (!active()) return;
        terminal.options.disableStdin = true;
        alive = false;
        observer?.disconnect();
        clearTimeout(resizeTimer);
        if (
          connectedAt !== undefined &&
          Date.now() - connectedAt >= policy.heartbeatMs
        ) {
          retry = policy.reconnectMinMs;
          recoveryStarted = 0;
        }
        schedule(event.reason || "Terminal connection lost");
      };
      ws.onerror = () => {
        if (active()) ws.close();
      };
    } catch (error) {
      if (!active()) return;
      terminal.options.disableStdin = true;
      if (
        error instanceof RequestFailure &&
        ![409, 429, 503].includes(error.status)
      ) {
        fail(error.message);
        return;
      }
      schedule(
        error instanceof Error ? error.message : "Terminal connection lost",
      );
    }
  }
  window.addEventListener(
    "pagehide",
    () => {
      stopped = true;
      generation++;
      clearTimeout(timer);
      dispose();
    },
    { once: true },
  );
  await attempt();
}
if (container)
  void supervise(container).catch((error) =>
    display(error instanceof Error ? error.message : "Terminal startup failed"),
  );
