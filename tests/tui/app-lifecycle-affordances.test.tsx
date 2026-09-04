// App-level tests for expansion affordances (pointer double-click, keyboard
// collapse) while a Workspace is under a lifecycle.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  lastWorkspaceCall,
  makeWorktree,
  registryItems,
  renderApp,
  resetHarnessFixtures,
  selectedLine,
  sendKeys,
  sgrPress,
  sgrRowFor,
  tick,
  worktreeFixtures,
} from "./app-harness";

const CTRL_ENTER = "\x1b[13;5u";
const DOWN = "\x1b[B";

describe("lifecycle expansion affordances", () => {
  let homeDir: string;
  let repoPath: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "wct-app-afford-home-"));
    repoPath = mkdtempSync(join(tmpdir(), "wct-app-afford-repo-"));
    mkdirSync(join(homeDir, ".wct"), { recursive: true });
    vi.stubEnv("HOME", homeDir);
    resetHarnessFixtures();
    worktreeFixtures.byRepoPath.set(repoPath, [
      makeWorktree(repoPath, "main"),
      makeWorktree(repoPath, "feature/a"),
    ]);
    registryItems.items = [
      { id: "repo-1", repo_path: repoPath, project: "alpha" },
    ];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  });

  function resolveUp(): void {
    lastWorkspaceCall("up").resolve({
      operation: "up",
      worktreePath: join(repoPath, "feature-a"),
      mainRepoPath: repoPath,
      branch: "feature/a",
      sessionName: "feature-a",
      projectName: "alpha",
      env: {},
      warnings: [],
      attempts: { tmux: { attempted: false, reason: "tmux_not_configured" } },
    });
  }

  test("a double-click during a lifecycle does not write the stored expansion", async () => {
    const { App } = await import("../../src/tui/App");
    const app = await renderApp(<App />);
    try {
      await tick(12);
      // A collapsed row with no PR/pane detail carries no expansion marker at
      // all (`WorktreeItem` paints `▶` only for a row with expandable data).
      await sendKeys(app.stdin, DOWN);
      await sendKeys(app.stdin, DOWN);
      expect(selectedLine(app.lines())).toContain("feature/a");
      expect(selectedLine(app.lines())).not.toContain("▼");

      await sendKeys(app.stdin, "u");
      await sendKeys(app.stdin, CTRL_ENTER);
      await tick(8);
      expect(app.lines().join("\n")).toContain("Preparing Workspace…");
      expect(selectedLine(app.lines())).toContain("▼");

      const row = sgrRowFor(2);
      await sendKeys(app.stdin, sgrPress(3, row));
      await sendKeys(app.stdin, sgrPress(3, row));
      await tick(4);
      expect(selectedLine(app.lines())).toContain("▼");

      resolveUp();
      await tick(14);
      expect(app.lines().join("\n")).not.toContain("Preparing Workspace…");
      expect(selectedLine(app.lines())).toContain("feature/a");
      expect(selectedLine(app.lines())).not.toContain("▼");
    } finally {
      app.unmount();
    }
  });
});
