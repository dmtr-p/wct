import { describe, expect, test } from "vitest";
import type { ListItem } from "../../src/tui/components/ScrollableList";
import {
  buildProfileItems,
  getInitialSelectedProfileValue,
  isFilterInputCharacter,
  resolveSelectedProfileValue,
  resolveSessionOptionsSubmitState,
} from "../../src/tui/components/session-options";

const profileItems: ListItem[] = [
  { label: "(default)", value: "" },
  { label: "backend", value: "backend" },
];

describe("buildProfileItems", () => {
  test("prepends the default option", () => {
    expect(buildProfileItems(["backend"])).toEqual(profileItems);
  });
});

describe("getInitialSelectedProfileValue", () => {
  test("defaults to the raw default-profile option when profiles exist", () => {
    expect(getInitialSelectedProfileValue(["backend"])).toBe("");
  });

  test("stays undefined when no profiles are configured", () => {
    expect(getInitialSelectedProfileValue([])).toBeUndefined();
  });
});

describe("isFilterInputCharacter", () => {
  test("ignores tab input so focus navigation does not corrupt the filter", () => {
    expect(
      isFilterInputCharacter("\t", {
        tab: true,
        ctrl: false,
        meta: false,
        return: false,
      }),
    ).toBe(false);
  });

  test("accepts regular printable characters", () => {
    expect(
      isFilterInputCharacter("a", {
        tab: false,
        ctrl: false,
        meta: false,
        return: false,
      }),
    ).toBe(true);
  });
});

describe("resolveSelectedProfileValue", () => {
  test("returns undefined when profiles are configured but the filter has no matches", () => {
    expect(resolveSelectedProfileValue(["backend"], [], 0)).toBeUndefined();
  });

  test("returns an empty string for the default option", () => {
    expect(resolveSelectedProfileValue(["backend"], profileItems, 0)).toBe("");
  });

  test("returns the selected configured profile name", () => {
    expect(resolveSelectedProfileValue(["backend"], profileItems, 1)).toBe(
      "backend",
    );
  });
});

describe("resolveSessionOptionsSubmitState", () => {
  test("allows submit when no profiles are configured", () => {
    expect(resolveSessionOptionsSubmitState([], undefined)).toEqual({
      canSubmit: true,
      profile: undefined,
    });
  });

  test("blocks submit when profiles exist but no option is selected", () => {
    expect(resolveSessionOptionsSubmitState(["backend"], undefined)).toEqual({
      canSubmit: false,
      profile: undefined,
    });
  });

  test("maps the default raw value to an omitted profile at submit time", () => {
    expect(resolveSessionOptionsSubmitState(["backend"], "")).toEqual({
      canSubmit: true,
      profile: undefined,
    });
  });

  test("passes through a named profile at submit time", () => {
    expect(resolveSessionOptionsSubmitState(["backend"], "backend")).toEqual({
      canSubmit: true,
      profile: "backend",
    });
  });
});
