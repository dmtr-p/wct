// App-level regression tests for the expansion AFFORDANCES during a lifecycle.
//
// A Workspace under a lifecycle is *presented* as expanded by
// `isWorktreeEffectivelyExpanded`, but the stored `expandedWorktreeKeys`
// preference is never written by lifecycle code (AC-33). That split used to
// leak into the pointer: `resolveTreeDoubleClickAction` and `canCollapse` were
// fed `presentedWorktreeKeys`, which deliberately excludes the lifecycle
// override — so a Workspace painted `▼` still resolved a double-click to
// `expand-worktree` and wrote the key into the durable preference, leaving it
// expanded after the operation ended.
//
// The pointer toggle is now refused while a lifecycle owns the Workspace,
// consistent with AC-9's "actions targeting it are rejected". Keyboard
// collapse is deliberately NOT refused: that is the user overruling the
// presentation override on purpose, which `collapseWorktree` already documents.
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

  // AC-9, AC-33
  test("a double-click during a lifecycle does not write the stored expansion", async () => {
    const { App } = await import("../../src/tui/App");
    const app = await renderApp(<App />);
    try {
      await tick(12);
      // Select `feature/a`. It is collapsed and has no PR/pane detail, so it
      // carries no expansion marker at all (`WorktreeItem` paints `▶` only for
      // a row with expandable data).
      await sendKeys(app.stdin, DOWN);
      await sendKeys(app.stdin, DOWN);
      expect(selectedLine(app.lines())).toContain("feature/a");
      expect(selectedLine(app.lines())).not.toContain("▼");

      // Start `up`; the harness leaves the call pending, so the lifecycle owns
      // this Workspace and the row flips to the presented-expanded `▼`.
      await sendKeys(app.stdin, "u");
      await sendKeys(app.stdin, CTRL_ENTER);
      await tick(8);
      expect(app.lines().join("\n")).toContain("Preparing Workspace…");
      expect(selectedLine(app.lines())).toContain("▼");

      // Double-click the row (two presses on the same visual row). Before the
      // fix this resolved to `expand-worktree` and wrote the key.
      const row = sgrRowFor(2);
      await sendKeys(app.stdin, sgrPress(3, row));
      await sendKeys(app.stdin, sgrPress(3, row));
      await tick(4);
      // Still `▼` — but from the lifecycle override, not from a stored key.
      expect(selectedLine(app.lines())).toContain("▼");

      // Settle the operation. The proof is here: with nothing written to the
      // stored preference, teardown alone returns the row to unexpanded.
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
