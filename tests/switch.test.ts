import { describe, expect, test } from "bun:test";
import { commandDef, switchCommand } from "../src/commands/switch";
import { formatSessionName } from "../src/services/tmux";

describe("switchCommand", () => {
  test("is exported as a function", () => {
    expect(typeof switchCommand).toBe("function");
  });
});

describe("switch commandDef", () => {
  test("has correct name", () => {
    expect(commandDef.name).toBe("switch");
  });

  test("has sw alias", () => {
    expect(commandDef.aliases).toContain("sw");
  });

  test("has worktree completionType", () => {
    expect(commandDef.completionType).toBe("worktree");
  });

  test("requires a branch argument", () => {
    expect(commandDef.args).toBe("<branch>");
  });
});

describe("switch session name derivation", () => {
  test("derives session name from worktree directory basename", () => {
    const sessionName = formatSessionName("myapp-feature-auth");
    expect(sessionName).toBe("myapp-feature-auth");
  });

  test("sanitizes special characters in dirname", () => {
    const sessionName = formatSessionName("myapp.feature");
    expect(sessionName).toBe("myapp-feature");
  });

  test("preserves underscores and hyphens", () => {
    const sessionName = formatSessionName("my_app-feature");
    expect(sessionName).toBe("my_app-feature");
  });
});
