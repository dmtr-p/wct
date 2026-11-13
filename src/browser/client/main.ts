/// <reference lib="dom" />
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  decodeFrame,
  encodeFrame,
  type LocalHeader,
  type LocalRef,
  type LocalTarget,
  policy,
  same,
} from "../protocol";

// Clear the fragment before any network exchange, including failed bootstrap.
const secret = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const container = document.getElementById("terminal");
const status = document.getElementById("status");
function display(message: string) {
  if (status) status.textContent = message;
}
async function post(path: string, body: unknown) {
  const result = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!result.ok)
    throw new Error(
      result.status === 401 || result.status === 403
        ? "Authentication expired or rejected. Use the CLI bootstrap link."
        : "Terminal request rejected. Open a fresh tab or check the CLI.",
    );
  return result.status === 204 ? undefined : result.json();
}
async function connect(container: HTMLElement) {
  if (secret) await post("/api/bootstrap", { secret });
  const terminal = new Terminal({ disableStdin: true, scrollback: 5000 });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);
  fit.fit();
  const dimensions = () => ({
    cols: Math.min(500, Math.max(1, terminal.cols)),
    rows: Math.min(200, Math.max(1, terminal.rows)),
  });
  const attachment = (await post("/api/attachments", {
    dimensions: dimensions(),
  })) as { ref: LocalRef; target: LocalTarget };
  const ticket = (await post("/api/tickets", { ref: attachment.ref })) as {
    ticket: string;
    streamId: string;
  };
  const url = new URL("/terminal", location.href);
  url.protocol = "ws:";
  url.searchParams.set("ticket", ticket.ticket);
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let target: LocalTarget | undefined;
  let inputSequence = 0;
  let outputSequence = 0;
  let renderBytes = 0;
  let renderFrames = 0;
  function disconnect(message: string) {
    terminal.options.disableStdin = true;
    display(message);
    socket.close();
  }
  socket.onmessage = (event) => {
    try {
      if (!(event.data instanceof ArrayBuffer))
        throw new Error("Expected binary terminal frame");
      const { header, bytes } = decodeFrame(new Uint8Array(event.data));
      if (
        !same(header.ref, attachment.ref) ||
        header.streamId !== ticket.streamId ||
        header.sequence !== outputSequence++
      )
        throw new Error("Stale terminal stream");
      if (header.kind === "target") {
        if (target || !same(header.target, attachment.target))
          throw new Error("Unexpected terminal target");
        target = header.target;
        terminal.options.disableStdin = false;
        terminal.focus();
        display("Connected · Ctrl-B D detaches this tab");
      } else if (
        header.kind === "output" &&
        target &&
        same(target, header.target)
      ) {
        if (
          renderFrames >= 256 ||
          renderBytes + event.data.byteLength + 128 > policy.outputBytes
        )
          throw new Error("Terminal renderer limit reached");
        const retained = event.data.byteLength + 128;
        renderBytes += retained;
        renderFrames++;
        terminal.write(bytes, () => {
          renderBytes -= retained;
          renderFrames--;
        });
      } else throw new Error("Unestablished terminal target");
    } catch {
      disconnect("Terminal stream rejected. Reload for a fresh attachment.");
    }
  };
  function input(bytes: Uint8Array) {
    if (!target || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount + bytes.length > policy.inputBytes) {
      disconnect("Terminal input limit reached.");
      return;
    }
    for (let offset = 0; offset < bytes.length; offset += policy.dataBytes) {
      const part = bytes.subarray(offset, offset + policy.dataBytes);
      const frame = encodeFrame(
        {
          ref: attachment.ref,
          streamId: ticket.streamId as LocalHeader["streamId"],
          target,
          kind: "input",
          sequence: inputSequence++,
          byteLength: part.length,
        },
        part,
      );
      if (socket.bufferedAmount + frame.length > policy.inputBytes) {
        disconnect("Terminal input limit reached.");
        return;
      }
      socket.send(frame);
    }
  }
  terminal.onData((text) => {
    if (text.length > policy.inputBytes / 3) {
      disconnect("Terminal paste exceeds input bound.");
      return;
    }
    input(new TextEncoder().encode(text));
  });
  terminal.onBinary((text) => {
    if (text.length > policy.inputBytes) {
      disconnect("Terminal input exceeds bound.");
      return;
    }
    input(Uint8Array.from(text, (char) => char.charCodeAt(0)));
  });
  socket.onclose = () => {
    terminal.options.disableStdin = true;
    display(
      "Disconnected. Reload to attach again; Workspace workloads keep running.",
    );
  };
  socket.onerror = () =>
    disconnect("Terminal connection failed. Reload to attach again.");
  window.addEventListener("pagehide", () => socket.close(), { once: true });
}
if (container)
  void connect(container).catch((error) =>
    display(error instanceof Error ? error.message : "Terminal startup failed"),
  );
