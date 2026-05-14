import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement, useEffect } from "react";
import { describe, expect, test } from "vitest";
import type { ListItem } from "../../src/tui/components/ScrollableList";
import {
  buildProfileItems,
  clampSelectedProfileIndex,
  getInitialSelectedProfileValue,
  getNextSelectedProfileIndex,
  isFilterInputCharacter,
  resolveSelectedProfileValue,
  resolveSessionOptionsSubmitState,
} from "../../src/tui/components/session-options";
import {
  resolveNoIdeDefault,
  type SessionIdeDefaults,
  type SessionOptionsState,
  useSessionOptionsState,
} from "../../src/tui/hooks/useSessionOptionsState";

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

describe("clampSelectedProfileIndex", () => {
  test("keeps the selection at zero when the filtered list is empty", () => {
    expect(clampSelectedProfileIndex(1, 0)).toBe(0);
    expect(clampSelectedProfileIndex(-1, 0)).toBe(0);
  });

  test("clamps negative and oversized indices to the available range", () => {
    expect(clampSelectedProfileIndex(-1, 2)).toBe(0);
    expect(clampSelectedProfileIndex(5, 2)).toBe(1);
  });
});

describe("getNextSelectedProfileIndex", () => {
  test("does not move below zero when pressing up", () => {
    expect(getNextSelectedProfileIndex(0, 2, "up")).toBe(0);
  });

  test("does not move to a negative index when pressing down with no matches", () => {
    expect(getNextSelectedProfileIndex(0, 0, "down")).toBe(0);
  });

  test("recovers a valid selection after filtering to zero matches and back", () => {
    const hiddenSelection = getNextSelectedProfileIndex(0, 0, "down");
    expect(hiddenSelection).toBe(0);
    expect(
      clampSelectedProfileIndex(hiddenSelection, profileItems.length),
    ).toBe(0);
    expect(resolveSelectedProfileValue(["backend"], profileItems, 0)).toBe("");
  });
});

describe("resolveNoIdeDefault", () => {
  test("uses the base default when no profile is selected", () => {
    expect(
      resolveNoIdeDefault({
        selectedProfileValue: undefined,
        baseNoIde: true,
        profileNoIde: { backend: false },
      }),
    ).toBe(true);
  });

  test("uses the base default for the raw default-profile option", () => {
    expect(
      resolveNoIdeDefault({
        selectedProfileValue: "",
        baseNoIde: false,
        profileNoIde: { backend: true },
      }),
    ).toBe(false);
  });

  test("uses a selected profile override when configured", () => {
    expect(
      resolveNoIdeDefault({
        selectedProfileValue: "backend",
        baseNoIde: true,
        profileNoIde: { backend: false },
      }),
    ).toBe(false);
  });

  test("falls back to the base default when a selected profile has no override", () => {
    expect(
      resolveNoIdeDefault({
        selectedProfileValue: "frontend",
        baseNoIde: true,
        profileNoIde: { backend: false },
      }),
    ).toBe(true);
  });
});

describe("useSessionOptionsState", () => {
  test("preserves a manual No IDE toggle across equivalent defaults", async () => {
    let latest: SessionOptionsState | undefined;
    const { stdout, stdin } = createStdoutStdin();
    const instance = render(
      createElement(SessionOptionsProbe, {
        profileNames: [],
        ideDefaults: { baseNoIde: true, profileNoIde: {} },
        onState: (state) => {
          latest = state;
        },
      }),
      {
        stdout,
        stdin,
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );

    try {
      await viWaitFor(() => {
        expect(latest?.noIde).toBe(true);
      });

      latest?.setNoIde(false);

      await viWaitFor(() => {
        expect(latest?.noIde).toBe(false);
      });

      instance.rerender(
        createElement(SessionOptionsProbe, {
          profileNames: [],
          ideDefaults: { baseNoIde: true, profileNoIde: {} },
          onState: (state) => {
            latest = state;
          },
        }),
      );

      await viWaitFor(() => {
        expect(latest?.noIde).toBe(false);
      });
    } finally {
      instance.unmount();
    }
  });

  test("applies profile-specific No IDE default when profile selection changes", async () => {
    let latest: SessionOptionsState | undefined;
    const { stdout, stdin } = createStdoutStdin();
    const instance = render(
      createElement(SessionOptionsProbe, {
        profileNames: ["backend"],
        ideDefaults: { baseNoIde: false, profileNoIde: { backend: true } },
        onState: (state) => {
          latest = state;
        },
      }),
      {
        stdout,
        stdin,
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );

    try {
      await viWaitFor(() => {
        expect(latest?.noIde).toBe(false);
      });

      latest?.setSelectedProfileValue("backend");

      await viWaitFor(() => {
        expect(latest?.noIde).toBe(true);
      });
    } finally {
      instance.unmount();
    }
  });
});

function SessionOptionsProbe({
  profileNames,
  ideDefaults,
  onState,
}: {
  profileNames: string[];
  ideDefaults: SessionIdeDefaults;
  onState: (state: SessionOptionsState) => void;
}) {
  const state = useSessionOptionsState(profileNames, true, ideDefaults);
  useEffect(() => {
    onState(state);
  }, [onState, state]);
  return null;
}

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

async function viWaitFor(assertion: () => void): Promise<void> {
  const { vi } = await import("vitest");
  await vi.waitFor(assertion);
}
