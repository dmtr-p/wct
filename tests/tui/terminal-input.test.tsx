import { PassThrough } from "node:stream";
import { type Key, Text, usePaste } from "ink";
import { describe, expect, test, vi } from "vitest";
import { useGuardedInput } from "../../src/tui/hooks/useGuardedInput";
import type { MouseEvent } from "../../src/tui/input/mouse";
import {
  createTerminalInput,
  subscribeMouseInput,
} from "../../src/tui/input/terminal-input";
import { renderWithInput, sendKeys } from "./keypress-harness";

const press = "\x1b[<0;12;3M";
const release = "\x1b[<0;12;3m";
const move = "\x1b[<35;12;3M";
const wheel = "\x1b[<65;12;3M";

function drain(stdin: NodeJS.ReadableStream): string {
  let output = "";
  while (true) {
    const chunk = stdin.read() as string | null;
    if (chunk === null) break;
    output += chunk;
  }
  return output;
}

describe("terminal input read adapter", () => {
  test("keeps Ink as the single reader and preserves keyboard/mouse order", () => {
    const source = new PassThrough();
    const input = createTerminalInput(source);
    const events: string[] = [];
    subscribeMouseInput(input.stdin, (event) => events.push(event.kind));
    source.write(`a${press}b${wheel}c`);
    try {
      while (true) {
        const chunk = input.stdin.read() as string | null;
        if (chunk === null) break;
        events.push(chunk);
      }
      expect(events).toEqual([`a${press}`, "press", `b${wheel}`, "wheel", "c"]);
      expect(source.listenerCount("readable")).toBe(0);
      expect(source.listenerCount("data")).toBe(0);
    } finally {
      input.dispose();
    }
  });

  test.each(Array.from({ length: press.length - 1 }, (_, i) => i + 1))(
    "recognizes a mouse report split at byte %i without holding escape prefixes",
    (split) => {
      const source = new PassThrough();
      const input = createTerminalInput(source);
      const mouse = vi.fn();
      subscribeMouseInput(input.stdin, mouse);
      try {
        source.write(press.slice(0, split));
        expect(drain(input.stdin)).toBe(press.slice(0, split));
        expect(mouse).not.toHaveBeenCalled();
        source.write(press.slice(split));
        expect(drain(input.stdin)).toBe(press.slice(split));
        expect(mouse).toHaveBeenCalledExactlyOnceWith({
          kind: "press",
          button: "left",
          col: 12,
          row: 3,
        });
      } finally {
        input.dispose();
      }
    },
  );

  test("removes split X10 payload bytes before decoding and preserves the next key", () => {
    const source = new PassThrough();
    const input = createTerminalInput(source);
    const mouse = vi.fn();
    subscribeMouseInput(input.stdin, mouse);
    try {
      source.write("a\x1b[");
      expect(drain(input.stdin)).toBe("a\x1b[");
      source.write(Buffer.from([0x4d, 0x20, 0xc2]));
      expect(drain(input.stdin)).toBe("M");
      source.write(Buffer.from([0x80, 0x62]));
      expect(drain(input.stdin)).toBe("b");
      expect(mouse).not.toHaveBeenCalled();
    } finally {
      input.dispose();
    }
  });

  test("decodes Unicode across reads without switching the source out of byte mode", () => {
    const source = new PassThrough();
    const input = createTerminalInput(source);
    try {
      input.stdin.setEncoding("utf8");
      expect(source.readableEncoding).toBeNull();
      let text = "";
      for (const byte of Buffer.from("é界🙂")) {
        source.write(Buffer.from([byte]));
        text += drain(input.stdin);
      }
      expect(text).toBe("é界🙂");
    } finally {
      input.dispose();
    }
  });

  test("keeps bracketed paste literal, including mouse and X10-shaped content", () => {
    const source = new PassThrough();
    const input = createTerminalInput(source);
    const mouse = vi.fn();
    subscribeMouseInput(input.stdin, mouse);
    try {
      const paste = `\x1b[200~text${press}\x1b[Mabc\x1b[201~`;
      let output = "";
      for (const byte of Buffer.from(paste)) {
        source.write(Buffer.from([byte]));
        output += drain(input.stdin);
      }
      expect(output).toBe(paste);
      expect(mouse).not.toHaveBeenCalled();
      source.write(press);
      drain(input.stdin);
      expect(mouse).toHaveBeenCalledOnce();
    } finally {
      input.dispose();
    }
  });

  test("forwards TTY ownership and resets partial protocol state on raw-mode release", () => {
    const source = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn(),
      ref: vi.fn(),
      unref: vi.fn(),
    });
    const input = createTerminalInput(source);
    try {
      const stdin = input.stdin as typeof source;
      expect(stdin.isTTY).toBe(true);
      stdin.setRawMode(true);
      stdin.ref();
      source.write("\x1b[M");
      drain(stdin);
      stdin.setRawMode(false);
      stdin.unref();
      source.write("abc");
      expect(drain(stdin)).toBe("abc");
      expect(source.setRawMode.mock.calls).toEqual([[true], [false]]);
      expect(source.ref).toHaveBeenCalledOnce();
      expect(source.unref).toHaveBeenCalledOnce();
    } finally {
      input.dispose();
    }
  });

  test("unsubscribes callbacks and clears subscriptions on disposal", () => {
    const source = new PassThrough();
    const input = createTerminalInput(source);
    const mouse = vi.fn();
    const unsubscribe = subscribeMouseInput(input.stdin, mouse);
    unsubscribe();
    source.write(press);
    drain(input.stdin);
    expect(mouse).not.toHaveBeenCalled();
    subscribeMouseInput(input.stdin, mouse);
    input.dispose();
    source.write(press);
    drain(input.stdin);
    expect(mouse).not.toHaveBeenCalled();
  });
});

function InputProbe({
  keyboard,
  mouse,
  paste,
  isActive = true,
}: {
  keyboard: (input: string, key: Key) => void;
  mouse: (event: MouseEvent) => void;
  paste: (text: string) => void;
  isActive?: boolean;
}) {
  useGuardedInput(keyboard, { onMouseEvent: mouse, isActive });
  usePaste(paste, { isActive });
  return <Text>input probe</Text>;
}

describe("Ink 8 guarded input integration", () => {
  test("delivers clicks, hover, and wheel while reports and terminal replies never become text", async () => {
    const keyboard = vi.fn();
    const mouse = vi.fn();
    const paste = vi.fn();
    const rendered = await renderWithInput(
      <InputProbe keyboard={keyboard} mouse={mouse} paste={paste} />,
    );
    try {
      await sendKeys(
        rendered.stdin,
        `a${press}${release}${move}${wheel}\x1b[I\x1b[12;34Rb`,
      );
      expect(keyboard.mock.calls.map(([input]) => input)).toEqual(["a", "b"]);
      expect(mouse.mock.calls.map(([event]) => event.kind)).toEqual([
        "press",
        "move",
        "wheel",
      ]);
      expect(keyboard.mock.invocationCallOrder[0]).toBeLessThan(
        mouse.mock.invocationCallOrder[0] ?? 0,
      );
      expect(mouse.mock.invocationCallOrder[2]).toBeLessThan(
        keyboard.mock.invocationCallOrder[1] ?? 0,
      );
      expect(paste).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
    }
  });

  test("handles reports split across stdin writes", async () => {
    const keyboard = vi.fn();
    const mouse = vi.fn();
    const rendered = await renderWithInput(
      <InputProbe keyboard={keyboard} mouse={mouse} paste={vi.fn()} />,
    );
    try {
      await sendKeys(rendered.stdin, "\x1b[<0;12;", 1);
      await sendKeys(rendered.stdin, "3Mx");
      expect(mouse).toHaveBeenCalledOnce();
      expect(keyboard.mock.calls.map(([input]) => input)).toEqual(["x"]);
    } finally {
      rendered.unmount();
    }
  });

  test("legacy X10 clicks do not type coordinates or swallow the following key", async () => {
    const keyboard = vi.fn();
    const mouse = vi.fn();
    const rendered = await renderWithInput(
      <InputProbe keyboard={keyboard} mouse={mouse} paste={vi.fn()} />,
    );
    try {
      rendered.stdin.write(
        Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0x80, 0x23, 0x78]),
      );
      await sendKeys(rendered.stdin, "y");
      expect(keyboard.mock.calls.map(([input]) => input).join("")).toBe("xy");
      expect(mouse).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
    }
  });

  test("literal mouse-shaped paste does not trigger actions", async () => {
    const keyboard = vi.fn();
    const mouse = vi.fn();
    const paste = vi.fn();
    const rendered = await renderWithInput(
      <InputProbe keyboard={keyboard} mouse={mouse} paste={paste} />,
    );
    try {
      await sendKeys(rendered.stdin, `\x1b[200~${press}\x1b[201~`);
      expect(paste).toHaveBeenCalledExactlyOnceWith(press);
      expect(mouse).not.toHaveBeenCalled();
      expect(keyboard).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
    }
  });

  test("inactive hooks receive neither mouse nor keyboard events", async () => {
    const keyboard = vi.fn();
    const mouse = vi.fn();
    const activeKeyboard = vi.fn();
    const activeMouse = vi.fn();
    const rendered = await renderWithInput(
      <>
        <InputProbe
          keyboard={keyboard}
          mouse={mouse}
          paste={vi.fn()}
          isActive={false}
        />
        <InputProbe
          keyboard={activeKeyboard}
          mouse={activeMouse}
          paste={vi.fn()}
        />
      </>,
    );
    try {
      await sendKeys(rendered.stdin, `${press}x`);
      expect(mouse).not.toHaveBeenCalled();
      expect(keyboard).not.toHaveBeenCalled();
      expect(activeMouse).toHaveBeenCalledOnce();
      expect(activeKeyboard.mock.calls.map(([input]) => input)).toEqual(["x"]);
    } finally {
      rendered.unmount();
    }
  });
});
