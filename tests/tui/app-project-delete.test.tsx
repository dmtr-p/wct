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
  sendKeys,
  sgrPress,
  tick,
  worktreeFixtures,
} from "./app-harness";

const ENTER = "\r";
const ESCAPE = "\x1b";
const MAC_DELETE = "\x7f";

describe("TUI project deletion", () => {
  let homeDir: string;
  let repoPath: string;

  beforeEach(() => {
    resetHarnessFixtures();
    homeDir = mkdtempSync(join(tmpdir(), "wct-app-delete-home-"));
    repoPath = mkdtempSync(join(tmpdir(), "wct-app-delete-repo-"));
    mkdirSync(join(homeDir, ".wct"), { recursive: true });
    vi.stubEnv("HOME", homeDir);
    worktreeFixtures.byRepoPath.set(repoPath, [
      makeWorktree(repoPath, "main"),
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

  test("ignores Escape while confirmed deletion is pending", async () => {
    const { App } = await import("../../src/tui/App");
    const app = await renderApp(<App />);
    await tick(6);

    await sendKeys(app.stdin, MAC_DELETE);
    expect(app.lines().join("\n")).toContain("Delete project alpha?");
    await sendKeys(app.stdin, ENTER);
    await tick(4);
    expect(lastWorkspaceCall("down")).toBeDefined();

    await sendKeys(app.stdin, ESCAPE);

    expect(app.lines().join("\n")).toContain("Delete project alpha?");
    app.unmount();
  });

  test("ignores the clickable cancel action while deletion is pending", async () => {
    const { App } = await import("../../src/tui/App");
    const app = await renderApp(<App />, 32, 100);
    await tick(6);

    await sendKeys(app.stdin, MAC_DELETE);
    await sendKeys(app.stdin, ENTER);
    await tick(4);
    expect(lastWorkspaceCall("down")).toBeDefined();

    // Project confirmation wraps to two question rows at width 60, putting
    // the anchored modal's cancel action on terminal row 8.
    await sendKeys(app.stdin, sgrPress(18, 8));

    expect(app.lines().join("\n")).toContain("Delete project alpha?");
    app.unmount();
  });
});
