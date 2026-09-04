// App-level lifecycle tests for `open`, driving the real open modal through
// Ink's input pipeline.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  emitWorkspacePhase,
  lastWorkspaceCall,
  makeWorktree,
  openBranchFromModal,
  registryItems,
  renderApp,
  resetHarnessFixtures,
  selectedLine,
  sendKeys,
  tick,
  tmuxFixtures,
  worktreeFixtures,
} from "./app-harness";

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
    expect(worktreeFixtures.byRepoPath.get(repoPath)).toHaveLength(1);
    expect(text).toContain("feature/new");
    expect(text).toContain("Preparing Workspace…");

    // Placed directly beneath the repository's last worktree row block.
    const repoRow = frame.findIndex((line) => line.includes("alpha"));
    const mainRow = frame.findIndex((line) => line.includes("main"));
    const pendingRow = frame.findIndex((line) => line.includes("feature/new"));
    const progressRow = frame.findIndex((line) =>
      line.includes("Preparing Workspace…"),
    );
    expect(repoRow).toBeLessThan(mainRow);
    expect(mainRow).toBeLessThan(pendingRow);
    expect(progressRow).toBe(pendingRow + 1);

    const call = lastWorkspaceCall("open");
    expect(call.options.branch).toBe("feature/new");
    expect(call.options.cwd).toBe(repoPath);
    emitWorkspacePhase(call, { _tag: "CreatingWorktree" });
    await tick(3);
    expect(app.lines().join("\n")).toContain("Creating worktree…");
    expect(app.lines().join("\n")).not.toContain("Preparing Workspace…");

    app.unmount();
  });

  test("removes the Pending Workspace when validation finds no managed worktree", async () => {
    const { App } = await import("../../src/tui/App");
    const app = await renderApp(<App />);
    await tick(6);

    await openBranchFromModal(app.stdin, "feature/new");
    await tick(6);
    expect(app.lines().join("\n")).toContain("Preparing Workspace…");

    // Fails before git creates anything, so validation's refresh finds the
    // repository exactly as it was.
    const call = lastWorkspaceCall("open");
    call.reject(new Error("worktree add failed"));
    await tick(12);

    const text = app.lines().join("\n");
    expect(text).not.toContain("feature/new");
    expect(text).not.toContain("Preparing Workspace…");
    expect(text).not.toContain("Validating Workspace…");
    expect(text).toContain("worktree add failed");
    expect(text).toContain("main");

    app.unmount();
  });

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

    // The worktree was created; a later phase then failed fatally.
    worktreeFixtures.byRepoPath.set(repoPath, [
      makeWorktree(repoPath, "main"),
      makeWorktree(repoPath, "feature/new"),
    ]);
    call.reject(new Error("setup command failed"));
    await tick(12);

    const text = app.lines().join("\n");
    expect(text).toContain("feature/new");
    expect(text).not.toContain("Creating worktree…");
    expect(text).not.toContain("Validating Workspace…");
    expect(text).toContain("setup command failed");

    // The discovered Workspace, not the inert Pending Workspace: the cursor
    // can reach it.
    await sendKeys(app.stdin, "\x1b[B");
    await sendKeys(app.stdin, "\x1b[B");
    expect(selectedLine(app.lines())).toContain("feature/new");
    expect(selectedLine(app.lines())).toContain("▼");

    app.unmount();
  });

  test("leaves the discovered Workspace expanded after a successful open", async () => {
    const { App } = await import("../../src/tui/App");
    const app = await renderApp(<App />);
    await tick(6);

    // `main` is collapsed, so expansion isn't simply on for every row.
    expect(app.lines().find((line) => line.includes("main"))).not.toContain(
      "▼",
    );

    await openBranchFromModal(app.stdin, "feature/new");
    await tick(6);
    expect(app.lines().join("\n")).toContain("Preparing Workspace…");

    const call = lastWorkspaceCall("open");
    worktreeFixtures.byRepoPath.set(repoPath, [
      makeWorktree(repoPath, "main"),
      makeWorktree(repoPath, "feature/new"),
    ]);
    call.resolve({
      operation: "open",
      worktreePath: join(repoPath, "feature-new"),
      mainRepoPath: repoPath,
      branch: "feature/new",
      sessionName: "feature-new",
      projectName: "alpha",
      created: true,
      env: {},
      warnings: [],
      attempts: {
        worktree: { attempted: true, ok: true, value: {} },
        copy: { attempted: false, reason: "not_configured" },
        setup: { attempted: false, reason: "not_configured" },
        tmux: { attempted: false, reason: "not_configured" },
      },
    });
    await tick(14);

    const frame = app.lines();
    const text = frame.join("\n");
    expect(text).not.toContain("Preparing Workspace…");
    expect(text).not.toContain("Validating Workspace…");
    expect(frame.find((line) => line.includes("feature/new"))).toContain("▼");
    expect(frame.find((line) => line.includes("main"))).not.toContain("▼");

    app.unmount();
  });

  test("cleans up rendered progress before automatically switching the tmux client", async () => {
    tmuxFixtures.clients = [{ tty: "/dev/pts/1", session: "outside" }];
    tmuxFixtures.sessions = [{ name: "outside", attached: true, windows: 1 }];

    const { App } = await import("../../src/tui/App");
    const app = await renderApp(<App />);
    await tick(6);

    let frameAtSwitch = "";
    tmuxFixtures.onSwitch = () => {
      frameAtSwitch = app.lines().join("\n");
    };

    await openBranchFromModal(app.stdin, "feature/new");
    await tick(6);
    expect(app.lines().join("\n")).toContain("Preparing Workspace…");

    const call = lastWorkspaceCall("open");
    worktreeFixtures.byRepoPath.set(repoPath, [
      makeWorktree(repoPath, "main"),
      makeWorktree(repoPath, "feature/new"),
    ]);
    call.resolve({
      operation: "open",
      worktreePath: join(repoPath, "feature-new"),
      mainRepoPath: repoPath,
      branch: "feature/new",
      sessionName: "feature-new",
      projectName: "alpha",
      created: true,
      env: {},
      warnings: [],
      attempts: {
        worktree: { attempted: true, ok: true, value: {} },
        copy: { attempted: false, reason: "not_configured" },
        setup: { attempted: false, reason: "not_configured" },
        tmux: {
          attempted: true,
          ok: true,
          value: { _tag: "Created", sessionName: "feature-new" },
        },
      },
    });
    await tick(16);

    expect(tmuxFixtures.switchCalls).toEqual([
      { clientTty: "/dev/pts/1", target: "=feature-new" },
    ]);
    expect(frameAtSwitch).toContain("feature/new");
    expect(frameAtSwitch).not.toContain("Preparing Workspace…");
    expect(frameAtSwitch).not.toContain("Validating Workspace…");
    expect(app.lines().find((line) => line.includes("feature/new"))).toContain(
      "▼",
    );

    app.unmount();
  });
});
