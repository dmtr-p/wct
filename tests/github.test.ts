import { describe, expect, test } from "bun:test";
import { parsePrArg } from "../src/services/github";

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
});
