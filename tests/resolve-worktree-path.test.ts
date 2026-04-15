import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { resolveWorktreePath } from "../src/commands/resolve-worktree-path";
import { runBunPromise } from "../src/effect/runtime";
import {
  liveWorktreeService,
  WorktreeService,
} from "../src/services/worktree-service";
import { withTestServices } from "./helpers/services";

function withWorktreeService<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return withTestServices(
    Effect.provideService(effect, WorktreeService, liveWorktreeService),
  );
}

async function runResolveWorktreePath(
  options: Parameters<typeof resolveWorktreePath>[0],
) {
  return await runBunPromise(withWorktreeService(resolveWorktreePath(options)));
}

async function createWorktreeFixture() {
  const repoDir = await realpath(
    await mkdtemp(join(tmpdir(), "wct-test-resolve-")),
  );
  const worktreeRoot = await realpath(
    await mkdtemp(join(tmpdir(), "wct-test-resolve-wt-")),
  );

  await $`git init -b main`.quiet().cwd(repoDir);
  await $`git config user.email "test@test.com"`.quiet().cwd(repoDir);
  await $`git config user.name "Test"`.quiet().cwd(repoDir);
  await $`git config commit.gpgSign false`.quiet().cwd(repoDir);
  await $`git commit --allow-empty -m "initial"`.quiet().cwd(repoDir);

  const worktreePath = join(worktreeRoot, "feature-branch");
  await $`git worktree add -b feature-branch ${worktreePath}`
    .quiet()
    .cwd(repoDir);

  return {
    repoDir: await realpath(repoDir),
    worktreeRoot: await realpath(worktreeRoot),
    worktreePath: await realpath(worktreePath),
  };
}

describe("resolveWorktreePath", () => {
  let repoDir: string;
  let worktreeRoot: string;
  let worktreePath: string;
  const originalDir = process.cwd();

  beforeAll(async () => {
    const fixture = await createWorktreeFixture();
    repoDir = fixture.repoDir;
    worktreeRoot = fixture.worktreeRoot;
    worktreePath = fixture.worktreePath;
  });

  afterAll(async () => {
    process.chdir(originalDir);
    await rm(repoDir, { recursive: true, force: true });
    await rm(worktreeRoot, { recursive: true, force: true });
  });

  test("returns cwd when no options given", async () => {
    process.chdir(repoDir);

    await expect(runResolveWorktreePath({})).resolves.toBe(process.cwd());
  });

  test("returns path directly when --path is given", async () => {
    process.chdir(repoDir);
    const explicitPath = join(worktreeRoot, "explicit-path");

    await expect(runResolveWorktreePath({ path: explicitPath })).resolves.toBe(
      explicitPath,
    );
  });

  test("resolves path from branch name when --branch is given", async () => {
    process.chdir(repoDir);

    await expect(
      runResolveWorktreePath({ branch: "feature-branch" }),
    ).resolves.toBe(worktreePath);
  });

  test("errors when both --path and --branch are given", async () => {
    process.chdir(repoDir);

    await expect(
      runResolveWorktreePath({
        path: join(worktreeRoot, "explicit-path"),
        branch: "feature-branch",
      }),
    ).rejects.toMatchObject({
      code: "invalid_options",
      message: "--path and --branch are mutually exclusive",
    });
  });

  test("errors when --branch does not match any worktree", async () => {
    process.chdir(repoDir);

    await expect(
      runResolveWorktreePath({ branch: "missing-branch" }),
    ).rejects.toMatchObject({
      code: "worktree_not_found",
      message: "No worktree found for branch 'missing-branch'",
    });
  });
});
