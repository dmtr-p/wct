import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { provideBunServices, runBunPromise } from "../../src/effect/runtime";
import { WctCommandError } from "../../src/errors";
import { normalizeGhPr } from "../../src/services/pr-discovery";
import { ProcessExitError } from "../../src/services/process";

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
    ["updated", "10 minutes"],
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
          { number, title: "PR", headRefName: "feature", state: "OPEN" },
          "base/repo",
          1,
        ),
      );
      if (!prs[0] || !prs[1]) throw new Error("Invalid fixture");
      const healthy = {
        id: "PR-1",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        isMergeQueueEnabled: false,
        mergeQueueEntry: null,
        commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
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
