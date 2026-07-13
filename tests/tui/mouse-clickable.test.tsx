import { Box, Text } from "ink";
import { describe, expect, test, vi } from "vitest";
import { MouseClickable } from "../../src/tui/components/MouseClickable";
import { renderWithInput, sendKeys } from "./keypress-harness";

const move = (col: number, row: number) => `\x1b[<35;${col};${row}M`;
const click = (col: number, row: number) => `\x1b[<0;${col};${row}M`;

describe("MouseClickable", () => {
  test("tracks hover entry and exit using absolute rendered coordinates", async () => {
    const renderState = vi.fn((isHovered: boolean) => (
      <Text>{isHovered ? "hovered" : "idle"}</Text>
    ));
    const rendered = await renderWithInput(
      <Box marginLeft={4} marginTop={2}>
        <MouseClickable onClick={() => {}}>{renderState}</MouseClickable>
      </Box>,
    );

    try {
      await sendKeys(rendered.stdin, move(5, 3));
      expect(renderState).toHaveBeenLastCalledWith(true);

      await sendKeys(rendered.stdin, move(20, 3));
      expect(renderState).toHaveBeenLastCalledWith(false);
    } finally {
      rendered.unmount();
    }
  });

  test("only invokes clicks inside its offset bounds", async () => {
    const onClick = vi.fn();
    const rendered = await renderWithInput(
      <Box marginLeft={4} marginTop={2}>
        <MouseClickable onClick={onClick}>
          <Text>target</Text>
        </MouseClickable>
      </Box>,
    );

    try {
      await sendKeys(rendered.stdin, click(20, 3));
      expect(onClick).not.toHaveBeenCalled();

      await sendKeys(rendered.stdin, click(5, 3));
      expect(onClick).toHaveBeenCalledTimes(1);
    } finally {
      rendered.unmount();
    }
  });

  test("ignores non-left presses", async () => {
    const onClick = vi.fn();
    const rendered = await renderWithInput(
      <MouseClickable onClick={onClick}>
        <Text>target</Text>
      </MouseClickable>,
    );

    try {
      await sendKeys(rendered.stdin, "\x1b[<2;1;1M");
      expect(onClick).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
    }
  });

  test("invokes the double-click action after two quick clicks", async () => {
    const onClick = vi.fn();
    const onDoubleClick = vi.fn();
    const rendered = await renderWithInput(
      <MouseClickable onClick={onClick} onDoubleClick={onDoubleClick}>
        <Text>target</Text>
      </MouseClickable>,
    );

    try {
      await sendKeys(rendered.stdin, click(1, 1));
      expect(onDoubleClick).not.toHaveBeenCalled();

      await sendKeys(rendered.stdin, click(1, 1));
      expect(onClick).toHaveBeenCalledTimes(2);
      expect(onDoubleClick).toHaveBeenCalledTimes(1);
    } finally {
      rendered.unmount();
    }
  });

  test("does not treat clicks separated by another target as a double-click", async () => {
    const firstDoubleClick = vi.fn();
    const rendered = await renderWithInput(
      <Box flexDirection="column">
        <MouseClickable onClick={() => {}} onDoubleClick={firstDoubleClick}>
          <Text>first</Text>
        </MouseClickable>
        <MouseClickable onClick={() => {}}>
          <Text>second</Text>
        </MouseClickable>
      </Box>,
    );

    try {
      await sendKeys(rendered.stdin, click(1, 1));
      await sendKeys(rendered.stdin, click(1, 2));
      await sendKeys(rendered.stdin, click(1, 1));

      expect(firstDoubleClick).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
    }
  });
});
