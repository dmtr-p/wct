import { StringDecoder } from "node:string_decoder";
import {
  isX10MousePrefix,
  type MouseEvent,
  parseSgrMouse,
  X10_PAYLOAD_BYTES,
} from "./mouse";

const mouseSubscriptions = new WeakMap<
  NodeJS.ReadableStream,
  Set<(event: MouseEvent) => void>
>();

export function subscribeMouseInput(
  stdin: NodeJS.ReadableStream,
  listener: (event: MouseEvent) => void,
): () => void {
  const listeners = mouseSubscriptions.get(stdin);
  listeners?.add(listener);
  return () => {
    listeners?.delete(listener);
  };
}

/**
 * Observe Ink's read() calls before Ink 8 drops mouse reports. Ink remains the
 * only reader: no data listener, pipe, or competing read loop is added. Keyboard
 * bytes, escape prefixes, and bracketed paste reach Ink without extra delay.
 * Only X10 payloads are removed, before UTF-8 decoding changes their byte counts.
 */
export function createTerminalInput(source: NodeJS.ReadableStream) {
  const listeners = new Set<(event: MouseEvent) => void>();
  let pending: Buffer = Buffer.alloc(0);
  let decoder = new StringDecoder("utf8");
  let control = "";
  let x10Remaining = 0;
  let pasting = false;
  let mouse: MouseEvent | null = null;

  const reset = () => {
    pending = Buffer.alloc(0);
    decoder = new StringDecoder("utf8");
    control = "";
    x10Remaining = 0;
    pasting = false;
    mouse = null;
  };
  const read = (): string | null => {
    while (true) {
      // Deliver after the preceding bytes have gone through Ink, preserving
      // the order of keyboard and mouse events even in a single stdin chunk.
      if (mouse) {
        const event = mouse;
        mouse = null;
        for (const listener of [...listeners]) listener(event);
      }
      if (pending.length === 0) {
        const chunk = source.read() as Buffer | string | null;
        if (chunk === null) return null;
        pending = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      }

      const output: number[] = [];
      let consumed = 0;
      for (const byte of pending) {
        consumed++;
        if (x10Remaining > 0) {
          x10Remaining--;
          continue;
        }
        output.push(byte);
        if (byte === 0x1b) {
          control = "\x1b";
        } else if (control === "\x1b" && byte === 0x5b) {
          control += "[";
        } else if (control.startsWith("\x1b[")) {
          control += String.fromCharCode(byte);
          if (byte >= 0x40 && byte <= 0x7e) {
            if (control === "\x1b[200~") pasting = true;
            else if (control === "\x1b[201~") pasting = false;
            else if (!pasting && isX10MousePrefix(control)) {
              // Ink discards the CSI prefix, but would treat its three raw
              // coordinate bytes as typed text without this byte-level filter.
              x10Remaining = X10_PAYLOAD_BYTES;
            } else if (!pasting) {
              mouse = parseSgrMouse(control);
            }
            control = "";
          } else if (control.length > 256) {
            control = "";
          }
        } else {
          control = "";
        }
        if (mouse) break;
      }
      pending = pending.subarray(consumed);
      const decoded = decoder.write(Buffer.from(output));
      if (decoded) return decoded;
    }
  };

  // Forward stream events and TTY/raw-mode/ref ownership to the source. Keep
  // the source in byte mode; the facade alone decodes keyboard text for Ink.
  const stdin = new Proxy(source, {
    get(target, property) {
      if (property === "read") return read;
      if (property === "setEncoding") return () => stdin;
      const value = Reflect.get(target, property, target);
      if (property === "setRawMode" && typeof value === "function") {
        return (enabled: boolean) => {
          if (!enabled) reset();
          value.call(target, enabled);
          return stdin;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  mouseSubscriptions.set(stdin, listeners);

  return {
    stdin,
    dispose() {
      reset();
      listeners.clear();
      mouseSubscriptions.delete(stdin);
    },
  };
}
