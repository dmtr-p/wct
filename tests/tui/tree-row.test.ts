import { describe, expect, test } from "vitest";
import { selectedRowFill } from "../../src/tui/components/tree-row";

describe("selectedRowFill", () => {
  test("fills by terminal columns for wide selected labels", () => {
    expect(selectedRowFill(true, 10, " 功能")).toBe(" ".repeat(5));
  });

  test("does not fill unselected rows", () => {
    expect(selectedRowFill(false, 10, " 功能")).toBe("");
  });
});
