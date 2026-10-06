import { describe, expect, test } from "vitest";
import { Mode, worktreeDisplayKey } from "../../src/tui/types";

describe("worktreeDisplayKey", () => {
  test("formats project/branch", () => {
    expect(worktreeDisplayKey("wct", "feat/tui")).toBe("wct/feat/tui");
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
      Mode.ConfirmDown({
        sessionName: "myapp-feature",
        branch: "feature",
        worktreePath: "/tmp/myapp-feature",
        worktreeKey: "proj/feature",
        repoPath: "/tmp/myapp",
        project: "proj",
      }),
    ).toEqual({
      type: "ConfirmDown",
      sessionName: "myapp-feature",
      branch: "feature",
      worktreePath: "/tmp/myapp-feature",
      worktreeKey: "proj/feature",
      repoPath: "/tmp/myapp",
      project: "proj",
    });
  });

  test("constructs ConfirmRemoveProject mode", () => {
    expect(Mode.ConfirmRemoveProject("/tmp/myapp", "myapp")).toEqual({
      type: "ConfirmRemoveProject",
      repoPath: "/tmp/myapp",
      project: "myapp",
    });
  });
});
