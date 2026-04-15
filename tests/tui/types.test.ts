import { describe, expect, test } from "vitest";
import { checkColor, checkIcon, Mode, pendingKey } from "../../src/tui/types";

describe("pendingKey", () => {
  test("formats project/branch", () => {
    expect(pendingKey("wct", "feat/tui")).toBe("wct/feat/tui");
  });
});

describe("Mode", () => {
  test("constructs ConfirmKill mode", () => {
    expect(Mode.ConfirmKill("%1", "shell:1 vim", "proj/branch")).toEqual({
      type: "ConfirmKill",
      paneId: "%1",
      label: "shell:1 vim",
      worktreeKey: "proj/branch",
    });
  });

  test("constructs ConfirmDown mode", () => {
    expect(
      Mode.ConfirmDown(
        "myapp-feature",
        "feature",
        "/tmp/myapp-feature",
        "proj/feature",
      ),
    ).toEqual({
      type: "ConfirmDown",
      sessionName: "myapp-feature",
      branch: "feature",
      worktreePath: "/tmp/myapp-feature",
      worktreeKey: "proj/feature",
    });
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
  test("returns ◌ for QUEUED", () => {
    expect(checkIcon("QUEUED")).toBe("◌");
  });
  test("returns ⊘ for SKIPPED", () => {
    expect(checkIcon("SKIPPED")).toBe("⊘");
  });
  test("returns ⊘ for CANCELLED", () => {
    expect(checkIcon("CANCELLED")).toBe("⊘");
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
  test("returns yellow for QUEUED", () => {
    expect(checkColor("QUEUED")).toBe("yellow");
  });
  test("returns yellow for IN_PROGRESS", () => {
    expect(checkColor("IN_PROGRESS")).toBe("yellow");
  });
  test("returns dim for SKIPPED", () => {
    expect(checkColor("SKIPPED")).toBe("dim");
  });
  test("returns dim for CANCELLED", () => {
    expect(checkColor("CANCELLED")).toBe("dim");
  });
});
