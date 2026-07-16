import { Text } from "ink";
import type React from "react";
import { describe, expect, test, vi } from "vitest";
import { ModalShortcut } from "../../src/tui/components/ModalShortcut";
import { MouseClickable } from "../../src/tui/components/MouseClickable";

describe("ModalShortcut", () => {
  test("forwards clicks and highlights the legend on hover", () => {
    const onClick = vi.fn();
    const shortcut = ModalShortcut({ label: "esc:back", onClick });

    expect(shortcut.type).toBe(MouseClickable);
    shortcut.props.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);

    const renderLegend = shortcut.props.children as (
      isHovered: boolean,
    ) => React.ReactElement;
    const idle = renderLegend(false);
    const hovered = renderLegend(true);

    expect(idle.type).toBe(Text);
    expect(idle.props).toMatchObject({
      children: "esc:back",
      bold: false,
      dimColor: true,
    });
    expect(hovered.props).toMatchObject({
      children: "esc:back",
      bold: true,
      dimColor: false,
    });
  });
});
