import { describe, expect, test } from "vitest";
import {
  clampListScrollOffset,
  filterItems,
  getListPaddingCount,
  getScrollbarThumb,
  getVisibleWindow,
  scrollToRevealListItem,
} from "../../src/tui/components/ScrollableList";

describe("filterItems", () => {
  const items = [
    { label: "feat/auth", value: "feat/auth" },
    { label: "fix/cors", value: "fix/cors" },
    { label: "chore/deps", value: "chore/deps" },
  ];

  test("returns all items when query is empty", () => {
    expect(filterItems(items, "")).toEqual(items);
  });

  test("filters by substring match", () => {
    expect(filterItems(items, "feat")).toEqual([items[0]]);
  });

  test("is case insensitive", () => {
    expect(filterItems(items, "CORS")).toEqual([items[1]]);
  });

  test("returns empty when no match", () => {
    expect(filterItems(items, "xyz")).toEqual([]);
  });
});

describe("getVisibleWindow", () => {
  test("returns all items when fewer than maxVisible", () => {
    const result = getVisibleWindow(3, 0, 10);
    expect(result).toEqual({
      start: 0,
      end: 3,
      hasAbove: false,
      hasBelow: false,
    });
  });

  test("returns window around selected index", () => {
    const result = getVisibleWindow(20, 12, 10);
    expect(result.end - result.start).toBe(10);
    expect(result.start).toBeLessThanOrEqual(12);
    expect(result.end).toBeGreaterThan(12);
    expect(result.hasAbove).toBe(true);
    expect(result.hasBelow).toBe(true);
  });

  test("clamps to start", () => {
    const result = getVisibleWindow(20, 0, 10);
    expect(result).toEqual({
      start: 0,
      end: 10,
      hasAbove: false,
      hasBelow: true,
    });
  });

  test("clamps to end", () => {
    const result = getVisibleWindow(20, 19, 10);
    expect(result).toEqual({
      start: 10,
      end: 20,
      hasAbove: true,
      hasBelow: false,
    });
  });
});

describe("getScrollbarThumb", () => {
  test("hides the scrollbar when every item fits", () => {
    expect(getScrollbarThumb(8, 8, 0)).toBeNull();
    expect(getScrollbarThumb(3, 8, 0)).toBeNull();
  });

  test("places the thumb at the start and end of an overflowing list", () => {
    expect(getScrollbarThumb(20, 8, 0)).toEqual({ start: 0, end: 3 });
    expect(getScrollbarThumb(20, 8, 12)).toEqual({ start: 5, end: 8 });
  });

  test("keeps a usable one-row thumb for very long lists", () => {
    expect(getScrollbarThumb(209, 8, 100)).toEqual({ start: 3, end: 4 });
  });
});

describe("list scroll offsets", () => {
  test("clamps offsets to the scrollable range", () => {
    expect(clampListScrollOffset(-1, 20, 8)).toBe(0);
    expect(clampListScrollOffset(99, 20, 8)).toBe(12);
  });

  test("reveals keyboard and click selections with minimal movement", () => {
    expect(scrollToRevealListItem(4, 3, 20, 8)).toBe(3);
    expect(scrollToRevealListItem(4, 12, 20, 8)).toBe(5);
    expect(scrollToRevealListItem(4, 8, 20, 8)).toBe(4);
  });
});

describe("getListPaddingCount", () => {
  test("reserves five option rows for short and empty lists", () => {
    expect(getListPaddingCount(0, 5)).toBe(5);
    expect(getListPaddingCount(1, 5)).toBe(4);
    expect(getListPaddingCount(5, 5)).toBe(0);
  });
});
