import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { runBunPromise } from "../src/effect/runtime";
import {
  assertWorkspaceTarget,
  inspectWorkspaceTarget,
} from "../src/services/workspace-target";
import { liveWorktreeService } from "../src/services/worktree-service";
import { withTestServices } from "./helpers/services";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: vi.fn(),
}));

test("HOME-unset target evidence tracks the loader's actual global configuration", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "wct-config-evidence-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  try {
    await mkdir(home);
    await mkdir(repo);
    vi.stubEnv("HOME", undefined);
    vi.mocked(os.homedir).mockReturnValue(home);
    const global = join(home, ".wct.yaml");
    await Bun.write(global, "project_name: original\n");
    const failure = await runBunPromise(
      withTestServices(
        Effect.gen(function* () {
          const target = yield* inspectWorkspaceTarget(repo);
          yield* Effect.promise(() =>
            Bun.write(global, "project_name: changed\n"),
          );
          return yield* Effect.flip(assertWorkspaceTarget(target));
        }),
        {
          worktree: {
            ...liveWorktreeService,
            isGitRepo: () => Effect.succeed(true),
            getWorktreeRoot: () => Effect.succeed(repo),
            getMainRepoPath: () => Effect.succeed(repo),
            getCurrentBranch: () => Effect.succeed("feature"),
          },
        },
      ),
    );
    expect(failure.message).toContain("configuration changed");
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
