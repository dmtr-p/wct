import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MergeSnapshot } from "../../src/services/pr-merge-service";
import {
  githubFixtures,
  makeWorktree,
  registryItems,
  renderApp,
  resetHarnessFixtures,
  selectedLine,
  sendKeys,
  tick,
  worktreeFixtures,
} from "./app-harness";

const mergeFixture = vi.hoisted(() => ({
  snapshot: null as MergeSnapshot | null,
  fetches: 0,
  submissions: 0,
  submission: null as Promise<"merged" | "queued"> | null,
}));

vi.mock("../../src/services/pr-merge-service", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/services/pr-merge-service")
  >("../../src/services/pr-merge-service");
  return {
    ...actual,
    fetchMergeSnapshot: () => {
      mergeFixture.fetches++;
      return Promise.resolve(mergeFixture.snapshot);
    },
    submitPrMerge: () => {
      mergeFixture.submissions++;
      return mergeFixture.submission ?? Promise.resolve("merged");
    },
  };
});

const { App } = await import("../../src/tui/App");

describe("PR merge confirmation", () => {
  let homeDir: string;
  let repoPath: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "wct-pr-merge-home-"));
    repoPath = mkdtempSync(join(tmpdir(), "wct-pr-merge-repo-"));
    mkdirSync(join(homeDir, ".wct"), { recursive: true });
    vi.stubEnv("HOME", homeDir);
    resetHarnessFixtures();
    mergeFixture.fetches = 0;
    mergeFixture.submissions = 0;
    mergeFixture.submission = null;
    mergeFixture.snapshot = {
      pr: {
        baseRepository: "test/repo",
        number: 7,
        id: "PR-id",
        url: "https://github.com/test/repo/pull/7",
        title: "Change",
        state: "OPEN",
        isDraft: false,
        headRepository: "test/repo",
        headRefName: "feature",
        headOid: "abc123",
        baseRefName: "main",
        reviewDecision: "APPROVED",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        isMergeQueueEnabled: false,
        isQueued: false,
        updatedAt: null,
        checks: [{ name: "test", outcome: "passed", required: true }],
        checksComplete: true,
        fetchedAt: 1,
        lastError: null,
      },
      queueRequired: false,
      methods: ["SQUASH"],
      configurationError: null,
    };
    registryItems.items = [
      { id: "repo", repo_path: repoPath, project: "project" },
    ];
    const main = makeWorktree(repoPath, "main");
    const feature = makeWorktree(repoPath, "feature");
    mkdirSync(main.path, { recursive: true });
    mkdirSync(feature.path, { recursive: true });
    worktreeFixtures.byRepoPath.set(repoPath, [main, feature]);
    githubFixtures.prsByRepoPath.set(repoPath, [
      {
        number: 7,
        title: "Change",
        state: "OPEN",
        headRefName: "feature",
        rollupState: "success",
      },
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  });

  async function openPrMenu(rendered: Awaited<ReturnType<typeof renderApp>>) {
    await tick(25);
    await sendKeys(rendered.stdin, "\x1b[B"); // main
    await sendKeys(rendered.stdin, "\x1b[B"); // feature
    await sendKeys(rendered.stdin, "\x1b[C"); // expand Workspace
    await sendKeys(rendered.stdin, "\x1b[B"); // PR
    expect(selectedLine(rendered.lines())).toContain("#7");
    await sendKeys(rendered.stdin, "p");
    await tick(5);
    expect(rendered.lines().join("\n")).toContain("Merge…");
  }

  test("Escape cancels without submitting", async () => {
    const rendered = await renderApp(<App />);
    try {
      await openPrMenu(rendered);
      await sendKeys(rendered.stdin, "\x1b");
      await tick(5);
      expect(mergeFixture.submissions).toBe(0);
      expect(selectedLine(rendered.lines())).toContain("#7");
    } finally {
      rendered.unmount();
    }
  });

  test("refreshes before confirmation and submits once for repeated Enter", async () => {
    let finish: (result: "merged") => void = () => {};
    mergeFixture.submission = new Promise<"merged">((resolve) => {
      finish = resolve;
    });
    const rendered = await renderApp(<App />);
    try {
      await openPrMenu(rendered);
      await sendKeys(rendered.stdin, "\x1b[B"); // Refresh
      await sendKeys(rendered.stdin, "\x1b[B"); // Merge…
      await sendKeys(rendered.stdin, "\r");
      await tick(5);
      expect(mergeFixture.fetches).toBe(2);
      expect(rendered.lines().join("\n")).toContain("Confirm: Merge now");
      await sendKeys(rendered.stdin, "\r");
      await sendKeys(rendered.stdin, "\r");
      expect(mergeFixture.submissions).toBe(1);
      finish("merged");
      await tick(5);
    } finally {
      rendered.unmount();
    }
  });
});
