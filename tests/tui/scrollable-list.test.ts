import { describe, expect, test } from "vitest";
import {
  filterItems,
  getVisibleWindow,
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
