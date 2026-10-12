import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import { runBunPromise } from "../../src/effect/runtime";
import { execProcess } from "../../src/services/process";

export async function makeIncludeRepo() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "wct-include-test-")),
  );
  const repo = join(root, "repo");
  const home = join(root, "home");
  await mkdir(repo);
  await mkdir(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, ".gitconfig"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");

  const git = (...args: string[]) =>
    runBunPromise(execProcess("git", args, { cwd: repo }));
  const write = async (path: string, content = path) => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await Bun.write(join(repo, path), content);
  };
  await git("init", "--quiet", "--template=", "--initial-branch=main");
  await git("config", "user.name", "Include Test");
  await git("config", "user.email", "include@example.com");
  await write("tracked.txt");
  await git("add", "tracked.txt");
  await git("commit", "--quiet", "-m", "Initial checkout");

  return {
    root,
    repo,
    home,
    git,
    write,
    cleanup: async () => {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export type IncludeRepo = Awaited<ReturnType<typeof makeIncludeRepo>>;
