// App-level lifecycle test for `open`: drives the REAL open modal through Ink's
// input pipeline and asserts on rendered frames, using the harness's deferred
// WorkspaceService so the operation can be observed mid-flight.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  emitWorkspacePhase,
  lastWorkspaceCall,
  makeWorktree,
  registryItems,
  renderApp,
  resetHarnessFixtures,
  sendKeys,
  tick,
  worktreeFixtures,
} from "./app-harness";

const ENTER = "\r";
const CTRL_ENTER = "\x1b[13;5u";

async function openBranchFromModal(stdin: NodeJS.ReadStream, branch: string) {
  await sendKeys(stdin, "o"); // Navigate → OpenModal (mode selector)
  await sendKeys(stdin, ENTER); // selector → New Branch form
  await sendKeys(stdin, branch); // the branch field has initial focus
  await sendKeys(stdin, CTRL_ENTER); // submit
}

describe("TUI open lifecycle", () => {
  let homeDir: string;
  let repoPath: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "wct-app-lifecycle-home-"));
    repoPath = mkdtempSync(join(tmpdir(), "wct-app-lifecycle-repo-"));
    mkdirSync(join(homeDir, ".wct"), { recursive: true });
    vi.stubEnv("HOME", homeDir);
    resetHarnessFixtures();
    worktreeFixtures.byRepoPath.set(repoPath, [makeWorktree(repoPath, "main")]);
    registryItems.items = [
      { id: "repo-1", repo_path: repoPath, project: "alpha" },
    ];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  });

  // AC-7
  test("shows an inert Pending Workspace reading 'Preparing Workspace…' before the worktree exists", async () => {
    const { App } = await import("../../src/tui/App");
    const app = await renderApp(<App />);
    await tick(6);

    expect(app.lines().join("\n")).toContain("main");
    expect(app.lines().join("\n")).not.toContain("feature/new");

    await openBranchFromModal(app.stdin, "feature/new");
    await tick(6);

    const frame = app.lines();
    const text = frame.join("\n");
    // The Pending Workspace and its progress row are both visible even though
    // git knows nothing about the branch yet.
    expect(worktreeFixtures.byRepoPath.get(repoPath)).toHaveLength(1);
    expect(text).toContain("feature/new");
    expect(text).toContain("Preparing Workspace…");

    // Placement: directly beneath the repository's last worktree row block.
    const repoRow = frame.findIndex((line) => line.includes("alpha"));
    const mainRow = frame.findIndex((line) => line.includes("main"));
    const pendingRow = frame.findIndex((line) => line.includes("feature/new"));
    const progressRow = frame.findIndex((line) =>
      line.includes("Preparing Workspace…"),
    );
    expect(repoRow).toBeLessThan(mainRow);
    expect(mainRow).toBeLessThan(pendingRow);
    expect(progressRow).toBe(pendingRow + 1);

    // The service really was called, with a reporter that drives the row.
    const call = lastWorkspaceCall("open");
    expect(call.options.branch).toBe("feature/new");
    expect(call.options.cwd).toBe(repoPath);
    emitWorkspacePhase(call, { _tag: "CreatingWorktree" });
    await tick(3);
    expect(app.lines().join("\n")).toContain("Creating worktree…");
    expect(app.lines().join("\n")).not.toContain("Preparing Workspace…");

    app.unmount();
  });
});
