import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { $ } from "bun";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
  findMatchingRemote,
  liveGitHubService,
  parseAllPrPages,
  parsePrArg,
  parseRemoteOwnerRepo,
} from "../src/services/github-service";

describe("GitHub PR resolution", () => {
  describe("paginated PR discovery", () => {
    test("collects every page beyond 1,000 PRs", () => {
      const pages = Array.from({ length: 11 }, (_, index) => ({
        data: {
          repository: {
            pullRequests: {
              nodes: Array.from(
                { length: index === 10 ? 1 : 100 },
                (_, offset) => ({ number: index * 100 + offset + 1 }),
              ),
              pageInfo: { hasNextPage: index < 10 },
            },
          },
        },
      }));
      const prs = parseAllPrPages(JSON.stringify(pages)) as {
        number: number;
      }[];
      expect(prs).toHaveLength(1001);
      expect(prs.at(-1)?.number).toBe(1001);
    });

    test("rejects incomplete pagination and GraphQL errors", () => {
      const page = {
        data: {
          repository: {
            pullRequests: {
              nodes: [{ number: 1 }],
              pageInfo: { hasNextPage: true },
            },
          },
        },
      };
      expect(() => parseAllPrPages(JSON.stringify([page]))).toThrow(
        "PR pagination did not finish",
      );
      expect(() =>
        parseAllPrPages(
          JSON.stringify([{ ...page, errors: [{ message: "no" }] }]),
        ),
      ).toThrow("no");
    });
  });

  describe("parsePrArg", () => {
    test("parses a plain number", () => {
      expect(parsePrArg("123")).toBe(123);
    });

    test("parses a single-digit number", () => {
      expect(parsePrArg("1")).toBe(1);
    });

    test("parses a large number", () => {
      expect(parsePrArg("99999")).toBe(99999);
    });

    test("parses a GitHub PR URL", () => {
      expect(parsePrArg("https://github.com/user/repo/pull/456")).toBe(456);
    });

    test("parses a GitHub PR URL with trailing slash", () => {
      expect(parsePrArg("https://github.com/user/repo/pull/456/")).toBe(456);
    });

    test("parses an http GitHub PR URL", () => {
      expect(parsePrArg("http://github.com/org/project/pull/789")).toBe(789);
    });

    test("returns null for zero", () => {
      expect(parsePrArg("0")).toBeNull();
    });

    test("returns null for negative number", () => {
      expect(parsePrArg("-1")).toBeNull();
    });

    test("returns null for non-numeric string", () => {
      expect(parsePrArg("abc")).toBeNull();
    });

    test("returns null for empty string", () => {
      expect(parsePrArg("")).toBeNull();
    });

    test("returns null for a float", () => {
      expect(parsePrArg("1.5")).toBeNull();
    });

    test("returns null for a non-GitHub URL", () => {
      expect(parsePrArg("https://gitlab.com/user/repo/pull/123")).toBeNull();
    });

    test("returns null for a GitHub URL that is not a PR", () => {
      expect(parsePrArg("https://github.com/user/repo/issues/123")).toBeNull();
    });

    test("returns null for a malformed GitHub PR URL", () => {
      expect(parsePrArg("https://github.com/user/repo/pull/")).toBeNull();
    });

    test("returns null for a GitHub PR URL with extra path segments", () => {
      expect(
        parsePrArg("https://github.com/user/repo/pull/123/files"),
      ).toBeNull();
    });
  });

  describe("parseRemoteOwnerRepo", () => {
    test("parses SSH URL with .git", () => {
      expect(parseRemoteOwnerRepo("git@github.com:owner/repo.git")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    test("parses SSH URL without .git", () => {
      expect(parseRemoteOwnerRepo("git@github.com:owner/repo")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    test("parses HTTPS URL with .git", () => {
      expect(parseRemoteOwnerRepo("https://github.com/owner/repo.git")).toEqual(
        { owner: "owner", repo: "repo" },
      );
    });

    test("parses HTTPS URL without .git", () => {
      expect(parseRemoteOwnerRepo("https://github.com/owner/repo")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    test("parses SSH URL with ssh:// scheme", () => {
      expect(
        parseRemoteOwnerRepo("ssh://git@github.com/owner/repo.git"),
      ).toEqual({ owner: "owner", repo: "repo" });
    });

    test("parses SSH URL with explicit port", () => {
      expect(
        parseRemoteOwnerRepo("ssh://git@github.com:22/owner/repo.git"),
      ).toEqual({ owner: "owner", repo: "repo" });
    });

    test("returns null for non-GitHub URL", () => {
      expect(
        parseRemoteOwnerRepo("https://gitlab.com/owner/repo.git"),
      ).toBeNull();
    });

    test("returns null for lookalike host (prefix)", () => {
      expect(
        parseRemoteOwnerRepo("https://evilgithub.com/owner/repo.git"),
      ).toBeNull();
    });

    test("returns null for lookalike host (subdomain prefix)", () => {
      expect(
        parseRemoteOwnerRepo("ssh://git@corp-github.com/owner/repo.git"),
      ).toBeNull();
    });

    test("returns null for lookalike SSH host", () => {
      expect(
        parseRemoteOwnerRepo("git@corp-github.com:owner/repo.git"),
      ).toBeNull();
    });

    test("returns null for malformed URL", () => {
      expect(parseRemoteOwnerRepo("not-a-url")).toBeNull();
    });

    test("returns null for empty string", () => {
      expect(parseRemoteOwnerRepo("")).toBeNull();
    });
  });

  describe("findMatchingRemote", () => {
    const remoteOutput = [
      "origin\tgit@github.com:user/fork.git (fetch)",
      "origin\tgit@github.com:user/fork.git (push)",
      "upstream\thttps://github.com/org/repo.git (fetch)",
      "upstream\thttps://github.com/org/repo.git (push)",
    ].join("\n");

    test("returns matching remote name", () => {
      expect(findMatchingRemote(remoteOutput, "org", "repo")).toBe("upstream");
    });

    test("returns origin when origin matches", () => {
      expect(findMatchingRemote(remoteOutput, "user", "fork")).toBe("origin");
    });

    test("returns null when no remote matches", () => {
      expect(findMatchingRemote(remoteOutput, "other", "project")).toBeNull();
    });

    test("matches case-insensitively", () => {
      expect(findMatchingRemote(remoteOutput, "Org", "Repo")).toBe("upstream");
    });

    test("returns null for unparseable remotes (SSH alias)", () => {
      const aliasOutput = [
        "origin\tgh:user/repo.git (fetch)",
        "origin\tgh:user/repo.git (push)",
      ].join("\n");
      expect(findMatchingRemote(aliasOutput, "user", "repo")).toBeNull();
    });

    test("returns null for empty output", () => {
      expect(findMatchingRemote("", "owner", "repo")).toBeNull();
    });

    test("finds match among mixed parseable and unparseable remotes", () => {
      const mixedOutput = [
        "origin\tgh:user/repo.git (fetch)",
        "origin\tgh:user/repo.git (push)",
        "upstream\thttps://github.com/org/repo.git (fetch)",
        "upstream\thttps://github.com/org/repo.git (push)",
      ].join("\n");
      expect(findMatchingRemote(mixedOutput, "org", "repo")).toBe("upstream");
    });

    test("prefers origin over other matching remotes", () => {
      const dupeOutput = [
        "backup\thttps://github.com/org/repo.git (fetch)",
        "backup\thttps://github.com/org/repo.git (push)",
        "origin\thttps://github.com/org/repo.git (fetch)",
        "origin\thttps://github.com/org/repo.git (push)",
      ].join("\n");
      expect(findMatchingRemote(dupeOutput, "org", "repo")).toBe("origin");
    });

    test("prefers upstream over other non-origin remotes", () => {
      const output = [
        "backup\thttps://github.com/org/repo.git (fetch)",
        "backup\thttps://github.com/org/repo.git (push)",
        "upstream\thttps://github.com/org/repo.git (fetch)",
        "upstream\thttps://github.com/org/repo.git (push)",
        "origin\thttps://github.com/user/fork.git (fetch)",
        "origin\thttps://github.com/user/fork.git (push)",
      ].join("\n");
      expect(findMatchingRemote(output, "org", "repo")).toBe("upstream");
    });

    test("falls back to first match when neither origin nor upstream match", () => {
      const output = [
        "backup\thttps://github.com/org/repo.git (fetch)",
        "backup\thttps://github.com/org/repo.git (push)",
        "mirror\thttps://github.com/org/repo.git (fetch)",
        "mirror\thttps://github.com/org/repo.git (push)",
        "origin\thttps://github.com/user/fork.git (fetch)",
        "origin\thttps://github.com/user/fork.git (push)",
      ].join("\n");
      expect(findMatchingRemote(output, "org", "repo")).toBe("backup");
    });
  });
});

describe("liveGitHubService.fetchBranch", () => {
  test("materializes fetched PR branches as remote-tracking refs", async () => {
    const baseDir = await realpath(await mkdtemp(join(tmpdir(), "wct-gh-")));
    const remoteDir = join(baseDir, "remote.git");
    const sourceDir = join(baseDir, "source");
    const cloneDir = join(baseDir, "clone");

    try {
      await $`git init --bare ${remoteDir}`.quiet();
      await $`git init -b main ${sourceDir}`.quiet();
      await $`git config user.email "test@test.com"`.quiet().cwd(sourceDir);
      await $`git config user.name "Test"`.quiet().cwd(sourceDir);
      await $`git config commit.gpgSign false`.quiet().cwd(sourceDir);
      await Bun.write(join(sourceDir, "README.md"), "initial\n");
      await $`git add README.md`.quiet().cwd(sourceDir);
      await $`git commit -m initial`.quiet().cwd(sourceDir);
      await $`git remote add origin ${remoteDir}`.quiet().cwd(sourceDir);
      await $`git push origin main`.quiet().cwd(sourceDir);
      await $`git switch -c contributor/pr-branch`.quiet().cwd(sourceDir);
      await Bun.write(join(sourceDir, "feature.txt"), "feature\n");
      await $`git add feature.txt`.quiet().cwd(sourceDir);
      await $`git commit -m feature`.quiet().cwd(sourceDir);
      await $`git push origin contributor/pr-branch`.quiet().cwd(sourceDir);

      await $`git clone ${remoteDir} ${cloneDir}`.quiet();
      await $`git update-ref -d refs/remotes/origin/contributor/pr-branch`
        .quiet()
        .cwd(cloneDir);

      await Effect.runPromise(
        Effect.provide(
          liveGitHubService.fetchBranch(
            "contributor/pr-branch",
            "origin",
            cloneDir,
          ),
          BunServices.layer,
        ),
      );

      const ref =
        await $`git rev-parse --verify refs/remotes/origin/contributor/pr-branch`
          .quiet()
          .cwd(cloneDir)
          .text();
      expect(ref.trim()).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
