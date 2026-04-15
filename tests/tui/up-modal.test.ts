import { describe, expect, test } from "vitest";
import type { ListItem } from "../../src/tui/components/ScrollableList";
import { resolveUpModalSubmission } from "../../src/tui/components/UpModal";

const profileItems: ListItem[] = [
  { label: "(default)", value: "" },
  { label: "backend", value: "backend" },
];

describe("resolveUpModalSubmission", () => {
  test("allows submit without a profile when none are configured", () => {
    expect(resolveUpModalSubmission([], [], 0)).toEqual({
      canSubmit: true,
    });
  });

  test("blocks submit when the profile filter has no matches", () => {
    expect(resolveUpModalSubmission(["backend"], [], 0)).toEqual({
      canSubmit: false,
    });
  });

  test("maps the default profile option to an omitted --profile flag", () => {
    expect(resolveUpModalSubmission(["backend"], profileItems, 0)).toEqual({
      canSubmit: true,
      profile: undefined,
    });
  });

  test("returns the selected named profile when one is highlighted", () => {
    expect(resolveUpModalSubmission(["backend"], profileItems, 1)).toEqual({
      canSubmit: true,
      profile: "backend",
    });
  });
});
