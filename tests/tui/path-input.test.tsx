import { describe, expect, test, vi } from "vitest";
import { expandTilde, getParentAndPrefix } from "../../src/tui/components/PathInput";

describe("getParentAndPrefix", () => {
  test("splits /Users/dmtr/co into parent=/Users/dmtr/ prefix=co", () => {
    expect(getParentAndPrefix("/Users/dmtr/co")).toEqual({
      parent: "/Users/dmtr/",
      prefix: "co",
    });
  });

  test("splits /Users/dmtr/ into parent=/Users/dmtr/ prefix=empty", () => {
    expect(getParentAndPrefix("/Users/dmtr/")).toEqual({
      parent: "/Users/dmtr/",
      prefix: "",
    });
  });

  test("splits / into parent=/ prefix=empty", () => {
    expect(getParentAndPrefix("/")).toEqual({
      parent: "/",
      prefix: "",
    });
  });

  test("empty string returns parent=/ prefix=empty", () => {
    expect(getParentAndPrefix("")).toEqual({
      parent: "/",
      prefix: "",
    });
  });
});

describe("expandTilde", () => {
  test("expands ~ at start to HOME", () => {
    const home = process.env.HOME ?? "/tmp";
    expect(expandTilde("~/code")).toBe(`${home}/code`);
  });

  test("does not expand ~ in middle", () => {
    expect(expandTilde("/foo/~bar")).toBe("/foo/~bar");
  });

  test("returns path unchanged if no tilde", () => {
    expect(expandTilde("/usr/local")).toBe("/usr/local");
  });
});
