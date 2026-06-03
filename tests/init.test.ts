import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initCommand } from "../src/commands/init";
import { CONFIG_FILENAME } from "../src/config/loader";
import { runBunPromise } from "../src/effect/runtime";
import {
  liveRegistryService,
  type RegistryServiceApi,
} from "../src/services/registry-service";
import { liveWorktreeService } from "../src/services/worktree-service";
import { withTestServices } from "./helpers/services";

describe("init command", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "wct-init-"));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates config and hints at explicit project registration without registering", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const registerCalls: string[] = [];

    try {
      await runBunPromise(
        withTestServices(initCommand(), {
          registry: {
            ...liveRegistryService,
            register: (path: string) =>
              Effect.sync(() => {
                registerCalls.push(path);
                return {
                  status: "registered" as const,
                  item: {
                    id: "registry-item",
                    repo_path: path,
                    project: "init-project",
                    created_at: 1,
                  },
                };
              }),
          } satisfies RegistryServiceApi,
          worktree: {
            ...liveWorktreeService,
            getMainRepoPath: () => Effect.succeed(tempDir),
          },
        }),
      );

      expect(await Bun.file(join(tempDir, CONFIG_FILENAME)).exists()).toBe(
        true,
      );
      expect(registerCalls).toEqual([]);
      const loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
      expect(
        loggedLines.some((line) =>
          line.includes("Run 'wct projects add' to show this repo in the TUI"),
        ),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
