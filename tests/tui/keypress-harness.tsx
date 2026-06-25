import { PassThrough } from "node:stream";
import type React from "react";

export const CTRL_ENTER = "\x1b[13;5u";
export const ENTER = "\r";
export const UP_ARROW = "\x1b[A";
export const DOWN_ARROW = "\x1b[B";
export const TAB = "\t";
export const SHIFT_TAB = "\x1b[Z";

type TestStdout = NodeJS.WriteStream & { columns: number; rows: number };
type TestStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
  ref: () => NodeJS.ReadStream;
  unref: () => NodeJS.ReadStream;
};

function stripAnsi(value: string) {
  let output = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value.charAt(i);
    if (char === "\u001B" && value.charAt(i + 1) === "[") {
      i += 2;
      while (i < value.length && !/[\x40-\x7E]/.test(value.charAt(i))) {
        i += 1;
      }
      continue;
    }
    if (char !== "\r") {
      output += char;
    }
  }
  return output;
}

function createStdoutStdin() {
  const stdout = new PassThrough() as unknown as TestStdout;
  stdout.columns = 100;
  stdout.rows = 32;
  const stdin = new PassThrough() as unknown as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return { stdout, stdin };
}

export async function tick(count = 1) {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export async function renderWithInput(node: React.ReactElement) {
  const { stdout, stdin } = createStdoutStdin();
  const chunks: string[] = [];
  stdout.on("data", (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });

  const { render } = await import("ink");
  const instance = render(node, {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  await tick(2);

  return {
    stdin,
    output: () => stripAnsi(chunks.join("")),
    unmount() {
      instance.unmount();
    },
  };
}

export async function sendKeys(
  stdin: NodeJS.ReadStream,
  sequence: string,
  ticks = 3,
) {
  stdin.write(sequence);
  await tick(ticks);
}
