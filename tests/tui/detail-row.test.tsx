import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";
import { DetailRow } from "../../src/tui/components/DetailRow";
import type { TreeItem } from "../../src/tui/types";

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
    debug: true,
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
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pane",
        label: "main:0 bash",
        meta: {
          paneId: "%0",
          zoomed: true,
          active: true,
          window: "main",
          paneIndex: 0,
          command: "bash",
        },
      } as Extract<TreeItem, { type: "detail"; detailKind: "pane" }>,
      isSelected: false,
      maxWidth: 80,
    });
    const zoomedInactive = await renderDetailRow({
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pane",
        label: "main:1 node",
        meta: {
          paneId: "%1",
          zoomed: true,
          active: false,
          window: "main",
          paneIndex: 1,
          command: "node",
        },
      } as Extract<TreeItem, { type: "detail"; detailKind: "pane" }>,
      isSelected: false,
      maxWidth: 80,
    });
    const unzoomedActive = await renderDetailRow({
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pane",
        label: "main:2 zsh",
        meta: {
          paneId: "%2",
          zoomed: false,
          active: true,
          window: "main",
          paneIndex: 2,
          command: "zsh",
        },
      } as Extract<TreeItem, { type: "detail"; detailKind: "pane" }>,
      isSelected: false,
      maxWidth: 80,
    });

    expect(zoomedActive.output).toContain("🔍");
    expect(zoomedInactive.output).not.toContain("🔍");
    expect(unzoomedActive.output).not.toContain("🔍");

    zoomedActive.unmount();
    zoomedInactive.unmount();
    unzoomedActive.unmount();
  });

  test("renders full pane label when width is sufficient", async () => {
    // overhead=10, available=70, "1:0 vim" (7) fits
    const { output, unmount } = await renderDetailRow({
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pane",
        label: "1:0 vim",
        meta: {
          paneId: "%0",
          zoomed: false,
          active: false,
          window: "1",
          paneIndex: 0,
          command: "vim",
        },
      } as Extract<TreeItem, { type: "detail"; detailKind: "pane" }>,
      isSelected: false,
      maxWidth: 80,
    });
    expect(output).toContain("1:0 vim");
    unmount();
  });

  test("preserves window:index prefix when command is long", async () => {
    // overhead=10 (indent 8 + selectorPrefix 2), maxWidth=20 → available=10
    // prefix "1:0 " (4), rest "bun run dev" (11)
    // 15 > 10, available(10) > prefix+3(7) → "1:0 " + truncateBranch("bun run dev", 6)
    // → "1:0 bun..."
    const { output, unmount } = await renderDetailRow({
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pane",
        label: "1:0 bun run dev",
        meta: {
          paneId: "%0",
          zoomed: false,
          active: false,
          window: "1",
          paneIndex: 0,
          command: "bun run dev",
        },
      } as Extract<TreeItem, { type: "detail"; detailKind: "pane" }>,
      isSelected: false,
      maxWidth: 20,
    });
    expect(output).toContain("1:0 ");
    expect(output).toContain("bun...");
    expect(output).not.toContain("bun run dev");
    unmount();
  });

  test("truncates pane-header label when width is tight", async () => {
    // overhead=8 (indent 6 + selectorPrefix 2), maxWidth=15 → available=7
    // "Panes (3)" (9) → "Pane..."
    const { output, unmount } = await renderDetailRow({
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pane-header",
        label: "Panes (3)",
      } as Extract<TreeItem, { type: "detail"; detailKind: "pane-header" }>,
      isSelected: false,
      maxWidth: 15,
    });
    expect(output).toContain("Pane...");
    expect(output).not.toContain("Panes (3)");
    unmount();
  });

  test("truncates check label when width is tight", async () => {
    // overhead=12 (indent 8 + selectorPrefix 2 + icon 1 + space 1), maxWidth=20 → available=8
    // "ci/backend" (10) → "ci/ba..."
    const { output, unmount } = await renderDetailRow({
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "check",
        label: "ci/backend",
        meta: { state: "success" },
      } as Extract<TreeItem, { type: "detail"; detailKind: "check" }>,
      isSelected: false,
      maxWidth: 20,
    });
    expect(output).toContain("ci/ba...");
    expect(output).not.toContain("ci/backend");
    unmount();
  });
});
