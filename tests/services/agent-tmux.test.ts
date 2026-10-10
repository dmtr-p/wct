import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";
import { runBunPromise } from "../../src/effect/runtime";
import {
  ProcessExitError,
  ProcessOutputLimitError,
} from "../../src/services/process";

const exec = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/process", async () => ({
  ...(await vi.importActual<typeof import("../../src/services/process")>(
    "../../src/services/process",
  )),
  execProcess: exec,
}));
const { captureAgentPane, discoverAgentPanes } = await import(
  "../../src/services/tmux"
);

const processFailure = (
  stderr: string,
  exitCode: number | null = 1,
  cause?: unknown,
) =>
  new ProcessExitError({
    command: "tmux",
    args: ["list-panes", "-a"],
    stdout: "",
    stderr,
    exitCode,
    cause,
  });

describe("tmux observation primitives", () => {
  test("captures the live base grid without alternate/copy/scrollback flags", async () => {
    exec.mockReturnValueOnce(
      Effect.succeed({ stdout: "one\n\ntwo\n", stderr: "", exitCode: 0 }),
    );
    expect(await runBunPromise(captureAgentPane("%42"))).toBe("one\n\ntwo\n");
    expect(exec).toHaveBeenLastCalledWith(
      "tmux",
      ["capture-pane", "-p", "-t", "%42"],
      { maxOutputBytes: 256 * 1024 },
    );
  });
  test("capture failure remains an error rather than an empty screen", async () => {
    exec.mockReturnValueOnce(Effect.fail(new Error("pane disappeared")));
    await expect(runBunPromise(captureAgentPane("%42"))).rejects.toThrow(
      "pane disappeared",
    );
  });
  test("batches server-wide metadata without changing attachments or clients", async () => {
    exec.mockReturnValueOnce(
      Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
    );
    await runBunPromise(discoverAgentPanes());
    const call = exec.mock.calls.at(-1);
    if (!call) throw new Error("Missing tmux metadata command");
    const [command, args] = call;
    expect(command).toBe("tmux");
    expect(args.slice(0, 3)).toEqual(["list-panes", "-a", "-F"]);
    expect(args[3]).toContain("#{start_time}");
    expect(args[3]).toContain("#{pane_pb_state}");
  });
  test("unsupported metadata is a discovery failure, not confirmed pane removal", async () => {
    exec.mockReturnValueOnce(
      Effect.succeed({ stdout: "unsupported fields", stderr: "", exitCode: 0 }),
    );
    await expect(runBunPromise(discoverAgentPanes())).rejects.toThrow(
      "metadata unavailable",
    );
  });
  test.each([
    "no server running on /tmp/tmux-501/default\n",
    "error connecting to /tmp/tmux-501/default (No such file or directory)\n",
    "error connecting to /tmp/tmux-501/default (Connection refused)\n",
  ])("absent-server exit returns an empty pane list: %s", async (stderr) => {
    exec.mockReturnValueOnce(Effect.fail(processFailure(stderr)));
    expect(await runBunPromise(discoverAgentPanes())).toEqual([]);
  });
  test.each([
    [
      "permission denied",
      processFailure(
        "error connecting to /tmp/tmux-501/default (Permission denied)",
      ),
    ],
    [
      "operation not permitted",
      processFailure(
        "error connecting to /tmp/tmux-501/default (Operation not permitted)",
      ),
    ],
    [
      "connection timeout",
      processFailure(
        "error connecting to /tmp/tmux-501/default (Connection timed out)",
      ),
    ],
    ["other exit", processFailure("unknown option: -F")],
    ["plain error", new Error("no server running on /tmp/tmux-501/default")],
    [
      "spawn failure",
      processFailure("no server running on /tmp/tmux-501/default", null),
    ],
    ["output limit", processFailure("", null, new ProcessOutputLimitError())],
    [
      "exit with output-limit cause",
      processFailure(
        "no server running on /tmp/tmux-501/default",
        1,
        new ProcessOutputLimitError(),
      ),
    ],
  ])("discovery preserves %s as a failure", async (_label, error) => {
    exec.mockReturnValueOnce(Effect.fail(error));
    const result = await runBunPromise(
      discoverAgentPanes().pipe(
        Effect.match({
          onFailure: (failure) => failure,
          onSuccess: () => undefined,
        }),
      ),
    );
    expect(result).toBe(error);
  });
  test("discovery timeout remains a failure", async () => {
    exec.mockReturnValueOnce(Effect.never);
    const result = await runBunPromise(
      discoverAgentPanes().pipe(
        Effect.match({
          onFailure: (failure) => failure,
          onSuccess: () => undefined,
        }),
      ),
    );
    expect(result).toMatchObject({ _tag: "TimeoutError" });
  });
});
