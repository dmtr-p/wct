import { describe, expect, test } from "vitest";
import { checkColor, checkIcon, pendingKey } from "../../src/tui/types";

describe("pendingKey", () => {
  test("formats project/branch", () => {
    expect(pendingKey("wct", "feat/tui")).toBe("wct/feat/tui");
  });
});

describe("checkIcon", () => {
  test("returns ✓ for SUCCESS", () => {
    expect(checkIcon("SUCCESS")).toBe("✓");
  });
  test("returns ✗ for FAILURE", () => {
    expect(checkIcon("FAILURE")).toBe("✗");
  });
  test("returns ◌ for PENDING", () => {
    expect(checkIcon("PENDING")).toBe("◌");
  });
  test("returns ◌ for IN_PROGRESS", () => {
    expect(checkIcon("IN_PROGRESS")).toBe("◌");
  });
  test("returns ? for unknown state", () => {
    expect(checkIcon("UNKNOWN")).toBe("?");
  });
});

describe("checkColor", () => {
  test("returns green for SUCCESS", () => {
    expect(checkColor("SUCCESS")).toBe("green");
  });
  test("returns red for FAILURE", () => {
    expect(checkColor("FAILURE")).toBe("red");
  });
  test("returns yellow for PENDING", () => {
    expect(checkColor("PENDING")).toBe("yellow");
  });
  test("returns dim for unknown", () => {
    expect(checkColor("SKIPPED")).toBe("dim");
  });
});
