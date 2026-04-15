import { PassThrough } from "node:stream";
import { Box, Text } from "ink";
import React from "react";
import { describe, expect, test } from "vitest";
import { TitledBox } from "../../src/tui/components/TitledBox";

type TestStdout = NodeJS.WriteStream & { columns: number; rows: number };
type TestStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
};

function createStdoutStdin() {
  const stdout = new PassThrough() as unknown as TestStdout;
  stdout.columns = 80;
  stdout.rows = 24;
  const stdin = new PassThrough() as unknown as TestStdin;
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  return { stdout, stdin };
}

function stripAnsi(value: string) {
  let output = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value.charAt(i);
    if (char === "\u001B" && value.charAt(i + 1) === "[") {
      i += 2;
      while (i < value.length && !/[A-Za-z@~]/.test(value.charAt(i))) {
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

function collectElements(
  node: React.ReactNode,
  match: (element: React.ReactElement) => boolean,
  results: React.ReactElement[] = [],
) {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectElements(child, match, results);
    }
    return results;
  }

  if (!React.isValidElement(node)) {
    return results;
  }

  if (match(node)) {
    results.push(node);
  }

  const children = (node.props as Record<string, unknown>)
    .children as React.ReactNode;
  if (children !== undefined) {
    collectElements(children, match, results);
  }

  return results;
}

async function renderTitledBox(props: React.ComponentProps<typeof TitledBox>) {
  const { stdout, stdin } = createStdoutStdin();
  const chunks: string[] = [];
  stdout.on("data", (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });

  const { render } = await import("ink");
  const instance = render(<TitledBox {...props} />, {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    rawOutput: chunks.join(""),
    output: stripAnsi(chunks.join("")),
    unmount() {
      instance.unmount();
    },
  };
}

describe("TitledBox", () => {
  test("renders the top border with an embedded title and a bottom border", async () => {
    let rendered: Awaited<ReturnType<typeof renderTitledBox>> | undefined;

    try {
      rendered = await renderTitledBox({
        title: "Open Worktrees",
        isFocused: true,
        width: 28,
        children: "content",
      });

      const lines = rendered.output
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .filter((line) => line.length > 0);

      expect(lines[0]?.startsWith("╭ Open Worktrees ")).toBe(true);
      expect(lines[0]?.endsWith("╮")).toBe(true);
      expect(lines[0]?.length).toBe(28);
      expect(lines[1]).toContain("content");
      expect(lines[lines.length - 1]?.startsWith("╰")).toBe(true);
      expect(lines[lines.length - 1]?.endsWith("╯")).toBe(true);
      expect(lines[lines.length - 1]?.length).toBe(28);
    } finally {
      rendered?.unmount();
    }
  });

  test("truncates the title with an ellipsis when the box is too narrow", async () => {
    let rendered: Awaited<ReturnType<typeof renderTitledBox>> | undefined;

    try {
      rendered = await renderTitledBox({
        title: "A very long title that will not fit",
        isFocused: false,
        width: 18,
        children: "x",
      });

      const lines = rendered.output
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .filter((line) => line.length > 0);

      expect(lines[0]?.startsWith("╭ ")).toBe(true);
      expect(lines[0]).toContain("…");
      expect(lines[0]?.length).toBe(18);
      expect(lines[lines.length - 1]?.startsWith("╰")).toBe(true);
      expect(lines[lines.length - 1]?.endsWith("╯")).toBe(true);
      expect(lines[lines.length - 1]?.length).toBe(18);
    } finally {
      rendered?.unmount();
    }
  });

  test("keeps all rendered border lines within the requested width", async () => {
    const width = 26;
    let rendered: Awaited<ReturnType<typeof renderTitledBox>> | undefined;

    try {
      rendered = await renderTitledBox({
        title: "Status",
        isFocused: true,
        width,
        children: "alpha\nbeta",
      });

      const lines = rendered.output
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .filter((line) => line.length > 0);

      expect(lines.every((line) => line.length <= width)).toBe(true);
    } finally {
      rendered?.unmount();
    }
  });

  test("truncates emoji titles without splitting grapheme clusters", async () => {
    const width = 6;
    let rendered: Awaited<ReturnType<typeof renderTitledBox>> | undefined;

    try {
      rendered = await renderTitledBox({
        title: "👨‍👩‍👧‍👦abc",
        isFocused: false,
        width,
        children: "x",
      });

      const lines = rendered.output
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .filter((line) => line.length > 0);

      expect(lines[0]).toContain("👨‍👩‍👧‍👦…");
    } finally {
      rendered?.unmount();
    }
  });

  test("keeps content lines aligned to the requested width", async () => {
    const width = 24;
    let rendered: Awaited<ReturnType<typeof renderTitledBox>> | undefined;

    try {
      rendered = await renderTitledBox({
        title: "Branch",
        isFocused: true,
        width,
        children: "my-feature",
      });

      const lines = rendered.output
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .filter((line) => line.length > 0);

      expect(lines.every((line) => line.length === width)).toBe(true);
    } finally {
      rendered?.unmount();
    }
  });

  test("renders side borders for every line of multiline content", async () => {
    let rendered: Awaited<ReturnType<typeof renderTitledBox>> | undefined;

    try {
      rendered = await renderTitledBox({
        title: "Logs",
        isFocused: false,
        width: 20,
        children: <Text>{`line one\nline two`}</Text>,
      });

      const lines = rendered.output
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .filter((line) => line.length > 0);

      const contentLines = lines.filter(
        (line) => line.includes("line one") || line.includes("line two"),
      );

      expect(contentLines).toHaveLength(2);
      expect(contentLines.every((line) => line.startsWith("│"))).toBe(true);
      expect(contentLines.every((line) => line.endsWith("│"))).toBe(true);
    } finally {
      rendered?.unmount();
    }
  });

  test("applies focused cyan bold styling and unfocused dim styling", async () => {
    const focusedTree = TitledBox({
      title: "Focused",
      isFocused: true,
      width: 20,
      children: "content",
    });
    const unfocusedTree = TitledBox({
      title: "Unfocused",
      isFocused: false,
      width: 20,
      children: "content",
    });

    const focusedTexts = collectElements(
      focusedTree,
      (element) => element.type === Text,
    );
    const unfocusedTexts = collectElements(
      unfocusedTree,
      (element) => element.type === Text,
    );
    const focusedBoxes = collectElements(
      focusedTree,
      (element) => element.type === Box,
    );
    const unfocusedBoxes = collectElements(
      unfocusedTree,
      (element) => element.type === Box,
    );

    // biome-ignore lint: test introspection requires any casts on React element props
    const p = (node: React.ReactElement) => node.props as any;

    expect(
      focusedTexts.some((node) => p(node).color === "cyan" && p(node).bold),
    ).toBe(true);
    expect(focusedTexts.every((node) => p(node).dimColor !== true)).toBe(true);
    expect(unfocusedTexts.some((node) => p(node).dimColor === true)).toBe(true);
    expect(unfocusedTexts.every((node) => p(node).color !== "cyan")).toBe(true);

    const focusedBorder = focusedBoxes.find(
      (node) => p(node).borderStyle === "round",
    );
    const unfocusedBorder = unfocusedBoxes.find(
      (node) => p(node).borderStyle === "round",
    );

    expect(focusedBorder).toBeDefined();
    expect(unfocusedBorder).toBeDefined();
    const fb = p(focusedBorder as React.ReactElement);
    const ub = p(unfocusedBorder as React.ReactElement);
    expect(fb.borderLeftColor).toBe("cyan");
    expect(fb.borderRightColor).toBe("cyan");
    expect(fb.borderLeftDimColor).toBe(false);
    expect(fb.borderRightDimColor).toBe(false);
    expect(ub.borderLeftDimColor).toBe(true);
    expect(ub.borderRightDimColor).toBe(true);
    expect(ub.borderLeftColor).toBeUndefined();
    expect(ub.borderRightColor).toBeUndefined();
  });
});
