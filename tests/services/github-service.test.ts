import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { runBunPromise } from "../../src/effect/runtime";
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

describe("GitHub raw PR fetching", () => {
  beforeEach(() => exec.mockReset());

  test.each(["[]", '[{"number":34,"title":"TUI","headRefName":"feat/tui"}]'])(
    "parses the open-PR list %s",
    async (stdout) => {
      exec.mockReturnValueOnce(
        Effect.succeed({ stdout, stderr: "", exitCode: 0 }),
      );
      expect(
        await runBunPromise(
          liveGitHubService.listRawPrs("/repo", "open", "base/repo"),
        ),
      ).toEqual(JSON.parse(stdout));
    },
  );

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
