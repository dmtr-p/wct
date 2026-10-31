import { expect, test } from "vitest";
import { workspaceIdentityKey } from "../../src/services/identities";

test("Workspace encoding preserves component boundaries and empty branch prefixes", () => {
  const key = workspaceIdentityKey("/repos/a#b", "feature/c");
  expect(key).toBe("/repos/a#b\0feature/c");
  expect(key).not.toBe(workspaceIdentityKey("/repos/a", "b#feature/c"));
  expect(key).not.toBe(workspaceIdentityKey("/repos/a#b/feature", "c"));
  expect(workspaceIdentityKey("/repos/a#b", "")).toBe("/repos/a#b\0");
});
