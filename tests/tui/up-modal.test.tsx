import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import type { ListItem } from "../../src/tui/components/ScrollableList";
import type { SessionOptionsSectionProps } from "../../src/tui/components/SessionOptionsSection";
import {
  resolveSelectedProfileValue,
  resolveSessionOptionsSubmitState,
} from "../../src/tui/components/session-options";

const sessionOptionsSectionMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/tui/components/SessionOptionsSection", async () => {
  const React = await import("react");

  return {
    SessionOptionsSection: (props: SessionOptionsSectionProps) => {
      sessionOptionsSectionMock(props);

      React.useEffect(() => {
        props.onProfileChange("");
      }, [props.onProfileChange]);

      return null;
    },
  };
});

const { UpModal } = await import("../../src/tui/components/UpModal");

const profileItems: ListItem[] = [
  { label: "(default)", value: "" },
  { label: "backend", value: "backend" },
];

type TestStdout = NodeJS.WriteStream & { columns: number; rows: number };
type TestStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
};

function createStdoutStdin() {
  const stdout = new PassThrough() as unknown as TestStdout;
  stdout.columns = 100;
  stdout.rows = 32;
  const stdin = new PassThrough() as unknown as TestStdin;
  stdin.isTTY = false;
  stdin.setRawMode = () => stdin;
  return { stdout, stdin };
}

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

describe("UpModal", () => {
  test("initially enables submit with the default profile when profiles exist", async () => {
    sessionOptionsSectionMock.mockReset();
    const { render } = await import("ink");
    const { stdout, stdin } = createStdoutStdin();

    let instance: ReturnType<typeof render> | undefined;
    try {
      instance = render(
        <UpModal
          visible
          profileNames={["backend"]}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
        {
          stdout,
          stdin,
          debug: true,
          patchConsole: false,
          exitOnCtrlC: false,
        },
      );

      await vi.waitFor(() => {
        const call = sessionOptionsSectionMock.mock.calls.find(
          ([props]) => (props as SessionOptionsSectionProps).canSubmit,
        );
        expect(call).toBeDefined();
        expect((call?.[0] as SessionOptionsSectionProps).focusedField).toBe(
          "profile",
        );
      });
    } finally {
      instance?.unmount();
    }
  });
});
