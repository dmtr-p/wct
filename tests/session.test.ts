import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { maybeAttachSession } from "../src/commands/session";
import { runBunPromise } from "../src/effect/runtime";
import { commandError } from "../src/errors";
import type { WctEnv } from "../src/types/env";
import { noopTmuxService, withTestServices } from "./helpers/services";

const env: WctEnv = {
  WCT_MAIN_DIR: "/repo",
  WCT_WORKTREE_DIR: "/work/feature",
  WCT_WORK_DIR: "/work/feature",
  WCT_BRANCH: "feature",
  WCT_PROJECT: "project",
};
const session = {
  name: "feature-hash",
  id: "$7",
  server: "test-server",
  attached: false,
  windows: 1,
};

describe("automatic session attachment", { concurrent: false }, () => {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(
    process.stdin,
    "isTTY",
  );
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(
    process.stdout,
    "isTTY",
  );

  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    vi.stubEnv("TMUX", "");
    vi.stubEnv("NO_COLOR", "1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (stdinDescriptor)
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    if (stdoutDescriptor)
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    else Reflect.deleteProperty(process.stdout, "isTTY");
  });

  test.each([
    {
      name: "inspection failure",
      resolve: () =>
        Effect.fail(commandError("tmux_error", "inspection failed")),
      warning: "inspection failed",
    },
    {
      name: "ownership conflict",
      resolve: () =>
        Effect.fail(commandError("tmux_error", "ownership conflict")),
      warning: "ownership conflict",
    },
    {
      name: "absent session",
      resolve: () => Effect.succeed(null),
      warning: "No verified tmux session ID",
    },
    {
      name: "missing ID",
      resolve: () => Effect.succeed({ ...session, id: undefined }),
      warning: "No verified tmux session ID",
    },
  ])(
    "warns without failing or attaching for $name",
    async ({ resolve, warning }) => {
      const logs = vi.spyOn(console, "log").mockImplementation(() => {});
      const attach = vi.fn(() => Effect.void);
      const switchSession = vi.fn(() => Effect.void);
      await expect(
        runBunPromise(
          withTestServices(maybeAttachSession(session.name, false, env), {
            tmux: {
              ...noopTmuxService,
              resolveSession: resolve,
              attachSession: attach,
              switchSession,
            },
          }),
        ),
      ).resolves.toBeUndefined();
      const output = logs.mock.calls.map((args) => String(args[0])).join("\n");
      expect(output).toContain(warning);
      expect(output).toContain(
        "Inspect the tmux sessions and retry once Workspace ownership is verified.",
      );
      expect(output).not.toContain("tmux attach");
      expect(attach).not.toHaveBeenCalled();
      expect(switchSession).not.toHaveBeenCalled();
    },
  );

  test.each(["", "socket,10,0"])(
    "uses the verified session ID with TMUX=%s",
    async (tmux) => {
      vi.stubEnv("TMUX", tmux);
      vi.spyOn(console, "log").mockImplementation(() => {});
      const attach = vi.fn(() => Effect.void);
      const switchSession = vi.fn(() => Effect.void);
      await runBunPromise(
        withTestServices(maybeAttachSession(session.name, false, env), {
          tmux: {
            ...noopTmuxService,
            resolveSession: () => Effect.succeed(session),
            attachSession: attach,
            switchSession,
          },
        }),
      );
      expect(tmux ? switchSession : attach).toHaveBeenCalledWith(session.id);
      expect(tmux ? attach : switchSession).not.toHaveBeenCalled();
    },
  );
});
