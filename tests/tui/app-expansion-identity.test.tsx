import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  makeWorktree,
  registryItems,
  renderApp,
  resetHarnessFixtures,
  selectedLine,
  sendKeys,
  sgrPress,
  sgrRowFor,
  tick,
  triggerRefresh,
  worktreeFixtures,
} from "./app-harness";

const { App } = await import("../../src/tui/App");
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ESCAPE = "\x1b";
const BRANCH = "feature/shared";

describe("App Workspace Identity expansion", () => {
  let root: string;
  let a: string;
  let b: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wct-expansion-identity-"));
    a = join(root, "a");
    b = join(root, "b");
    mkdirSync(join(root, ".wct"), { recursive: true });
    vi.stubEnv("HOME", root);
    resetHarnessFixtures();
    registryItems.items = [a, b].map((repoPath, index) => ({
      id: `repo-${index}`,
      repo_path: repoPath,
      project: "org/shared",
    }));
    for (const repoPath of [a, b]) {
      const worktree = makeWorktree(repoPath, BRANCH);
      mkdirSync(worktree.path, { recursive: true });
      worktreeFixtures.byRepoPath.set(repoPath, [worktree]);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  test("keyboard and double-click expansion and collapse affect only the selected Workspace", async () => {
    const app = await renderApp(<App />);
    const expanded = () =>
      app.lines().filter((line) => line.includes(BRANCH) && line.includes("▼"));
    try {
      await tick(20);
      expect(app.lines().filter((line) => line.includes(BRANCH))).toHaveLength(2);
      await sendKeys(app.stdin, DOWN);
      await sendKeys(app.stdin, RIGHT);
      expect(expanded()).toHaveLength(1);
      expect(selectedLine(app.lines())).toContain("▼");

      await sendKeys(app.stdin, DOWN);
      await sendKeys(app.stdin, DOWN);
      expect(selectedLine(app.lines())).toContain(BRANCH);
      expect(selectedLine(app.lines())).not.toContain("▼");
      await sendKeys(app.stdin, RIGHT);
      expect(expanded()).toHaveLength(2);
      await sendKeys(app.stdin, LEFT);
      expect(expanded()).toHaveLength(1);
      expect(selectedLine(app.lines())).not.toContain("▼");

      const row = sgrRowFor(3);
      await sendKeys(app.stdin, sgrPress(3, row));
      await sendKeys(app.stdin, sgrPress(3, row));
      expect(expanded()).toHaveLength(2);
      await sendKeys(app.stdin, sgrPress(3, row));
      await sendKeys(app.stdin, sgrPress(3, row));
      expect(expanded()).toHaveLength(1);
      expect(selectedLine(app.lines())).not.toContain("▼");
    } finally {
      app.unmount();
    }
  });

  test("rename, modal cancel, and confirmation cancel retain the second Workspace target", async () => {
    const app = await renderApp(<App />);
    try {
      await tick(20);
      expect(app.lines().filter((line) => line.includes(BRANCH))).toHaveLength(2);
      await sendKeys(app.stdin, DOWN);
      await sendKeys(app.stdin, DOWN);
      await sendKeys(app.stdin, DOWN);
      await sendKeys(app.stdin, RIGHT);
      registryItems.items = registryItems.items.map((repo) => ({
        ...repo,
        project: "renamed/shared",
      }));
      await triggerRefresh();
      await tick(10);
      expect(app.lines().join("\n")).toContain("renamed/shared");
      expect(selectedLine(app.lines())).toContain(BRANCH);
      expect(selectedLine(app.lines())).toContain("▼");
      expect(
        app
          .lines()
          .filter((line) => line.includes(BRANCH) && line.includes("▼")),
      ).toHaveLength(1);

      await sendKeys(app.stdin, "u");
      await sendKeys(app.stdin, ESCAPE);
      expect(selectedLine(app.lines())).toContain(BRANCH);
      expect(selectedLine(app.lines())).toContain("▼");
      await sendKeys(app.stdin, "c");
      const frame = app.lines();
      const worktreeRows = frame.flatMap((line, index) =>
        line.includes(BRANCH) ? [index] : [],
      );
      const confirmation = frame.findIndex((line) => line.includes("Close"));
      expect(confirmation).toBeGreaterThan(worktreeRows[1] ?? Infinity);
      await sendKeys(app.stdin, ESCAPE);
      expect(selectedLine(app.lines())).toContain(BRANCH);
      expect(selectedLine(app.lines())).toContain("▼");
      await sendKeys(app.stdin, LEFT);
      expect(
        app
          .lines()
          .filter((line) => line.includes(BRANCH) && line.includes("▼")),
      ).toHaveLength(0);
    } finally {
      app.unmount();
    }
  });

  test("refresh prunes a removed Workspace without affecting the other preference", async () => {
    const app = await renderApp(<App />);
    try {
      await tick(20);
      expect(app.lines().filter((line) => line.includes(BRANCH))).toHaveLength(2);
      await sendKeys(app.stdin, DOWN);
      await sendKeys(app.stdin, RIGHT);
      await sendKeys(app.stdin, DOWN);
      await sendKeys(app.stdin, DOWN);
      await sendKeys(app.stdin, RIGHT);
      worktreeFixtures.byRepoPath.set(a, []);
      await triggerRefresh();
      await tick(10);
      expect(selectedLine(app.lines())).toContain(BRANCH);
      expect(selectedLine(app.lines())).toContain("▼");

      worktreeFixtures.byRepoPath.set(a, [makeWorktree(a, BRANCH)]);
      await triggerRefresh();
      await tick(10);
      const branches = app.lines().filter((line) => line.includes(BRANCH));
      expect(branches).toHaveLength(2);
      expect(branches[0]).not.toContain("▼");
      expect(branches[1]).toContain("▼");
    } finally {
      app.unmount();
    }
  });
});
