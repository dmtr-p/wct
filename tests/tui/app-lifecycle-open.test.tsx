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
  selectedLine,
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

  // AC-15
  test("removes the Pending Workspace when validation finds no managed worktree", async () => {
    const { App } = await import("../../src/tui/App");
    const app = await renderApp(<App />);
    await tick(6);

    await openBranchFromModal(app.stdin, "feature/new");
    await tick(6);
    expect(app.lines().join("\n")).toContain("Preparing Workspace…");

    // The open fails before git creates anything, so the refresh that
    // validation runs finds the repository exactly as it was.
    const call = lastWorkspaceCall("open");
    call.reject(new Error("worktree add failed"));
    await tick(12);

    const text = app.lines().join("\n");
    expect(text).not.toContain("feature/new");
    expect(text).not.toContain("Preparing Workspace…");
    expect(text).not.toContain("Validating Workspace…");
    // The fatal error arrives through the ordinary timed action-error display,
    // only after validation — never as a lifecycle row.
    expect(text).toContain("worktree add failed");
    expect(text).toContain("main");

    app.unmount();
  });

  // AC-16
  test("replaces the Pending Workspace with the discovered Workspace when a later phase failed", async () => {
    const { App } = await import("../../src/tui/App");
    const app = await renderApp(<App />);
    await tick(6);

    await openBranchFromModal(app.stdin, "feature/new");
    await tick(6);

    const call = lastWorkspaceCall("open");
    emitWorkspacePhase(call, { _tag: "CreatingWorktree" });
    await tick(3);
    expect(app.lines().join("\n")).toContain("Creating worktree…");

    // The worktree WAS created; a later phase then failed fatally.
    worktreeFixtures.byRepoPath.set(repoPath, [
      makeWorktree(repoPath, "main"),
      makeWorktree(repoPath, "feature/new"),
    ]);
    call.reject(new Error("setup command failed"));
    await tick(12);

    const text = app.lines().join("\n");
    // The Workspace that really exists on disk stays in the tree, with no
    // stale phase text left behind, and the failure is reported afterwards.
    expect(text).toContain("feature/new");
    expect(text).not.toContain("Creating worktree…");
    expect(text).not.toContain("Validating Workspace…");
    expect(text).toContain("setup command failed");

    // It is the DISCOVERED Workspace, not the inert Pending Workspace: the
    // cursor can now reach it (repo row → main → feature/new).
    await sendKeys(app.stdin, "\x1b[B");
    await sendKeys(app.stdin, "\x1b[B");
    expect(selectedLine(app.lines())).toContain("feature/new");

    app.unmount();
  });
});
