import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";
import { DetailRow } from "../../src/tui/components/DetailRow";
import type { TreeItem } from "../../src/tui/types";
import { prFacts, prRowMeta } from "../helpers/pr";
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
    unmount: () => instance.unmount(),
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

  test.each([
    ["passed", "✓"],
    ["failed", "✗"],
    ["pending", "◌"],
    ["unknown", "?"],
  ] as const)(
    "renders %s checks in the compact PR row",
    async (outcome, icon) => {
      const pr = prFacts({
        checks: [{ name: "test", outcome, required: true }],
      });
      const { output, unmount } = await renderDetailRow({
        item: {
          type: "detail",
          repoIndex: 0,
          worktreeIndex: 0,
          detailKind: "pr",
          label: "#42",
          meta: prRowMeta(pr),
        },
        isSelected: false,
        maxWidth: 80,
      });
      expect(output).toContain("#42");
      expect(output).toContain("checks " + icon);
      expect(output).not.toContain(pr.title);
      expect(output.trim().split("\n")).toHaveLength(1);
      unmount();
    },
  );

  test("renders one wrapped title piece as one physical row", async () => {
    const props = {
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pr-title",
        label: "this pull request title is much wider than the terminal",
        meta: { prKey: "owner/repo#42" },
      },
      isSelected: false,
      maxWidth: 24,
      prLine: "this pull",
    } satisfies React.ComponentProps<typeof DetailRow>;
    const { output, unmount } = await renderDetailRow(props);
    const text = elementText(DetailRow(props));
    expect(text).toBe("         this pull");
    expect(output.trim().split("\n")).toHaveLength(1);
    unmount();
  });

  test("renders stale unknown PR facts with a full-width selection highlight", async () => {
    const props = {
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pr",
        label: "#42 unknown",
        meta: prRowMeta(
          prFacts({
            checks: null,
            checksComplete: false,
            lastError: "offline",
          }),
        ),
      },
      isSelected: true,
      maxWidth: 50,
    } satisfies React.ComponentProps<typeof DetailRow>;
    const { output, unmount } = await renderDetailRow(props);
    expect(output).toContain("unknown");
    expect(output).toContain("stale");
    expect(elementText(DetailRow(props))).toHaveLength(50);
    expect(hasElementProp(DetailRow(props), "backgroundColor", "cyan")).toBe(
      true,
    );
    unmount();
  });

  test("renders a compact PR without a check icon when it has no checks", async () => {
    const { output, unmount } = await renderDetailRow({
      item: {
        type: "detail",
        repoIndex: 0,
        worktreeIndex: 0,
        detailKind: "pr",
        label: "#42 ready",
        meta: prRowMeta(prFacts({ checks: [] })),
      },
      isSelected: false,
      maxWidth: 80,
    });
    expect(output).toContain("#42");
    expect(output).toContain("ready");
    expect(output).not.toContain("checks");
    unmount();
  });
});
