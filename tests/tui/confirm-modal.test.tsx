import { describe, expect, test, vi } from "vitest";
import {
  ConfirmModal,
  type ConfirmMode,
} from "../../src/tui/components/ConfirmModal";
import { Mode } from "../../src/tui/types";
import { renderWithInput, sendKeys } from "./keypress-harness";

const click = (col: number, row: number) => `\x1b[<0;${col};${row}M`;

describe("ConfirmModal", () => {
  test("renders confirmation copy inside the shared modal chrome", async () => {
    const rendered = await renderWithInput(
      <ConfirmModal
        mode={
          Mode.ConfirmKill("%1", "shell:1 vim", "proj/branch") as ConfirmMode
        }
        width={60}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    try {
      expect(rendered.output()).toContain("╭ Kill Pane");
      expect(rendered.output()).toContain("Kill pane shell:1 vim?");
      expect(rendered.output()).toContain("enter:confirm  esc:cancel");
    } finally {
      rendered.unmount();
    }
  });

  test("makes the enter and escape shortcut labels clickable", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const rendered = await renderWithInput(
      <ConfirmModal
        mode={
          Mode.ConfirmDown(
            "myapp-feature",
            "feature",
            "/tmp/myapp-feature",
            "proj/feature",
          ) as ConfirmMode
        }
        width={60}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    try {
      await sendKeys(rendered.stdin, click(3, 4));
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onCancel).not.toHaveBeenCalled();

      await sendKeys(rendered.stdin, click(18, 4));
      expect(onCancel).toHaveBeenCalledTimes(1);
    } finally {
      rendered.unmount();
    }
  });

  test("keeps long confirmation copy to one terminal row", async () => {
    const rendered = await renderWithInput(
      <ConfirmModal
        mode={
          Mode.ConfirmDown(
            "myapp-feature",
            `feature/with-a-very-long-name-${"x".repeat(80)}`,
            "/tmp/myapp-feature",
            "proj/feature",
          ) as ConfirmMode
        }
        width={40}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    try {
      expect(rendered.output().trimEnd().split("\n")).toHaveLength(5);
      expect(rendered.output()).toContain("enter:confirm  esc:cancel");
    } finally {
      rendered.unmount();
    }
  });
});
