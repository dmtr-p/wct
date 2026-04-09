import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";
import { DetailRow } from "../../src/tui/components/DetailRow";

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

async function renderDetailRow(props: React.ComponentProps<typeof DetailRow>) {
  const { stdout, stdin } = createStdoutStdin();
  const chunks: string[] = [];
  stdout.on("data", (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
  const { render } = await import("ink");
  const instance = render(React.createElement(DetailRow, props), {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    output: chunks.join(""),
    unmount() {
      instance.unmount();
    },
  };
}

describe("DetailRow", () => {
  test("renders a zoom indicator only for the active zoomed pane", async () => {
    const zoomedActive = await renderDetailRow({
      kind: "pane",
      label: "main:0 bash",
      isSelected: false,
      meta: { zoomed: true, active: true },
    });
    const zoomedInactive = await renderDetailRow({
      kind: "pane",
      label: "main:1 node",
      isSelected: false,
      meta: { zoomed: true, active: false },
    });
    const unzoomedActive = await renderDetailRow({
      kind: "pane",
      label: "main:2 zsh",
      isSelected: false,
      meta: { zoomed: false, active: true },
    });

    expect(zoomedActive.output).toContain("🔍");
    expect(zoomedInactive.output).not.toContain("🔍");
    expect(unzoomedActive.output).not.toContain("🔍");

    zoomedActive.unmount();
    zoomedInactive.unmount();
    unzoomedActive.unmount();
  });
});
