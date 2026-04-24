import { PassThrough } from "node:stream";
import { render } from "ink";
import { describe, expect, test } from "vitest";
import type { ListItem } from "../../src/tui/components/ScrollableList";
import {
  resolveSelectedProfileValue,
  resolveSessionOptionsSubmitState,
} from "../../src/tui/components/session-options";
import { UpModal } from "../../src/tui/components/UpModal";

const profileItems: ListItem[] = [
  { label: "(default)", value: "" },
  { label: "backend", value: "backend" },
];

describe("session-options submission semantics", () => {
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

function createStreams() {
  const stdout = new PassThrough() as NodeJS.WriteStream & {
    columns: number;
    rows: number;
  };
  stdout.columns = 100;
  stdout.rows = 32;
  const stdin = new PassThrough() as NodeJS.ReadStream & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => NodeJS.ReadStream;
  };
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  return { stdout, stdin };
}

test("renders the shared Auto-switch wording", async () => {
  const { stdout, stdin } = createStreams();
  const instance = render(
    <UpModal
      visible
      profileNames={["backend"]}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
    { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  const output = stdout.read()?.toString("utf8") ?? "";

  try {
    expect(output).toContain("Auto-switch");
    expect(output).not.toContain("No attach");
  } finally {
    instance.unmount();
  }
});
