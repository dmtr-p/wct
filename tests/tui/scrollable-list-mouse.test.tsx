import { Box } from "ink";
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { ScrollableList } from "../../src/tui/components/ScrollableList";
import { TitledBox } from "../../src/tui/components/TitledBox";
import { useGuardedInput } from "../../src/tui/hooks/useGuardedInput";
import { renderWithInput, sendKeys } from "./keypress-harness";

const wheelDown = "\x1b[<65;1;1M";
const click = (col: number, row: number) => `\x1b[<0;${col};${row}M`;
const sameCountFilterItems = [
  "a0",
  "a1",
  "a2",
  "a3",
  "a4",
  "a5",
  "b0",
  "b1",
  "b2",
  "b3",
  "b4",
  "b5",
].map((value) => ({ label: value, value }));

function SameCountFilterList({
  onSelect,
}: {
  onSelect: (index: number) => void;
}) {
  const [filterQuery, setFilterQuery] = useState("a");
  useGuardedInput((input) => {
    if (input === "b") setFilterQuery("b");
  });
  return (
    <ScrollableList
      items={sameCountFilterItems}
      selectedIndex={0}
      filterQuery={filterQuery}
      isFocused
      onSelect={onSelect}
    />
  );
}

describe("ScrollableList mouse input", () => {
  test("shows five options by default and overlays the thumb on the border", async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      label: `item ${index}`,
      value: String(index),
    }));
    const rendered = await renderWithInput(
      <TitledBox title="Items" isFocused width={24}>
        <ScrollableList
          items={items}
          selectedIndex={0}
          filterQuery=""
          isFocused
          onSelect={() => {}}
        />
      </TitledBox>,
    );

    try {
      expect(rendered.output()).toContain("item 4");
      expect(rendered.output()).not.toContain("item 5");
      expect(rendered.output()).toMatch(/item 0 +█/);
    } finally {
      rendered.unmount();
    }
  });

  test("uses the first of five rows for an active filter", async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      label: `item ${index}`,
      value: String(index),
    }));
    const rendered = await renderWithInput(
      <ScrollableList
        items={items}
        selectedIndex={0}
        filterQuery="item"
        isFocused
        onSelect={() => {}}
      />,
    );

    try {
      const output = rendered.output();
      expect(output.indexOf("filter: item")).toBeLessThan(
        output.indexOf("item 0"),
      );
      expect(output).toContain("item 3");
      expect(output).not.toContain("item 4");
    } finally {
      rendered.unmount();
    }
  });

  test("scrolls the focused viewport without changing selection", async () => {
    const onSelect = vi.fn();
    const items = Array.from({ length: 10 }, (_, index) => ({
      label: `item ${index}`,
      value: String(index),
    }));
    const rendered = await renderWithInput(
      <Box width={30}>
        <ScrollableList
          items={items}
          selectedIndex={2}
          filterQuery=""
          maxVisible={4}
          isFocused
          onSelect={onSelect}
        />
      </Box>,
    );

    try {
      await sendKeys(rendered.stdin, wheelDown);
      expect(onSelect).not.toHaveBeenCalled();
      expect(rendered.output()).toContain("item 4");
    } finally {
      rendered.unmount();
    }
  });

  test("re-reveals selection when filter contents change at the same count", async () => {
    const onSelect = vi.fn();
    const rendered = await renderWithInput(
      <SameCountFilterList onSelect={onSelect} />,
    );

    try {
      await sendKeys(rendered.stdin, wheelDown);
      await sendKeys(rendered.stdin, wheelDown);
      await sendKeys(rendered.stdin, "b");
      await sendKeys(rendered.stdin, click(1, 2));

      expect(onSelect).toHaveBeenCalledWith(0);
    } finally {
      rendered.unmount();
    }
  });

  test("ignores wheel input while unfocused", async () => {
    const rendered = await renderWithInput(
      <ScrollableList
        items={Array.from({ length: 6 }, (_, index) => ({
          label: `item ${index}`,
          value: String(index),
        }))}
        selectedIndex={0}
        filterQuery=""
        isFocused={false}
        onSelect={() => {}}
      />,
    );

    try {
      const initiallyVisible = rendered.output().match(/item \d+/g);
      await sendKeys(rendered.stdin, wheelDown);
      expect(rendered.output().match(/item \d+/g)).toEqual(initiallyVisible);
    } finally {
      rendered.unmount();
    }
  });
});
