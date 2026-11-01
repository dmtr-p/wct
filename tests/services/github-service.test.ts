import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { provideBunServices, runBunPromise } from "../../src/effect/runtime";
import { WctCommandError } from "../../src/errors";
import { normalizeGhPr } from "../../src/services/pr-discovery";
import { ProcessExitError } from "../../src/services/process";
import { prFactEnumCases, prFacts } from "../helpers/pr";

type ExecProcess = typeof import("../../src/services/process").execProcess;

const exec = vi.hoisted(() => vi.fn<ExecProcess>());
vi.mock("../../src/services/process", async () => ({
  ...(await vi.importActual<typeof import("../../src/services/process")>(
    "../../src/services/process",
  )),
  execProcess: (...args: Parameters<ExecProcess>) =>
    Effect.suspend(() => exec(...args)),
}));
const { liveGitHubService } = await import("../../src/services/github-service");
const { fetchPrDetails } = await import("../../src/services/pr-details");
const { fetchMergeSnapshot } =
  await import("../../src/services/pr-merge-service");

function page(nodes: unknown[], hasNextPage = false, endCursor?: string) {
  return {
    data: {
      repository: {
        pullRequests: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    },
  };
}

describe("GitHub raw PR fetching", () => {
  beforeEach(() => exec.mockReset());

  test.each(prFactEnumCases)(
    "detail fetch normalizes enum fields %j without resetting other facts",
    async (fields, expected) => {
      const pr = prFacts({
        id: "detail-id",
        fetchedAt: 123,
        lastError: "old error",
      });
      exec.mockReturnValueOnce(
        Effect.succeed({
          stdout: JSON.stringify({
            data: {
              repository: {
                p0: {
                  id: "detail-id",
                  number: pr.number,
                  baseRepository: { nameWithOwner: pr.baseRepository },
                  headRefOid: pr.headOid,
                  ...fields,
                  mergeStateStatus: "BLOCKED",
                  isMergeQueueEnabled: true,
                  mergeQueueEntry: { id: "queue-entry" },
                  commits: {
                    nodes: [
                      { commit: { oid: "abc123", statusCheckRollup: null } },
                    ],
                  },
                },
              },
            },
          }),
          stderr: "",
          exitCode: 0,
        }),
      );
      const result = await runBunPromise(
        fetchPrDetails("/repo", "owner/repo", [pr]),
      );
      expect(result).toEqual([
        {
          ...pr,
          ...expected,
          id: "detail-id",
          mergeStateStatus: "BLOCKED",
          isMergeQueueEnabled: true,
          isQueued: true,
          checks: [],
          checksComplete: true,
          lastError: null,
        },
      ]);
    },
  );

  test.each([
    {},
    { id: "detail-id", isMergeQueueEnabled: false },
    {
      id: "detail-id",
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    },
  ])(
    "incomplete details %j retain prior facts and freshness",
    async (partial) => {
      const pr = prFacts({ fetchedAt: 123 });
      exec.mockReturnValueOnce(
        Effect.succeed({
          stdout: JSON.stringify({ data: { repository: { p0: partial } } }),
          stderr: "",
          exitCode: 0,
        }),
      );
      const result = await runBunPromise(
        fetchPrDetails("/repo", "owner/repo", [pr]),
      );
      expect(result).toEqual([
        {
          ...pr,
          checksComplete: false,
          lastError: "Incomplete PR detail response",
        },
      ]);
    },
  );

  test("an empty GraphQL errors array still reports a missing repository", async () => {
    exec.mockReturnValueOnce(
      Effect.succeed({
        stdout: JSON.stringify({ data: { repository: null }, errors: [] }),
        stderr: "",
        exitCode: 0,
      }),
    );
    const result = await runBunPromise(
      liveGitHubService.getRawPrs("/repo", "base/repo", [1]),
    );
    expect(result[0]?.error).toContain("Missing repository");
  });

  test.each(["[]", '[{"number":34,"title":"TUI","headRefName":"feat/tui"}]'])(
    "parses the complete-PR list %s",
    async (stdout) => {
      exec.mockReturnValueOnce(
        Effect.succeed({
          stdout: JSON.stringify([page(JSON.parse(stdout))]),
          stderr: "",
          exitCode: 0,
        }),
      );
      expect(
        await runBunPromise(
          liveGitHubService.listRawPrs("/repo", "all", "base/repo"),
        ),
      ).toEqual(JSON.parse(stdout));
    },
  );

  test.each(["all", "updated"] as const)(
    "paginates %s PR discovery against the resolved base without check payloads",
    async (state) => {
      const first = { number: 1, updatedAt: "2026-10-15T00:01:00Z" };
      const second = { number: 200, updatedAt: "2026-10-15T00:00:00Z" };
      exec.mockReturnValueOnce(
        Effect.succeed({
          stdout: JSON.stringify(
            state === "all"
              ? [page([first], true), page([second])]
              : page([first, second]),
          ),
          stderr: "",
          exitCode: 0,
        }),
      );
      expect(
        await runBunPromise(
          liveGitHubService.listRawPrs("/repo", state, "base/repo", 0),
        ),
      ).toEqual([first, second]);
      expect(exec).toHaveBeenCalledTimes(1);
      const args = exec.mock.calls[0]?.[1] ?? [];
      expect(args).toEqual(
        expect.arrayContaining(
          state === "all"
            ? ["api", "graphql", "--paginate", "--slurp"]
            : ["api", "graphql"],
        ),
      );
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      expect(query).toContain('repository(owner: "base", name: "repo")');
      expect(query).not.toContain("states: [OPEN]");
      expect(query).toContain(
        "orderBy: { field: UPDATED_AT, direction: DESC }",
      );
      expect(query).not.toContain("statusCheckRollup");
      expect(query).not.toContain("commits(");
      for (const field of ["mergeable", "mergeStateStatus", "reviewDecision"])
        expect(query).toContain(field);
    },
  );

  it.effect(
    "allows complete paginated history to take longer than a poll interval",
    () =>
      Effect.gen(function* () {
        exec.mockReturnValueOnce(
          Effect.sleep("3 minutes").pipe(
            Effect.as({
              stdout: JSON.stringify([page([])]),
              stderr: "",
              exitCode: 0,
            }),
          ),
        );
        const fiber = yield* Effect.forkChild(
          provideBunServices(
            liveGitHubService.listRawPrs("/repo", "all", "base/repo"),
          ),
        );
        yield* TestClock.adjust("3 minutes");
        expect(yield* Fiber.join(fiber)).toEqual([]);
        expect(exec).toHaveBeenCalledTimes(1);
      }),
  );

  test("incremental discovery includes every state and stops after the inclusive checkpoint", async () => {
    const recent = {
      number: 3,
      state: "MERGED",
      updatedAt: "2026-10-15T00:03:00Z",
    };
    const boundary = {
      number: 2,
      state: "CLOSED",
      updatedAt: "2026-10-15T00:02:00Z",
    };
    const old = { number: 1, state: "OPEN", updatedAt: "2026-10-15T00:01:00Z" };
    for (const response of [
      page([recent], true, "next"),
      page([boundary, old], true, "unused"),
    ])
      exec.mockReturnValueOnce(
        Effect.succeed({
          stdout: JSON.stringify(response),
          stderr: "",
          exitCode: 0,
        }),
      );
    expect(
      await runBunPromise(
        liveGitHubService.listRawPrs(
          "/repo",
          "updated",
          "base/repo",
          Date.parse(boundary.updatedAt),
        ),
      ),
    ).toEqual([recent, boundary]);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1]?.[1]).toContain("endCursor=next");
    expect(exec.mock.calls[0]?.[1]).not.toContain("--paginate");
  });

  test.each([
    page([{ updatedAt: "invalid" }]),
    page([{ updatedAt: "2026-10-15T00:00:00Z" }], true),
    { ...page([]), errors: [{ message: "rate limited" }] },
  ])("rejects incomplete incremental discovery %j", async (response) => {
    exec.mockReturnValueOnce(
      Effect.succeed({
        stdout: JSON.stringify(response),
        stderr: "",
        exitCode: 0,
      }),
    );
    await expect(
      runBunPromise(
        liveGitHubService.listRawPrs("/repo", "updated", "base/repo", 0),
      ),
    ).rejects.toMatchObject({ code: "pr_error" });
  });

  test.each(["{}", "null", "not JSON"])(
    "preserves gh authentication errors for both summary and detail queries with stdout %s",
    async (stdout) => {
      const message = "HTTP 401: Bad credentials";
      exec.mockReturnValue(
        Effect.fail(
          new ProcessExitError({
            command: "gh",
            args: ["api", "graphql"],
            stdout,
            stderr: message,
            exitCode: 1,
          }),
        ),
      );
      const result = await runBunPromise(
        liveGitHubService.getRawPrs("/repo", "base/repo", [1]),
      );
      expect(result[0]?.error).toContain(message);
      const pr = normalizeGhPr(
        { number: 1, title: "PR", state: "OPEN", headRefName: "feature" },
        "base/repo",
        1,
      );
      if (!pr) throw new Error("Invalid fixture");
      expect(
        (await runBunPromise(fetchPrDetails("/repo", "base/repo", [pr])))[0]
          ?.lastError,
      ).toContain(message);
    },
  );

  it.effect.each([
    ["all", "10 minutes"],
    ["updated", "2 minutes"],
  ] as const)("bounds %s pagination at %s", ([state, duration]) =>
    Effect.gen(function* () {
      exec.mockReturnValueOnce(Effect.never);
      const fiber = yield* Effect.forkChild(
        provideBunServices(
          Effect.flip(
            liveGitHubService.listRawPrs("/repo", state, "base/repo", 0),
          ),
        ),
      );
      yield* TestClock.adjust(duration);
      expect(yield* Fiber.join(fiber)).toMatchObject({
        code: "pr_error",
        cause: { _tag: "TimeoutError" },
      });
      expect(exec).toHaveBeenCalledTimes(1);
    }),
  );

  test.each([
    JSON.stringify([page([], true)]),
    JSON.stringify([{ errors: [{ message: "rate limited" }], ...page([]) }]),
    JSON.stringify([{ data: { repository: null } }]),
  ])("rejects incomplete/error pagination %s", async (stdout) => {
    exec.mockReturnValueOnce(
      Effect.succeed({ stdout, stderr: "", exitCode: 0 }),
    );
    await expect(
      runBunPromise(liveGitHubService.listRawPrs("/repo", "all", "base/repo")),
    ).rejects.toMatchObject({ code: "pr_error" });
  });

  test.each(["not json", "{}", "null"])(
    "rejects malformed complete-PR output %s",
    async (stdout) => {
      exec.mockReturnValueOnce(
        Effect.succeed({ stdout, stderr: "", exitCode: 0 }),
      );
      await expect(
        runBunPromise(
          liveGitHubService.listRawPrs("/repo", "all", "base/repo"),
        ),
      ).rejects.toMatchObject({
        code: "pr_error",
        message: expect.stringContaining("Failed to list all PRs:"),
      });
    },
  );

  test("retains GitHub stderr and its cause in list errors", async () => {
    const failure = new ProcessExitError({
      command: "gh",
      args: ["pr", "list"],
      stdout: "",
      stderr: "authentication required\n",
      exitCode: 1,
    });
    exec.mockReturnValueOnce(Effect.fail(failure));
    const error = await runBunPromise(
      Effect.flip(liveGitHubService.listRawPrs("/repo", "all", "base/repo")),
    );
    expect(error).toBeInstanceOf(WctCommandError);
    expect(error).toMatchObject({
      code: "pr_error",
      message: "Failed to list all PRs: authentication required",
      cause: failure,
    });
  });

  test("batches live identities and isolates partial GraphQL errors even on a nonzero gh exit", async () => {
    const raw = { number: 1, baseRepository: { nameWithOwner: "base/repo" } };
    exec.mockReturnValueOnce(
      Effect.fail(
        new ProcessExitError({
          command: "gh",
          args: ["api", "graphql"],
          exitCode: 1,
          stderr: "unavailable",
          stdout: JSON.stringify({
            data: { repository: { p0: raw, p1: null } },
            errors: [{ message: "PR unavailable", path: ["repository", "p1"] }],
          }),
        }),
      ),
    );
    const results = await runBunPromise(
      liveGitHubService.getRawPrs("/repo", "base/repo", [1, 2]),
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { number: 1, raw, error: null },
      { number: 2, raw: null, error: "PR unavailable" },
    ]);
    const query =
      exec.mock.calls[0]?.[1]?.find((arg) => arg.startsWith("query=")) ?? "";
    expect(query).toContain("p0: pullRequest(number: 1)");
    expect(query).toContain("p1: pullRequest(number: 2)");
  });

  test("bounds PR summary batches while retaining every identity", async () => {
    const numbers = Array.from({ length: 45 }, (_, i) => i + 1);
    for (let start = 0; start < numbers.length; start += 20) {
      const repository = Object.fromEntries(
        numbers
          .slice(start, start + 20)
          .map((number, i) => [
            `p${i}`,
            { number, baseRepository: { nameWithOwner: "base/repo" } },
          ]),
      );
      exec.mockReturnValueOnce(
        Effect.succeed({
          stdout: JSON.stringify({ data: { repository } }),
          stderr: "",
          exitCode: 0,
        }),
      );
    }
    const result = await runBunPromise(
      liveGitHubService.getRawPrs("/repo", "base/repo", numbers),
    );
    expect(exec).toHaveBeenCalledTimes(3);
    expect(result.map((pr) => pr.number)).toEqual(numbers);
    expect(result.every((pr) => pr.error === null)).toBe(true);
  });

  test.each(["transport", "invalid JSON"])(
    "preserves successful summary batches around a %s failure",
    async (failure) => {
      const numbers = Array.from({ length: 45 }, (_, i) => i + 1);
      for (let start = 0; start < numbers.length; start += 20) {
        if (start === 20) {
          exec.mockReturnValueOnce(
            failure === "transport"
              ? Effect.fail(
                  new ProcessExitError({
                    command: "gh",
                    args: ["api"],
                    stdout: "",
                    stderr: "offline",
                    exitCode: 1,
                  }),
                )
              : Effect.succeed({ stdout: "not JSON", stderr: "", exitCode: 0 }),
          );
          continue;
        }
        const repository = Object.fromEntries(
          numbers
            .slice(start, start + 20)
            .map((number, i) => [
              `p${i}`,
              { number, baseRepository: { nameWithOwner: "base/repo" } },
            ]),
        );
        exec.mockReturnValueOnce(
          Effect.succeed({
            stdout: JSON.stringify({ data: { repository } }),
            stderr: "",
            exitCode: 0,
          }),
        );
      }
      const result = await runBunPromise(
        liveGitHubService.getRawPrs("/repo", "base/repo", numbers),
      );
      expect(exec).toHaveBeenCalledTimes(3);
      expect(
        result.filter((pr) => pr.error === null).map((pr) => pr.number),
      ).toEqual([...numbers.slice(0, 20), ...numbers.slice(40)]);
      expect(
        result.filter((pr) => pr.error !== null).map((pr) => pr.number),
      ).toEqual(numbers.slice(20, 40));
    },
  );

  test.each([0, 1])(
    "isolates sibling detail errors with gh exit code %s",
    async (exitCode) => {
      const prs = [1, 2].map((number) =>
        normalizeGhPr(
          {
            number,
            title: "PR",
            headRefName: "feature",
            state: "OPEN",
            headRefOid: "abc123",
          },
          "base/repo",
          1,
        ),
      );
      if (!prs[0] || !prs[1]) throw new Error("Invalid fixture");
      const healthy = {
        id: "PR-1",
        number: 1,
        baseRepository: { nameWithOwner: "base/repo" },
        headRefOid: "abc123",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        isMergeQueueEnabled: false,
        mergeQueueEntry: null,
        commits: {
          nodes: [{ commit: { oid: "abc123", statusCheckRollup: null } }],
        },
      };
      const stdout = JSON.stringify({
        data: { repository: { p0: healthy, p1: null } },
        errors: [
          { message: "sibling unavailable", path: ["repository", "p1"] },
        ],
      });
      exec.mockReturnValueOnce(
        exitCode === 0
          ? Effect.succeed({ stdout, stderr: "", exitCode })
          : Effect.fail(
              new ProcessExitError({
                command: "gh",
                args: ["api", "graphql"],
                stdout,
                stderr: "sibling unavailable",
                exitCode,
              }),
            ),
      );
      const result = await runBunPromise(
        fetchPrDetails("/repo", "base/repo", [prs[0], prs[1]]),
      );
      expect(result[0]).toMatchObject({
        number: 1,
        checksComplete: true,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        lastError: null,
      });
      expect(result[1]).toMatchObject({
        number: 2,
        checksComplete: false,
        lastError: "sibling unavailable",
      });
    },
  );

  test("a missing gh executable remains a fetch error", async () => {
    exec.mockReturnValueOnce(
      Effect.fail(
        new ProcessExitError({
          command: "gh",
          args: ["pr", "list"],
          stdout: "",
          stderr: "",
          exitCode: null,
          cause: Object.assign(new Error("spawn gh ENOENT"), {
            code: "ENOENT",
          }),
        }),
      ),
    );
    await expect(
      runBunPromise(liveGitHubService.listRawPrs("/repo", "all", "base/repo")),
    ).rejects.toMatchObject({ code: "pr_error" });
  });
});

function detail(
  contexts: unknown = { nodes: [], pageInfo: { hasNextPage: false } },
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "PR_42",
    number: 42,
    baseRepository: { nameWithOwner: "owner/repo" },
    headRefOid: "abc123",
    mergeable: "MERGEABLE",
    isMergeQueueEnabled: false,
    mergeQueueEntry: null,
    commits: {
      nodes: [{ commit: { oid: "abc123", statusCheckRollup: { contexts } } }],
    },
    ...overrides,
  };
}
function respond(repository: Record<string, unknown>) {
  return Effect.succeed({
    stdout: JSON.stringify({ data: { repository } }),
    stderr: "",
    exitCode: 0,
  });
}

describe("verified PR check pages", () => {
  beforeEach(() => exec.mockReset());

  test.each([
    {},
    { nodes: [] },
    { pageInfo: { hasNextPage: false } },
    { nodes: null, pageInfo: { hasNextPage: false } },
    { nodes: {}, pageInfo: { hasNextPage: false } },
    { nodes: [], pageInfo: null },
    { nodes: [], pageInfo: {} },
    { nodes: [], pageInfo: { hasNextPage: "false" } },
    { nodes: [], pageInfo: { hasNextPage: true } },
    { nodes: [], pageInfo: { hasNextPage: true, endCursor: 1 } },
    { nodes: [], pageInfo: { hasNextPage: true, endCursor: " " } },
    { nodes: [], pageInfo: { hasNextPage: false, endCursor: {} } },
  ])(
    "rejects malformed connection on initial and later pages: %j",
    async (contexts) => {
      for (const followUp of [false, true]) {
        exec.mockReset();
        if (followUp)
          exec.mockReturnValueOnce(
            respond({
              p0: detail({
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: "next" },
              }),
            }),
          );
        exec.mockReturnValueOnce(
          respond({ [followUp ? "p" : "p0"]: detail(contexts) }),
        );
        const [result] = await runBunPromise(
          fetchPrDetails("/repo", "owner/repo", [prFacts()]),
        );
        expect(result?.checksComplete).toBe(false);
        expect(result?.lastError).toContain("Incomplete");
        expect(exec).toHaveBeenCalledTimes(followUp ? 2 : 1);
      }
    },
  );

  test.each([
    { nodes: [], pageInfo: { hasNextPage: false } },
    {
      nodes: [
        null,
        { name: "future", conclusion: "FUTURE", status: "COMPLETED" },
      ],
      pageInfo: { hasNextPage: false },
    },
  ])(
    "accepts explicit complete pages and preserves unknown outcomes %j",
    async (contexts) => {
      exec.mockReturnValueOnce(respond({ p0: detail(contexts) }));
      const [result] = await runBunPromise(
        fetchPrDetails("/repo", "owner/repo", [prFacts()]),
      );
      expect(result?.checksComplete).toBe(true);
      expect(
        result?.checks?.every((check) => check.outcome === "unknown"),
      ).toBe(true);
    },
  );

  test.each([
    { headRefOid: "new-head" },
    { headRefOid: null },
    { number: 43 },
    { id: "other-pr" },
    { baseRepository: { nameWithOwner: "other/repo" } },
    {
      commits: {
        nodes: [{ commit: { oid: "other-head", statusCheckRollup: null } }],
      },
    },
    { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } },
  ])(
    "rejects mismatched identities on initial and later pages: %j",
    async (overrides) => {
      for (const followUp of [false, true]) {
        exec.mockReset();
        if (followUp)
          exec.mockReturnValueOnce(
            respond({
              p0: detail({
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: "next" },
              }),
            }),
          );
        exec.mockReturnValueOnce(
          respond({ [followUp ? "p" : "p0"]: detail(undefined, overrides) }),
        );
        const pr = prFacts({ state: "MERGED" });
        const [result] = await runBunPromise(
          fetchPrDetails("/repo", "owner/repo", [pr]),
        );
        expect(result).toMatchObject({
          state: "MERGED",
          headOid: "abc123",
          checks: null,
          checksComplete: false,
          lastError: expect.any(String),
        });
      }
    },
  );

  test("combines unchanged-head pages and detects repeated cursors", async () => {
    const first = detail({
      nodes: [{ name: "one", conclusion: "SUCCESS", status: "COMPLETED" }],
      pageInfo: { hasNextPage: true, endCursor: "next" },
    });
    exec
      .mockReturnValueOnce(respond({ p0: first }))
      .mockReturnValueOnce(respond({ p: detail() }));
    expect(
      (
        await runBunPromise(fetchPrDetails("/repo", "owner/repo", [prFacts()]))
      )[0],
    ).toMatchObject({
      checksComplete: true,
      checks: [{ name: "one", outcome: "passed" }],
    });
    exec.mockReset();
    exec
      .mockReturnValueOnce(respond({ p0: first }))
      .mockReturnValueOnce(respond({ p: first }));
    expect(
      (
        await runBunPromise(fetchPrDetails("/repo", "owner/repo", [prFacts()]))
      )[0],
    ).toMatchObject({
      checks: null,
      checksComplete: false,
      lastError: "Check pagination limit reached",
    });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it.effect(
    "a timed-out detail page cleans up before returning and leaves its sibling healthy",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const stopping = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const cleaned = yield* Deferred.make<void>();
        exec.mockReturnValueOnce(
          respond({
            p0: detail({
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: "next" },
            }),
            p1: detail(undefined, { id: "PR_43", number: 43 }),
          }),
        );
        exec.mockReturnValueOnce(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* Deferred.succeed(stopping, undefined);
                yield* Deferred.await(release);
                yield* Deferred.succeed(cleaned, undefined);
              }),
            ),
          ),
        );
        const fiber = yield* Effect.forkChild(
          provideBunServices(
            fetchPrDetails("/repo", "owner/repo", [
              prFacts(),
              prFacts({ number: 43 }),
            ]),
          ),
        );
        yield* Deferred.await(started);
        const clock = yield* Effect.forkChild(TestClock.adjust("2 minutes"));
        yield* Deferred.await(stopping);
        expect(yield* Deferred.isDone(cleaned)).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(clock);
        const result = yield* Fiber.join(fiber);
        expect(yield* Deferred.isDone(cleaned)).toBe(true);
        expect(result[0]).toMatchObject({
          checksComplete: false,
          lastError: expect.any(String),
        });
        expect(result[1]).toMatchObject({
          checksComplete: true,
          lastError: null,
        });
      }),
  );

  it.effect("base resolution has a finite deadline and can be retried", () =>
    Effect.gen(function* () {
      const stopped = yield* Deferred.make<void>();
      exec.mockReturnValueOnce(
        Effect.never.pipe(
          Effect.ensuring(Deferred.succeed(stopped, undefined)),
        ),
      );
      const fiber = yield* Effect.forkChild(
        provideBunServices(
          Effect.flip(liveGitHubService.resolveBaseRepo("/repo")),
        ),
      );
      yield* TestClock.adjust("2 minutes");
      expect(yield* Fiber.join(fiber)).toMatchObject({
        code: "pr_error",
        message: expect.stringContaining("timed out"),
      });
      expect(yield* Deferred.isDone(stopped)).toBe(true);
      exec.mockReturnValueOnce(
        Effect.succeed({
          stdout: JSON.stringify({ nameWithOwner: "owner/repo" }),
          stderr: "",
          exitCode: 0,
        }),
      );
      expect(
        yield* provideBunServices(liveGitHubService.resolveBaseRepo("/repo")),
      ).toBe("owner/repo");
    }),
  );
});

describe("merge preflight read deadlines", () => {
  beforeEach(() => exec.mockReset());
  it.effect.each(["facts", "configuration", "rules"] as const)(
    "bounds hung %s reads before any mutation",
    (stage) =>
      Effect.gen(function* () {
        if (stage !== "facts") {
          const pr = prFacts();
          exec.mockReturnValueOnce(
            Effect.succeed({
              stdout: JSON.stringify({ ...pr, headRefOid: pr.headOid }),
              stderr: "",
              exitCode: 0,
            }),
          );
          exec.mockReturnValueOnce(respond({ p0: detail() }));
          if (stage === "rules")
            exec.mockReturnValueOnce(
              respond({
                mergeQueue: null,
                squashMergeAllowed: true,
                mergeCommitAllowed: true,
                rebaseMergeAllowed: true,
              }),
            );
        }
        const stopped = yield* Deferred.make<void>();
        exec.mockReturnValueOnce(
          Effect.never.pipe(
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
        );
        const fiber = yield* Effect.forkChild(
          provideBunServices(
            Effect.flip(fetchMergeSnapshot("/repo", "owner/repo", 42)),
          ),
        );
        yield* TestClock.adjust("2 minutes");
        expect(yield* Fiber.join(fiber)).toMatchObject({
          code: "pr_error",
          message: expect.stringContaining("timed out"),
        });
        expect(yield* Deferred.isDone(stopped)).toBe(true);
        expect(
          exec.mock.calls.every(
            ([, args]) => !args?.some((arg) => arg.includes("mutation")),
          ),
        ).toBe(true);
      }),
  );
});

it.effect(
  "detail pagination uses a total budget even when each individual page is within its deadline",
  () =>
    Effect.gen(function* () {
      exec.mockReset();
      let pages = 0;
      exec.mockImplementation(() =>
        Effect.sleep("110 seconds").pipe(
          Effect.andThen(() => {
            const alias = pages++ === 0 ? "p0" : "p";
            return respond({
              [alias]: detail({
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: String(pages) },
              }),
            });
          }),
        ),
      );
      const fiber = yield* Effect.forkChild(
        provideBunServices(fetchPrDetails("/repo", "owner/repo", [prFacts()])),
      );
      yield* TestClock.adjust("10 minutes");
      const [result] = yield* Fiber.join(fiber);
      expect(result).toMatchObject({
        checksComplete: false,
        checks: null,
        lastError: expect.any(String),
      });
      expect(exec).toHaveBeenCalledTimes(6);
    }),
);

test.each(["PR_42", "replacement"])(
  "pagination retains the established node identity when discovery has no id: %s",
  async (nextId) => {
    exec.mockReset();
    exec.mockReturnValueOnce(
      respond({
        p0: detail({
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: "next" },
        }),
      }),
    );
    exec.mockReturnValueOnce(respond({ p: detail(undefined, { id: nextId }) }));
    const [result] = await runBunPromise(
      fetchPrDetails("/repo", "owner/repo", [prFacts({ id: "" })]),
    );
    expect(result).toMatchObject({
      id: "PR_42",
      checksComplete: nextId === "PR_42",
      lastError: nextId === "PR_42" ? null : "PR detail identity mismatch",
    });
  },
);
