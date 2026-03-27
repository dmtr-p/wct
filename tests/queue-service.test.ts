import { join } from "node:path";
import { $ } from "bun";
import { Effect } from "effect";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { runBunPromise, runBunSync } from "../src/effect/runtime";
import {
  type ListItemsOptions,
  liveQueueStorage,
  type QueueItem,
  QueueStorage,
  type QueueStorageService,
} from "../src/services/queue-storage";
import {
  TmuxService,
  type TmuxService as TmuxServiceApi,
} from "../src/services/tmux";

const originalHome = process.env.HOME;
const testHome = join("/tmp", `wct-test-queue-${Date.now()}`);

process.env.HOME = testHome;

function stubTmuxService(
  overrides: Partial<TmuxServiceApi> = {},
): TmuxServiceApi {
  const noop = () => Effect.succeed(undefined as never);
  return TmuxService.of({
    listSessions: () => Effect.succeed(null),
    isPaneAlive: () => Effect.succeed(null),
    sessionExists: () => Effect.succeed(false),
    getSessionStatus: () => Effect.succeed(null),
    createSession: noop,
    killSession: noop,
    getCurrentSession: () => Effect.succeed(null),
    switchSession: noop,
    attachSession: noop,
    listPanes: () => Effect.succeed([]),
    listClients: () => Effect.succeed([]),
    switchClientToPane: noop,
    selectPane: noop,
    refreshClient: noop,
    ...overrides,
  });
}

let currentTmuxStub: TmuxServiceApi = stubTmuxService();

function provideServices<A>(
  effect: Effect.Effect<A, unknown, QueueStorageService | TmuxServiceApi>,
) {
  return Effect.provideService(
    Effect.provideService(effect, QueueStorage, liveQueueStorage),
    TmuxService,
    currentTmuxStub,
  );
}

function addItem(item: Omit<QueueItem, "id" | "timestamp">) {
  return runBunSync(
    provideServices(
      QueueStorage.use((queueStorage) => queueStorage.addItem(item)),
    ),
  );
}

function clearAll() {
  return runBunSync(
    provideServices(
      QueueStorage.use((queueStorage) => queueStorage.clearAll()),
    ),
  );
}

function listItems(options: ListItemsOptions = {}) {
  return runBunPromise(
    provideServices(
      QueueStorage.use((queueStorage) => queueStorage.listItems(options)),
    ),
  );
}

function removeItem(id: string) {
  return runBunSync(
    provideServices(
      QueueStorage.use((queueStorage) => queueStorage.removeItem(id)),
    ),
  );
}

function removeItemsBySession(session: string) {
  return runBunSync(
    provideServices(
      QueueStorage.use((queueStorage) =>
        queueStorage.removeItemsBySession(session),
      ),
    ),
  );
}

describe("queue service", () => {
  beforeEach(async () => {
    await $`mkdir -p ${testHome}`.quiet();
    clearAll();
    currentTmuxStub = stubTmuxService();
  });

  afterEach(() => {
    clearAll();
  });

  test("addItem returns item with generated id and timestamp", () => {
    const item = addItem({
      branch: "feature-x",
      project: "myapp",
      type: "permission_prompt",
      message: "Allow file write?",
      session: "myapp-feature-x",
      pane: "%99",
    });

    expect(item.id).toMatch(/^\d+-[a-z0-9]+$/);
    expect(item.timestamp).toBeGreaterThan(0);
    expect(item.branch).toBe("feature-x");
    expect(item.project).toBe("myapp");
  });

  test("addItem dedup - second add with same pane replaces first", async () => {
    addItem({
      branch: "feature-x",
      project: "myapp",
      type: "permission_prompt",
      message: "first",
      session: "myapp-feature-x",
      pane: "%100",
    });

    addItem({
      branch: "feature-x",
      project: "myapp",
      type: "idle_prompt",
      message: "second",
      session: "myapp-feature-x",
      pane: "%100",
    });

    expect(listItems({ validatePanes: false })).resolves.toHaveLength(1);
  });

  test("listItems with pane validation disabled returns correct count after adds", async () => {
    addItem({
      branch: "a",
      project: "p",
      type: "t",
      message: "m",
      session: "s",
      pane: "%201",
    });
    addItem({
      branch: "b",
      project: "p",
      type: "t",
      message: "m",
      session: "s",
      pane: "%202",
    });

    expect(listItems({ validatePanes: false })).resolves.toHaveLength(2);
  });

  test("listItems returns items sorted by timestamp and removes stale", async () => {
    currentTmuxStub = stubTmuxService({
      listSessions: () =>
        Effect.succeed([{ name: "live-session", attached: false, windows: 1 }]),
      isPaneAlive: (pane) => Effect.succeed(pane === "%301"),
    });

    addItem({
      branch: "a",
      project: "p",
      type: "t",
      message: "m",
      session: "live-session",
      pane: "%301",
    });
    addItem({
      branch: "b",
      project: "p",
      type: "t",
      message: "m",
      session: "dead-session",
      pane: "%302",
    });

    const items = await listItems();

    expect(items).toHaveLength(1);
    expect(items[0]?.session).toBe("live-session");
    expect(listItems({ validatePanes: false })).resolves.toHaveLength(1);
  });

  test("listItems keeps entries when tmux session discovery fails", async () => {
    currentTmuxStub = stubTmuxService({
      listSessions: () => Effect.succeed(null),
    });

    addItem({
      branch: "a",
      project: "p",
      type: "t",
      message: "m",
      session: "possibly-live-session",
      pane: "%250",
    });

    const items = await listItems();

    expect(items).toHaveLength(1);
    expect(listItems({ validatePanes: false })).resolves.toHaveLength(1);
  });

  test("listItems removes all entries when tmux has zero sessions", async () => {
    currentTmuxStub = stubTmuxService({
      listSessions: () => Effect.succeed([]),
    });

    addItem({
      branch: "a",
      project: "p",
      type: "t",
      message: "m",
      session: "old-session",
      pane: "%251",
    });

    const items = await listItems();

    expect(items).toHaveLength(0);
    expect(listItems({ validatePanes: false })).resolves.toHaveLength(0);
  });

  test("listItems removes entries whose pane no longer exists in a live session", async () => {
    currentTmuxStub = stubTmuxService({
      listSessions: () =>
        Effect.succeed([{ name: "live-session", attached: false, windows: 1 }]),
      isPaneAlive: (pane) => Effect.succeed(pane === "%311" || false),
    });

    addItem({
      branch: "a",
      project: "p",
      type: "t",
      message: "live",
      session: "live-session",
      pane: "%311",
    });
    addItem({
      branch: "b",
      project: "p",
      type: "t",
      message: "stale-pane",
      session: "live-session",
      pane: "%312",
    });

    const items = await listItems();

    expect(items).toHaveLength(1);
    expect(items[0]?.pane).toBe("%311");
    expect(listItems({ validatePanes: false })).resolves.toHaveLength(1);
  });

  test("listItems skips stale cleanup when all items are live", async () => {
    currentTmuxStub = stubTmuxService({
      listSessions: () =>
        Effect.succeed([{ name: "s1", attached: false, windows: 1 }]),
      isPaneAlive: () => Effect.succeed(true),
    });

    addItem({
      branch: "a",
      project: "p",
      type: "t",
      message: "m",
      session: "s1",
      pane: "%311",
    });

    const items = await listItems();

    expect(items).toHaveLength(1);
    expect(listItems({ validatePanes: false })).resolves.toHaveLength(1);
  });

  test("removeItem returns true for existing item", async () => {
    const item = addItem({
      branch: "a",
      project: "p",
      type: "t",
      message: "m",
      session: "s",
      pane: "%401",
    });

    expect(removeItem(item.id)).toBe(true);
    expect(listItems({ validatePanes: false })).resolves.toHaveLength(0);
  });

  test("removeItem returns false for nonexistent id", () => {
    expect(removeItem("nonexistent-id")).toBe(false);
  });

  test("removeItemsBySession removes matching items and returns count", async () => {
    addItem({
      branch: "a",
      project: "p",
      type: "t",
      message: "m",
      session: "target",
      pane: "%501",
    });
    addItem({
      branch: "b",
      project: "p",
      type: "t",
      message: "m",
      session: "target",
      pane: "%502",
    });
    addItem({
      branch: "c",
      project: "p",
      type: "t",
      message: "m",
      session: "other",
      pane: "%503",
    });

    const removed = removeItemsBySession("target");

    expect(removed).toBe(2);
    expect(listItems({ validatePanes: false })).resolves.toHaveLength(1);
  });

  test("clearAll removes everything", () => {
    addItem({
      branch: "a",
      project: "p",
      type: "t",
      message: "m",
      session: "s",
      pane: "%601",
    });
    addItem({
      branch: "b",
      project: "p",
      type: "t",
      message: "m",
      session: "s",
      pane: "%602",
    });

    const cleared = clearAll();

    expect(cleared).toBe(2);
    expect(listItems({ validatePanes: false })).resolves.toHaveLength(0);
  });
});

afterAll(async () => {
  await $`rm -rf ${testHome}`.quiet();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});
