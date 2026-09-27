import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  predictPushRef,
  resolveWorkspacePr,
} from "../../src/services/pr-discovery";
import type { PrFacts } from "../../src/services/pr-model";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wct-push-"));
  directories.push(root);
  const origin = join(root, "origin.git");
  const fork = join(root, "fork.git");
  const local = join(root, "local");
  git(root, "init", "--bare", origin);
  git(root, "init", "--bare", fork);
  git(root, "init", local);
  git(local, "config", "user.name", "Fixture");
  git(local, "config", "user.email", "fixture@example.invalid");
  git(local, "commit", "--allow-empty", "-m", "seed");
  git(local, "branch", "-M", "feature");
  git(local, "remote", "add", "origin", origin);
  git(local, "remote", "add", "fork", fork);
  git(local, "config", "branch.feature.remote", "origin");
  return { local, origin, fork };
}

function predict(local: string): { remote: string; branch: string | null } {
  const [remote = "", remoteref = ""] = git(
    local,
    "for-each-ref",
    "--format=%(push:remotename)%09%(push:remoteref)",
    "refs/heads/feature",
  ).split("\t");
  const value = (key: string) =>
    spawnSync("git", ["config", "--get", key], {
      cwd: local,
      encoding: "utf8",
    }).stdout.trim();
  const refs = spawnSync(
    "git",
    ["config", "--get-all", `remote.${remote}.push`],
    { cwd: local, encoding: "utf8" },
  ).stdout.trim();
  return {
    remote,
    branch: predictPushRef({
      branch: "feature",
      remote,
      upstreamRemote: value("branch.feature.remote") || "origin",
      upstreamMerge: value("branch.feature.merge"),
      pushDefault: value("push.default") || "simple",
      refspecs: refs ? refs.split("\n") : [],
      pushRemoteRef: remoteref,
    }),
  };
}

describe("push destination against a real git push", () => {
  test.each([
    [
      "simple matching upstream",
      (local: string) => {
        git(local, "config", "branch.feature.merge", "refs/heads/feature");
      },
      "origin",
      "feature",
    ],
    [
      "simple different upstream",
      (local: string) => {
        git(local, "config", "branch.feature.merge", "refs/heads/main");
      },
      "origin",
      null,
    ],
    ["simple missing upstream", (_local: string) => {}, "origin", null],
    [
      "current",
      (local: string) => {
        git(local, "config", "push.default", "current");
      },
      "origin",
      "feature",
    ],
    [
      "triangular simple",
      (local: string) => {
        git(local, "config", "branch.feature.merge", "refs/heads/main");
        git(local, "config", "branch.feature.pushRemote", "fork");
      },
      "fork",
      "feature",
    ],
    [
      "remote pushDefault",
      (local: string) => {
        git(local, "config", "branch.feature.merge", "refs/heads/main");
        git(local, "config", "remote.pushDefault", "fork");
      },
      "fork",
      "feature",
    ],
    [
      "matching absent",
      (local: string) => {
        git(local, "config", "push.default", "matching");
      },
      "origin",
      null,
    ],
    [
      "upstream central",
      (local: string) => {
        git(local, "config", "push.default", "upstream");
        git(local, "config", "branch.feature.merge", "refs/heads/main");
      },
      "origin",
      "main",
    ],
    [
      "upstream triangular",
      (local: string) => {
        git(local, "config", "push.default", "upstream");
        git(local, "config", "branch.feature.merge", "refs/heads/main");
        git(local, "config", "branch.feature.pushRemote", "fork");
      },
      "fork",
      null,
    ],
    [
      "nothing",
      (local: string) => {
        git(local, "config", "push.default", "nothing");
      },
      "origin",
      null,
    ],
    [
      "one push refspec",
      (local: string) => {
        git(
          local,
          "config",
          "remote.origin.push",
          "refs/heads/feature:refs/heads/dest",
        );
      },
      "origin",
      "dest",
    ],
    [
      "unmatched push refspec",
      (local: string) => {
        git(local, "branch", "release");
        git(
          local,
          "config",
          "remote.origin.push",
          "refs/heads/release:refs/heads/release",
        );
      },
      "origin",
      null,
    ],
    [
      "multiple push refspecs",
      (local: string) => {
        git(
          local,
          "config",
          "--add",
          "remote.origin.push",
          "refs/heads/feature:refs/heads/one",
        );
        git(
          local,
          "config",
          "--add",
          "remote.origin.push",
          "refs/heads/feature:refs/heads/two",
        );
      },
      "origin",
      null,
    ],
  ] as const)("%s", (_name, configure, expectedRemote, expectedBranch) => {
    const { local, origin, fork } = fixture();
    configure(local);
    const prediction = predict(local);
    expect(prediction.remote).toBe(expectedRemote);
    expect(prediction.branch).toBe(expectedBranch);
    const push = spawnSync("git", ["push"], { cwd: local, encoding: "utf8" });
    if (expectedBranch) {
      expect(push.status).toBe(0);
      const bare = expectedRemote === "fork" ? fork : origin;
      expect(git(bare, "rev-parse", `refs/heads/${expectedBranch}`)).toBe(
        git(local, "rev-parse", "HEAD"),
      );
    } else {
      expect(prediction.branch).toBeNull();
    }
  });
});

function pr(
  number: number,
  state: PrFacts["state"],
  headRepository = "alice/repo",
): PrFacts {
  return {
    baseRepository: "base/repo",
    number,
    id: `id-${number}`,
    url: `https://github.com/base/repo/pull/${number}`,
    title: `PR ${number}`,
    state,
    isDraft: false,
    headRepository,
    headRefName: "feature",
    headOid: "abc",
    baseRefName: "main",
    reviewDecision: null,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    isMergeQueueEnabled: false,
    isQueued: false,
    updatedAt: `2026-09-${number}`,
    checks: [],
    checksComplete: true,
    fetchedAt: 1,
    lastError: null,
  };
}

describe("association resolution", () => {
  test("uncertain head and two open PRs become candidates", () => {
    const entry = resolveWorkspacePr(
      [pr(1, "OPEN"), pr(2, "OPEN", "bob/repo")],
      "feature",
      null,
      null,
      1,
    );
    expect(entry.pr).toBeNull();
    expect(entry.candidates).toHaveLength(2);
  });
  test("known head selects the only matching open PR", () => {
    const entry = resolveWorkspacePr(
      [pr(1, "MERGED"), pr(2, "OPEN"), pr(3, "OPEN", "bob/repo")],
      "feature",
      { repository: "alice/repo", branch: "feature" },
      null,
      1,
    );
    expect(entry.pr?.number).toBe(2);
  });
  test("explicit terminal PR stays selected and points to newer open PR", () => {
    const entry = resolveWorkspacePr(
      [pr(1, "MERGED"), pr(2, "OPEN")],
      "feature",
      { repository: "alice/repo", branch: "feature" },
      { baseRepository: "base/repo", number: 1 },
      1,
    );
    expect(entry.pr?.number).toBe(1);
    expect(entry.newerOpenPr).toBe(2);
  });
});
