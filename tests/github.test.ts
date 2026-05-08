import { describe, expect, test } from "vitest";
import {
  computeRollup,
  findMatchingRemote,
  parseGhPrList,
  parsePrArg,
  parseRemoteOwnerRepo,
} from "../src/services/github-service";

describe("GitHub PR resolution", () => {
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

describe("computeRollup", () => {
  test("returns null for empty array", () => {
    expect(computeRollup([])).toBeNull();
  });

  test("returns success for all SUCCESS entries", () => {
    expect(computeRollup([{ state: "SUCCESS" }, { state: "SUCCESS" }])).toBe(
      "success",
    );
  });

  test("returns success when mix includes SKIPPED, NEUTRAL, CANCELLED", () => {
    expect(
      computeRollup([
        { state: "SUCCESS" },
        { state: "SKIPPED" },
        { state: "NEUTRAL" },
        { state: "CANCELLED" },
      ]),
    ).toBe("success");
  });

  test("returns failure for any FAILURE entry", () => {
    expect(computeRollup([{ state: "SUCCESS" }, { state: "FAILURE" }])).toBe(
      "failure",
    );
  });

  test("returns failure for TIMED_OUT", () => {
    expect(computeRollup([{ state: "TIMED_OUT" }])).toBe("failure");
  });

  test("returns failure for STARTUP_FAILURE", () => {
    expect(computeRollup([{ state: "STARTUP_FAILURE" }])).toBe("failure");
  });

  test("returns pending for any IN_PROGRESS entry (no failures)", () => {
    expect(
      computeRollup([{ state: "SUCCESS" }, { state: "IN_PROGRESS" }]),
    ).toBe("pending");
  });

  test("returns pending for QUEUED", () => {
    expect(computeRollup([{ state: "QUEUED" }])).toBe("pending");
  });

  test("returns pending for PENDING", () => {
    expect(computeRollup([{ state: "PENDING" }])).toBe("pending");
  });

  test("returns pending for ACTION_REQUIRED", () => {
    expect(computeRollup([{ state: "ACTION_REQUIRED" }])).toBe("pending");
  });

  test("failure dominates pending", () => {
    expect(
      computeRollup([{ state: "IN_PROGRESS" }, { state: "FAILURE" }]),
    ).toBe("failure");
  });

  test("handles check-run-style entries with conclusion", () => {
    expect(
      computeRollup([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "FAILURE" },
      ]),
    ).toBe("failure");
  });

  test("handles check-run-style IN_PROGRESS (conclusion null)", () => {
    expect(
      computeRollup([
        { status: "IN_PROGRESS", conclusion: null },
        { status: "COMPLETED", conclusion: "SUCCESS" },
      ]),
    ).toBe("pending");
  });

  test("in-flight re-run: stale conclusion ignored when status is IN_PROGRESS", () => {
    expect(
      computeRollup([{ status: "IN_PROGRESS", conclusion: "SUCCESS" }]),
    ).toBe("pending");
  });

  test("completed check-run with FAILURE conclusion returns failure", () => {
    expect(
      computeRollup([{ status: "COMPLETED", conclusion: "FAILURE" }]),
    ).toBe("failure");
  });

  test("handles mix of status-style and check-run-style entries", () => {
    expect(
      computeRollup([
        { state: "SUCCESS" },
        { status: "COMPLETED", conclusion: "SKIPPED" },
        { status: "IN_PROGRESS", conclusion: null },
      ]),
    ).toBe("pending");
  });

  test("unknown state strings do not throw and produce success when alone", () => {
    expect(() => computeRollup([{ state: "FUTURE_STATE_42" }])).not.toThrow();
    expect(computeRollup([{ state: "FUTURE_STATE_42" }])).toBe("success");
  });

  test("unknown state does not override a known failure", () => {
    expect(
      computeRollup([{ state: "FUTURE_STATE" }, { state: "FAILURE" }]),
    ).toBe("failure");
  });

  test("non-object entries are safely ignored", () => {
    expect(computeRollup([null, undefined, "string", 42])).toBe("success");
  });
});

describe("parseGhPrList with statusCheckRollup", () => {
  test("parses statusCheckRollup and sets rollupState correctly", () => {
    const json = JSON.stringify([
      {
        number: 1,
        title: "all success",
        state: "OPEN",
        headRefName: "feat/a",
        statusCheckRollup: [{ state: "SUCCESS" }, { state: "SUCCESS" }],
      },
      {
        number: 2,
        title: "has failure",
        state: "OPEN",
        headRefName: "feat/b",
        statusCheckRollup: [{ state: "SUCCESS" }, { state: "FAILURE" }],
      },
      {
        number: 3,
        title: "in progress",
        state: "OPEN",
        headRefName: "feat/c",
        statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }],
      },
      {
        number: 4,
        title: "no checks",
        state: "OPEN",
        headRefName: "feat/d",
        statusCheckRollup: [],
      },
    ]);
    const result = parseGhPrList(json);
    expect(result).toHaveLength(4);
    expect(result[0]?.rollupState).toBe("success");
    expect(result[1]?.rollupState).toBe("failure");
    expect(result[2]?.rollupState).toBe("pending");
    expect(result[3]?.rollupState).toBeNull();
  });

  test("malformed rollup (non-array) produces rollupState null without throwing", () => {
    const json = JSON.stringify([
      {
        number: 5,
        title: "bad rollup",
        state: "OPEN",
        headRefName: "feat/e",
        statusCheckRollup: "not-an-array",
      },
    ]);
    expect(() => parseGhPrList(json)).not.toThrow();
    const result = parseGhPrList(json);
    expect(result[0]?.rollupState).toBeNull();
  });

  test("missing statusCheckRollup field produces rollupState null", () => {
    const json = JSON.stringify([
      {
        number: 6,
        title: "no rollup field",
        state: "OPEN",
        headRefName: "feat/f",
      },
    ]);
    const result = parseGhPrList(json);
    expect(result[0]?.rollupState).toBeNull();
  });

  test("existing fixtures without statusCheckRollup still parse and produce rollupState null", () => {
    const json = JSON.stringify([
      {
        number: 34,
        title: "feat: TUI sidebar",
        state: "OPEN",
        headRefName: "feat/tui",
      },
      {
        number: 31,
        title: "fix: migration",
        state: "MERGED",
        headRefName: "fix/migrate",
      },
    ]);
    const result = parseGhPrList(json);
    expect(result).toHaveLength(2);
    expect(result[0]?.rollupState).toBeNull();
    expect(result[1]?.rollupState).toBeNull();
  });
});
