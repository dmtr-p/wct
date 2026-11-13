import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RegistrationId } from "../../src/services/identities";
import {
  emitWorkspacePhase,
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

describe("TUI project removal", () => {
  let homeDir: string;
  let repoPath: string;

  beforeEach(() => {
    resetHarnessFixtures();
    homeDir = realpathSync(mkdtempSync(join(tmpdir(), "wct-app-remove-home-")));
    repoPath = realpathSync(
      mkdtempSync(join(tmpdir(), "wct-app-remove-repo-")),
    );
    mkdirSync(join(homeDir, ".wct"), { recursive: true });
    vi.stubEnv("HOME", homeDir);
    worktreeFixtures.byRepoPath.set(repoPath, [makeWorktree(repoPath, "main")]);
    registryItems.items = [
      { id: RegistrationId("repo-1"), repo_path: repoPath, project: "alpha" },
    ];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  });

  test("Escape cancels a submitted project removal's waiter without dismissing active cleanup", async () => {
    const { App } = await import("../../src/tui/App");
    const app = await renderApp(<App />);
    try {
      await vi.waitFor(() => expect(app.lines().join("\n")).toContain("main"));
      await sendKeys(app.stdin, MAC_DELETE);
      await sendKeys(app.stdin, ENTER);
      await vi.waitFor(() => expect(lastWorkspaceCall("down")).toBeDefined());
      const call = lastWorkspaceCall("down");
      emitWorkspacePhase(call, {
        _tag: "Waiting",
        mainRepoPath: repoPath,
        branch: "main",
      });
      const signal = (
        call.options
          .reporter as import("../../src/services/workspace-service").WorkspaceReporter
      ).waitSignal;
      await sendKeys(app.stdin, ESCAPE);
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      expect(app.lines().join("\n")).toContain("Remove project alpha?");
      call.reject(new Error("Cancelled waiting for project cleanup custody"));
      await tick(20);
    } finally {
      app.unmount();
    }
  });

  test("ignores Escape while confirmed removal is pending", async () => {
    const { App } = await import("../../src/tui/App");
    const app = await renderApp(<App />);
    await vi.waitFor(() => expect(app.lines().join("\n")).toContain("main"));

    await sendKeys(app.stdin, MAC_DELETE);
    await vi.waitFor(() =>
      expect(app.lines().join("\n")).toContain("Remove project alpha?"),
    );
    await sendKeys(app.stdin, ENTER);
    await tick(4);
    expect(lastWorkspaceCall("down")).toBeDefined();

    await sendKeys(app.stdin, ESCAPE);

    expect(app.lines().join("\n")).toContain("Remove project alpha?");
    app.unmount();
  });

  test("ignores the clickable cancel action while removal is pending", async () => {
    const { App } = await import("../../src/tui/App");
    const app = await renderApp(<App />, 32, 100);
    await vi.waitFor(() => expect(app.lines().join("\n")).toContain("main"));

    await sendKeys(app.stdin, MAC_DELETE);
    await vi.waitFor(() =>
      expect(app.lines().join("\n")).toContain("Remove project alpha?"),
    );
    await sendKeys(app.stdin, ENTER);
    await tick(4);
    expect(lastWorkspaceCall("down")).toBeDefined();

    // Project confirmation wraps to two question rows at width 60, putting
    // the anchored modal's cancel action on terminal row 8.
    await sendKeys(app.stdin, sgrPress(18, 8));

    expect(app.lines().join("\n")).toContain("Remove project alpha?");
    app.unmount();
  });
});
