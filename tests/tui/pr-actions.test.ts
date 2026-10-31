import { describe, expect, test, vi } from "vitest";
import { workspaceIdentityKey } from "../../src/services/identities";
import type { MergeSnapshot } from "../../src/services/pr-merge-service";
import {
  createPrActionsController,
  type PrActionsDependencies,
  type PrActionTarget,
  prMenuOptions,
  prMenuTitle,
} from "../../src/tui/pr-actions";
import { Mode } from "../../src/tui/types";

function snapshot(number = 7): MergeSnapshot {
  return {
    pr: {
      baseRepository: "test/repo",
      number,
      id: `PR-${number}`,
      url: `https://github.com/test/repo/pull/${number}`,
      title: `Change ${number}`,
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
}

function target(value = snapshot()): PrActionTarget {
  return {
    repoPath: "/repo",
    branch: "feature",
    kind: "pr",
    pr: value.pr,
    candidates: [value.pr],
    explicit: false,
  };
}

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<A>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(overrides: Partial<PrActionsDependencies> = {}) {
  const deps = {
    getMode: vi.fn(() =>
      Mode.Expanded(workspaceIdentityKey("/repo", "feature")),
    ),
    setMode: vi.fn(),
    showActionError: vi.fn(),
    fetchSnapshot: vi.fn(async () => snapshot()),
    submitMerge: vi.fn(async () => "merged" as const),
    refresh: vi.fn(async () => {}),
    refreshAfterCurrent: vi.fn(async () => {}),
    setExplicit: vi.fn(async () => {}),
    clearExplicit: vi.fn(async () => {}),
    openInBrowser: vi.fn(),
    ...overrides,
  };
  const controller = createPrActionsController(deps);
  return { deps, controller, menu: () => controller.getSnapshot().menu };
}

async function openReady(h: ReturnType<typeof harness>, value = snapshot()) {
  h.controller.open(target(value));
  await vi.waitFor(() => {
    expect(
      prMenuOptions(h.menu()).some(
        (option) => option.id === (value.queueRequired ? "queue" : "merge"),
      ),
    ).toBe(true);
  });
}

async function confirmReady(h: ReturnType<typeof harness>, value = snapshot()) {
  await openReady(h, value);
  h.controller.choose(value.queueRequired ? "queue" : "merge");
  await vi.waitFor(() => expect(h.menu()?.screen).toBe("confirm"));
}

describe("PR actions controller", () => {
  test.each(["success", "failure"])(
    "ignores delayed snapshot %s after dismissal",
    async (outcome) => {
      const pending = deferred<MergeSnapshot>();
      const h = harness({ fetchSnapshot: () => pending.promise });
      h.controller.open(target());
      h.controller.close();
      if (outcome === "success") pending.resolve(snapshot());
      else pending.reject(new Error("old failure"));
      await pending.promise.catch(() => {});
      expect(h.menu()).toBeNull();
      expect(h.deps.setMode).toHaveBeenLastCalledWith(
        Mode.Expanded(workspaceIdentityKey("/repo", "feature")),
      );
      expect(h.deps.showActionError).not.toHaveBeenCalled();
    },
  );

  test.each(["success", "failure"])(
    "ignores delayed snapshot %s when another menu opens",
    async (outcome) => {
      const pending = deferred<MergeSnapshot>();
      const fetch = vi
        .fn<PrActionsDependencies["fetchSnapshot"]>()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(snapshot(8));
      const h = harness({ fetchSnapshot: fetch });
      h.controller.open(target());
      h.controller.close();
      await openReady(h, snapshot(8));
      const current = h.menu();
      if (outcome === "success") pending.resolve(snapshot());
      else pending.reject(new Error("old failure"));
      await pending.promise.catch(() => {});
      expect(h.menu()).toBe(current);
    },
  );

  test.each(["success", "failure"])(
    "ignores delayed confirmation refresh %s after reopening",
    async (outcome) => {
      const pending = deferred<MergeSnapshot>();
      const fetch = vi
        .fn<PrActionsDependencies["fetchSnapshot"]>()
        .mockResolvedValueOnce(snapshot())
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(snapshot(8));
      const h = harness({ fetchSnapshot: fetch });
      await openReady(h);
      h.controller.choose("merge");
      expect(h.menu()).toMatchObject({
        screen: "actions",
        mergeCheck: { status: "refreshing" },
      });
      h.controller.close();
      await openReady(h, snapshot(8));
      const current = h.menu();
      if (outcome === "success") pending.resolve(snapshot());
      else pending.reject(new Error("old confirmation failure"));
      await pending.promise.catch(() => {});
      expect(h.menu()).toBe(current);
      expect(h.deps.refreshAfterCurrent).not.toHaveBeenCalled();
    },
  );

  test("a superseding menu and unmount invalidation discard old requests", async () => {
    const pending = deferred<MergeSnapshot>();
    const h = harness({ fetchSnapshot: () => pending.promise });
    h.controller.open(target());
    h.controller.open({ ...target(), kind: "group" });
    const current = h.menu();
    pending.resolve(snapshot());
    await pending.promise;
    expect(h.menu()).toBe(current);

    const other = deferred<MergeSnapshot>();
    const unmounted = harness({ fetchSnapshot: () => other.promise });
    unmounted.controller.open(target());
    unmounted.controller.invalidate();
    const before = unmounted.menu();
    other.resolve(snapshot());
    await other.promise;
    expect(unmounted.menu()).toBe(before);
  });

  test("choosing an association while confirmation refreshes supersedes that request", async () => {
    const pending = deferred<MergeSnapshot>();
    const h = harness({
      fetchSnapshot: vi
        .fn<PrActionsDependencies["fetchSnapshot"]>()
        .mockResolvedValueOnce(snapshot())
        .mockReturnValueOnce(pending.promise),
    });
    h.controller.open({ ...target(), explicit: true });
    await vi.waitFor(() =>
      expect(h.menu()).toMatchObject({ mergeCheck: { status: "ready" } }),
    );
    h.controller.choose("merge");
    h.controller.choose("choose");
    pending.resolve(snapshot());
    await pending.promise;
    expect(h.menu()?.screen).toBe("choose");
  });

  test("selects an enabled direct merge method and confirms with that method", async () => {
    const value = {
      ...snapshot(),
      methods: ["SQUASH", "REBASE", "MERGE"] as const,
    };
    const current: MergeSnapshot = { ...value, methods: [...value.methods] };
    const h = harness({ fetchSnapshot: async () => current });
    await openReady(h, current);
    h.controller.choose("merge");
    expect(prMenuTitle(h.menu())).toBe("Merge method");
    expect(prMenuOptions(h.menu()).map((option) => option.id)).toEqual([
      "method:SQUASH",
      "method:REBASE",
      "method:MERGE",
    ]);
    h.controller.choose("method:REBASE");
    await vi.waitFor(() => expect(h.menu()?.screen).toBe("confirm"));
    expect(h.menu()).toMatchObject({ route: "direct", method: "REBASE" });
    expect(
      prMenuOptions(h.menu()).find((option) => option.id === "method")?.label,
    ).toBe("Method: Rebase and merge");
    h.controller.choose("confirm");
    await vi.waitFor(() => expect(h.menu()).toBeNull());
    expect(h.deps.submitMerge).toHaveBeenCalledExactlyOnceWith(
      "/repo",
      current,
      "REBASE",
    );
  });

  test("confirms and submits a queue route without a direct merge method", async () => {
    const current: MergeSnapshot = {
      ...snapshot(),
      queueRequired: true,
      methods: null,
    };
    const h = harness({
      fetchSnapshot: async () => current,
      submitMerge: vi.fn(async () => "queued" as const),
    });
    await confirmReady(h, current);
    expect(prMenuTitle(h.menu())).toBe("Confirm queue submission");
    expect(h.menu()).toMatchObject({ route: "queue" });
    expect(h.menu()).not.toHaveProperty("method");
    h.controller.choose("confirm");
    await vi.waitFor(() => expect(h.menu()).toBeNull());
    expect(h.deps.submitMerge).toHaveBeenCalledExactlyOnceWith(
      "/repo",
      current,
      undefined,
    );
    expect(h.controller.getSnapshot().outcome).toBe("PR #7 queued");
  });

  test.each(["success", "failure"])(
    "locks submission synchronously, reports %s, restores mode and refreshes",
    async (outcome) => {
      const submission = deferred<"merged" | "queued">();
      const submitMerge = vi.fn(() => submission.promise);
      const h = harness({ submitMerge });
      await confirmReady(h);
      h.controller.choose("confirm");
      h.controller.choose("confirm");
      h.controller.close(); // Escape before React rerenders.
      h.controller.choose("cancel");
      h.controller.choose("refresh");
      h.controller.open({ ...target(), kind: "group" });
      expect(h.menu()?.screen).toBe("submitting");
      expect(submitMerge).toHaveBeenCalledTimes(1);
      expect(h.deps.setMode).toHaveBeenCalledTimes(1);
      expect(h.deps.refreshAfterCurrent).not.toHaveBeenCalled();
      if (outcome === "success") submission.resolve("merged");
      else submission.reject(new Error("submission failed"));
      await vi.waitFor(() => expect(h.menu()).toBeNull());
      expect(h.deps.setMode).toHaveBeenLastCalledWith(
        Mode.Expanded(workspaceIdentityKey("/repo", "feature")),
      );
      expect(h.deps.refreshAfterCurrent).toHaveBeenCalledExactlyOnceWith(
        "/repo",
      );
      if (outcome === "success") {
        expect(h.controller.getSnapshot().outcome).toBe("PR #7 merged");
        expect(h.deps.showActionError).not.toHaveBeenCalled();
      } else {
        expect(h.controller.getSnapshot().outcome).toBeNull();
        expect(h.deps.showActionError).toHaveBeenCalledWith(
          "submission failed",
        );
      }
    },
  );

  test("changed eligibility returns to actions without submitting", async () => {
    const value = snapshot();
    const changed = { ...value, pr: { ...value.pr, headOid: "new-head" } };
    const h = harness({
      fetchSnapshot: vi
        .fn<PrActionsDependencies["fetchSnapshot"]>()
        .mockResolvedValueOnce(value)
        .mockResolvedValue(changed),
    });
    await openReady(h);
    h.controller.choose("merge");
    await vi.waitFor(() =>
      expect(h.menu()).toMatchObject({
        screen: "actions",
        notice: expect.stringContaining("changed"),
      }),
    );
    expect(h.deps.refreshAfterCurrent).toHaveBeenCalledWith("/repo");
    h.controller.choose("confirm");
    expect(h.deps.submitMerge).not.toHaveBeenCalled();
    h.controller.choose("merge");
    await vi.waitFor(() => expect(h.menu()?.screen).toBe("confirm"));
  });

  test("reports current fetch errors and permits cancellation", async () => {
    const h = harness({
      fetchSnapshot: async () => {
        throw new Error("snapshot unavailable");
      },
    });
    h.controller.open(target());
    await vi.waitFor(() =>
      expect(h.menu()).toMatchObject({
        mergeCheck: { status: "error", reason: "snapshot unavailable" },
      }),
    );
    expect(
      prMenuOptions(h.menu()).find((option) => option.id === "unavailable")
        ?.label,
    ).toContain("snapshot unavailable");
    h.controller.close();
    expect(h.menu()).toBeNull();
    expect(h.deps.submitMerge).not.toHaveBeenCalled();
  });

  test("preserves association choice, browser, refresh, change and clear actions", () => {
    const h = harness();
    const group: PrActionTarget = { ...target(), kind: "group" };
    h.controller.open(group);
    h.controller.choose("choose");
    expect(prMenuTitle(h.menu())).toBe("Choose PR");
    h.controller.choose("use:7");
    expect(h.deps.setExplicit).toHaveBeenCalledWith(
      "/repo",
      "feature",
      snapshot().pr,
    );
    expect(h.menu()).toBeNull();

    h.controller.open({ ...target(), kind: "candidate", pr: snapshot().pr });
    h.controller.choose("use");
    expect(h.deps.setExplicit).toHaveBeenCalledTimes(2);
    h.controller.open({ ...target(), kind: "candidate", pr: snapshot().pr });
    h.controller.choose("open");
    expect(h.deps.openInBrowser).toHaveBeenCalledWith("/repo", snapshot().pr);
    h.controller.open(group);
    h.controller.choose("refresh");
    expect(h.deps.refresh).toHaveBeenCalledWith("/repo");
    h.controller.open({ ...group, explicit: true });
    expect(
      prMenuOptions(h.menu()).find((option) => option.id === "choose")?.label,
    ).toBe("Change PR…");
    h.controller.choose("clear");
    expect(h.deps.clearExplicit).toHaveBeenCalledWith("/repo", "feature");
    expect(h.menu()).toBeNull();
  });

  test.each(["set", "clear"])(
    "reports %s association errors after closing",
    async (action) => {
      const fail = vi.fn(async () => {
        throw new Error("association failed");
      });
      const h = harness({ setExplicit: fail, clearExplicit: fail });
      h.controller.open({
        ...target(),
        kind: "candidate",
        pr: snapshot().pr,
        explicit: true,
      });
      h.controller.choose(action === "set" ? "use" : "clear");
      expect(h.menu()).toBeNull();
      await vi.waitFor(() =>
        expect(h.deps.showActionError).toHaveBeenCalledWith(
          "Error: association failed",
        ),
      );
    },
  );
});
