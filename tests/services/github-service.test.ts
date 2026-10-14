import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { provideBunServices, runBunPromise } from "../../src/effect/runtime";
import { WctCommandError } from "../../src/errors";
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

function page(nodes: unknown[], hasNextPage = false) {
  return {
    data: {
      repository: { pullRequests: { nodes, pageInfo: { hasNextPage } } },
    },
  };
}

describe("GitHub raw PR fetching", () => {
  beforeEach(() => exec.mockReset());

  test.each(["[]", '[{"number":34,"title":"TUI","headRefName":"feat/tui"}]'])(
    "parses the open-PR list %s",
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
          liveGitHubService.listRawPrs("/repo", "open", "base/repo"),
        ),
      ).toEqual(JSON.parse(stdout));
    },
  );

  test.each(["all", "open"] as const)(
    "paginates %s PR discovery against the resolved base without check payloads",
    async (state) => {
      const first = { number: 1 };
      const second = { number: 200 };
      exec.mockReturnValueOnce(
        Effect.succeed({
          stdout: JSON.stringify([page([first], true), page([second])]),
          stderr: "",
          exitCode: 0,
        }),
      );
      expect(
        await runBunPromise(
          liveGitHubService.listRawPrs("/repo", state, "base/repo"),
        ),
      ).toEqual([first, second]);
      expect(exec).toHaveBeenCalledTimes(1);
      const args = exec.mock.calls[0]?.[1] ?? [];
      expect(args).toEqual(
        expect.arrayContaining(["api", "graphql", "--paginate", "--slurp"]),
      );
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      expect(query).toContain('repository(owner: "base", name: "repo")');
      expect(query.includes("states: [OPEN]")).toBe(state === "open");
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

  it.effect.each([
    ["all", "10 minutes"],
    ["open", "2 minutes"],
  ] as const)("bounds %s pagination at %s", ([state, duration]) =>
    Effect.gen(function* () {
      exec.mockReturnValueOnce(Effect.never);
      const fiber = yield* Effect.forkChild(
        provideBunServices(
          Effect.flip(
            liveGitHubService.listRawPrs("/repo", state, "base/repo"),
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
      runBunPromise(liveGitHubService.listRawPrs("/repo", "open", "base/repo")),
    ).rejects.toMatchObject({ code: "pr_error" });
  });

  test.each(["not json", "{}", "null"])(
    "rejects malformed open-PR output %s",
    async (stdout) => {
      exec.mockReturnValueOnce(
        Effect.succeed({ stdout, stderr: "", exitCode: 0 }),
      );
      await expect(
        runBunPromise(
          liveGitHubService.listRawPrs("/repo", "open", "base/repo"),
        ),
      ).rejects.toMatchObject({
        code: "pr_error",
        message: expect.stringContaining("Failed to list open PRs:"),
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
      Effect.flip(liveGitHubService.listRawPrs("/repo", "open", "base/repo")),
    );
    expect(error).toBeInstanceOf(WctCommandError);
    expect(error).toMatchObject({
      code: "pr_error",
      message: "Failed to list open PRs: authentication required",
      cause: failure,
    });
  });

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
      runBunPromise(liveGitHubService.listRawPrs("/repo", "open", "base/repo")),
    ).rejects.toMatchObject({ code: "pr_error" });
  });
});
