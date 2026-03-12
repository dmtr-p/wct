import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { runBunPromise } from "../src/effect/runtime";
import { spawnInteractive } from "../src/services/process";

describe("process", () => {
  afterEach(() => {
    mock.restore();
  });

  test("spawnInteractive uses Bun.spawn with inherited stdio", async () => {
    const spawn = spyOn(Bun, "spawn").mockReturnValue({
      exited: Promise.resolve(0),
    } as unknown as ReturnType<typeof Bun.spawn>);

    const exitCode = await runBunPromise(
      spawnInteractive("/bin/sh", ["-c", "exit 0"], {
        cwd: "/tmp/worktree",
        env: {
          WCT_BRANCH: "main",
        },
      }),
    );

    expect(exitCode).toBe(0);
    expect(spawn).toHaveBeenCalledWith(["/bin/sh", "-c", "exit 0"], {
      cwd: "/tmp/worktree",
      env: expect.objectContaining({
        WCT_BRANCH: "main",
      }),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  });

  test("spawnInteractive can replace the environment when extendEnv is false", async () => {
    const spawn = spyOn(Bun, "spawn").mockReturnValue({
      exited: Promise.resolve(0),
    } as unknown as ReturnType<typeof Bun.spawn>);

    await runBunPromise(
      spawnInteractive("/bin/sh", [], {
        extendEnv: false,
        env: {
          WCT_BRANCH: "feature",
          EMPTY: undefined,
        },
      }),
    );

    expect(spawn).toHaveBeenCalledWith(["/bin/sh"], {
      cwd: undefined,
      env: {
        WCT_BRANCH: "feature",
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  });
});
