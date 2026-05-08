import { describe, expect, test } from "vitest";
import { Mode, pendingKey } from "../../src/tui/types";

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
