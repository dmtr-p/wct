import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";
import { DetailRow } from "../../src/tui/components/DetailRow";
import type { TreeItem } from "../../src/tui/types";
import { elementText, hasElementProp } from "./react-elements";

type TestStdout = NodeJS.WriteStream & { columns: number; rows: number };
type TestStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
};

function createStdoutStdin(columns = 80) {
  const stdout = new PassThrough() as unknown as TestStdout;
  stdout.columns = columns;
  stdout.rows = 24;
  const stdin = new PassThrough() as unknown as TestStdin;
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  return { stdout, stdin };
}

async function renderDetailRow(props: React.ComponentProps<typeof DetailRow>) {
  const { stdout, stdin } = createStdoutStdin(props.maxWidth);
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
  test("keeps minimum-width detail rows single-line", async () => {
    const { output, unmount } = await renderDetailRow({
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pane-header",
        label: "Panes (20)",
      },
      isSelected: false,
      maxWidth: 4,
    });

    expect(output.trim().split("\n")).toHaveLength(1);
    unmount();
  });

  test("uses a background highlight without a cursor glyph", async () => {
    const props = {
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pane-header",
        label: "Panes (2)",
      },
      isSelected: true,
      maxWidth: 80,
    } satisfies React.ComponentProps<typeof DetailRow>;
    const { output, unmount } = await renderDetailRow(props);

    expect(hasElementProp(DetailRow(props), "backgroundColor", "cyan")).toBe(
      true,
    );
    expect(hasElementProp(DetailRow(props), "color", "#f2f2f2")).toBe(true);
    expect(elementText(DetailRow(props))).toContain(
      `     Panes (2)${" ".repeat(66)}`,
    );
    expect(output).not.toContain("▸");
    unmount();
  });

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
    // overhead=7, maxWidth=17 → available=10
    // prefix "1:0 " (4), rest "bun run dev" (11)
    // 15 > 10, available(10) > prefix+1(5) → "1:0 " + truncateBranch("bun run dev", 6)
    // → "1:0 bun r…"
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
      maxWidth: 17,
    });
    expect(output).toContain("1:0 ");
    expect(output).toContain("bun r…");
    expect(output).not.toContain("bun run dev");
    unmount();
  });

  test("truncates pane-header label when width is tight", async () => {
    // overhead=5, maxWidth=12 → available=7
    // "Panes (3)" (9) → "Panes …"
    const { output, unmount } = await renderDetailRow({
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pane-header",
        label: "Panes (3)",
      } as Extract<TreeItem, { type: "detail"; detailKind: "pane-header" }>,
      isSelected: false,
      maxWidth: 12,
    });
    expect(output).toContain("Panes …");
    expect(output).not.toContain("Panes (3)");
    unmount();
  });

  test("renders rollup success icon for pr row", async () => {
    const { output, unmount } = await renderDetailRow({
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pr",
        label: "PR #42: fix login (OPEN)",
        meta: { rollupState: "success" as const },
      } as Extract<TreeItem, { type: "detail"; detailKind: "pr" }>,
      isSelected: false,
      maxWidth: 80,
    });
    expect(output).toContain("✓");
    expect(output).toContain("PR #42: fix login (OPEN)");
    unmount();
  });

  test("renders one wrapped PR piece as one physical row", async () => {
    const label =
      "PR #99: this pull request title is much wider than the terminal (OPEN)";
    const props = {
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pr",
        label,
        meta: { rollupState: "success" as const },
      },
      isSelected: false,
      maxWidth: 24,
      prLine: "PR #99: this pull",
    } satisfies React.ComponentProps<typeof DetailRow>;
    const { output, unmount } = await renderDetailRow(props);
    const text = elementText(DetailRow(props));

    expect(text.length).toBeLessThanOrEqual(24);
    expect(text).not.toContain("…");
    expect(text).not.toContain(label);
    expect(output.trim().split("\n")).toHaveLength(1);
    unmount();
  });

  test("renders rollup failure icon for pr row", async () => {
    const { output, unmount } = await renderDetailRow({
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pr",
        label: "PR #43: broken build (OPEN)",
        meta: { rollupState: "failure" as const },
      } as Extract<TreeItem, { type: "detail"; detailKind: "pr" }>,
      isSelected: false,
      maxWidth: 80,
    });
    expect(output).toContain("✗");
    unmount();
  });

  test("renders rollup pending icon for pr row", async () => {
    const { output, unmount } = await renderDetailRow({
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pr",
        label: "PR #44: in progress (OPEN)",
        meta: { rollupState: "pending" as const },
      } as Extract<TreeItem, { type: "detail"; detailKind: "pr" }>,
      isSelected: false,
      maxWidth: 80,
    });
    expect(output).toContain("◌");
    unmount();
  });

  test("wraps a long pr label instead of truncating it", async () => {
    // maxWidth=30, hasIcon → budget=20. Word-wrap yields
    // ["PR #7: fix the login", "flow (OPEN)"]: piece 0 is the primary line,
    // piece 1 the continuation. The full title survives, no ellipsis.
    const label = "PR #7: fix the login flow (OPEN)";
    const item = {
      type: "detail",
      repoIndex: 0,
      worktreeIndex: 0,
      detailKind: "pr",
      label,
      meta: { rollupState: "success" as const },
    } as Extract<TreeItem, { type: "detail"; detailKind: "pr" }>;

    const primary = await renderDetailRow({
      item,
      isSelected: false,
      maxWidth: 30,
      pieceIndex: 0,
    });
    const continuation = await renderDetailRow({
      item,
      isSelected: false,
      maxWidth: 30,
      pieceIndex: 1,
    });

    // The primary line shows the icon and the start of the title; the
    // continuation line shows a later part. Nothing is replaced by an ellipsis.
    expect(primary.output).toContain("✓");
    expect(primary.output).toContain("PR #7: fix the login");
    expect(primary.output).not.toContain("…");
    expect(continuation.output).not.toContain("…");
    // The tail of the title lands on the continuation line, not the primary.
    expect(continuation.output).toContain("flow (OPEN)");
    expect(primary.output).not.toContain("(OPEN)");

    primary.unmount();
    continuation.unmount();
  });

  test("renders no rollup icon for pr row when rollupState is null", async () => {
    const { output, unmount } = await renderDetailRow({
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pr",
        label: "PR #45: no checks (OPEN)",
        meta: { rollupState: null },
      } as Extract<TreeItem, { type: "detail"; detailKind: "pr" }>,
      isSelected: false,
      maxWidth: 80,
    });
    expect(output).not.toContain("✓");
    expect(output).not.toContain("✗");
    expect(output).not.toContain("◌");
    expect(output).toContain("PR #45: no checks (OPEN)");
    unmount();
  });
});
