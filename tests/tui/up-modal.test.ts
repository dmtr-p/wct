import { describe, expect, test } from "vitest";
import type { ListItem } from "../../src/tui/components/ScrollableList";
import {
  resolveSelectedProfileValue,
  resolveSessionOptionsSubmitState,
} from "../../src/tui/components/session-options";

const profileItems: ListItem[] = [
  { label: "(default)", value: "" },
  { label: "backend", value: "backend" },
];

describe("UpModal submission semantics", () => {
  test("allows submit without a profile when none are configured", () => {
    const selectedProfileValue = resolveSelectedProfileValue([], [], 0);

    expect(resolveSessionOptionsSubmitState([], selectedProfileValue)).toEqual({
      canSubmit: true,
      profile: undefined,
    });
  });

  test("blocks submit when the profile filter has no matches", () => {
    const selectedProfileValue = resolveSelectedProfileValue(
      ["backend"],
      [],
      0,
    );

    expect(
      resolveSessionOptionsSubmitState(["backend"], selectedProfileValue),
    ).toEqual({
      canSubmit: false,
      profile: undefined,
    });
  });

  test("maps the default profile option to an omitted --profile flag", () => {
    const selectedProfileValue = resolveSelectedProfileValue(
      ["backend"],
      profileItems,
      0,
    );

    expect(
      resolveSessionOptionsSubmitState(["backend"], selectedProfileValue),
    ).toEqual({
      canSubmit: true,
      profile: undefined,
    });
  });

  test("returns the selected named profile when one is highlighted", () => {
    const selectedProfileValue = resolveSelectedProfileValue(
      ["backend"],
      profileItems,
      1,
    );

    expect(
      resolveSessionOptionsSubmitState(["backend"], selectedProfileValue),
    ).toEqual({
      canSubmit: true,
      profile: "backend",
    });
  });
});
