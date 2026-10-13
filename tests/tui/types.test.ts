import { describe, expect, test } from "vitest";
import { workspaceIdentityKey } from "../../src/tui/lifecycle";
import { Mode } from "../../src/tui/types";

describe("Mode", () => {
  test("constructs ConfirmKill mode", () => {
    expect(
      Mode.ConfirmKill(
        "%1",
        "shell:1 vim",
        workspaceIdentityKey("/tmp/myapp", "branch"),
      ),
    ).toEqual({
      type: "ConfirmKill",
      paneId: "%1",
      label: "shell:1 vim",
      workspaceKey: workspaceIdentityKey("/tmp/myapp", "branch"),
    });
  });

  test("constructs ConfirmDown mode", () => {
    expect(
      Mode.ConfirmDown({
        sessionName: "myapp-feature",
        branch: "feature",
        worktreePath: "/tmp/myapp-feature",
        workspaceKey: workspaceIdentityKey("/tmp/myapp", "feature"),
        repoPath: "/tmp/myapp",
        project: "proj",
      }),
    ).toEqual({
      type: "ConfirmDown",
      sessionName: "myapp-feature",
      branch: "feature",
      worktreePath: "/tmp/myapp-feature",
      workspaceKey: workspaceIdentityKey("/tmp/myapp", "feature"),
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
