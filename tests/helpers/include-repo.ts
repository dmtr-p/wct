import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import { runBunPromise } from "../../src/effect/runtime";
import { execProcess } from "../../src/services/process";
import { test as base } from "./temp-dir";

export interface IncludeRepo {
  root: string;
  repo: string;
  home: string;
  git: (...args: string[]) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  write: (path: string, content?: string) => Promise<void>;
}

async function includeRepoFixture(
  { tempDir: root }: { tempDir: string },
  use: (repo: IncludeRepo) => Promise<void>,
) {
  const repo = join(root, "repo");
  const home = join(root, "home");

  const git = (...args: string[]) =>
    runBunPromise(execProcess("git", args, { cwd: repo }));
  const write = async (path: string, content = path) => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await Bun.write(join(repo, path), content);
  };
  await mkdir(repo);
  await mkdir(home);
  try {
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, ".gitconfig"));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    await git("init", "--quiet", "--template=", "--initial-branch=main");
    await git("config", "user.name", "Include Test");
    await git("config", "user.email", "include@example.com");
    await write("tracked.txt");
    await git("add", "tracked.txt");
    await git("commit", "--quiet", "-m", "Initial checkout");
    await use({ root, repo, home, git, write });
  } finally {
    vi.unstubAllEnvs();
  }
}

export const test = base.extend<{ includeRepo: IncludeRepo }>({
  includeRepo: includeRepoFixture,
});
