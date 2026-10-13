import { afterEach, describe, expect, test, vi } from "vitest";
import type { SessionOptionsSectionProps } from "../../src/tui/components/SessionOptionsSection";
import {
  renderWithInput,
  sendKeys,
  SHIFT_TAB,
  TAB,
  tick,
} from "./keypress-harness";

const sectionMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/tui/components/SessionOptionsSection", () => ({
  SessionOptionsSection: (props: SessionOptionsSectionProps) => {
    sectionMock(props);
    return null;
  },
}));
vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: { runPromise: () => Promise.resolve(["main", "feature"]) },
}));

const { NewBranchForm, FromPRForm, ExistingBranchForm } =
  await import("../../src/tui/components/OpenModal");
const { UpModal } = await import("../../src/tui/components/UpModal");

function section() {
  return sectionMock.mock.lastCall?.[0] as SessionOptionsSectionProps;
}

const forms = [
  {
    name: "NewBranchForm",
    leadingFields: 2,
    render: (profileNames: string[]) => (
      <NewBranchForm
        defaultBase="main"
        profileNames={profileNames}
        onSubmit={() => {}}
        onBack={() => {}}
      />
    ),
  },
  {
    name: "FromPRForm",
    leadingFields: 1,
    render: (profileNames: string[]) => (
      <FromPRForm
        prList={[]}
        profileNames={profileNames}
        isRefreshing={false}
        onRefresh={() => {}}
        onSubmit={() => {}}
        onBack={() => {}}
      />
    ),
  },
  {
    name: "ExistingBranchForm",
    leadingFields: 1,
    render: (profileNames: string[]) => (
      <ExistingBranchForm
        repoPath="/repo"
        profileNames={profileNames}
        onSubmit={() => {}}
        onBack={() => {}}
      />
    ),
  },
  {
    name: "UpModal",
    leadingFields: 0,
    render: (profileNames: string[]) => (
      <UpModal
        visible
        profileNames={profileNames}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    ),
  },
];

afterEach(() => sectionMock.mockClear());

describe.each(forms)("$name field focus", ({ render, leadingFields }) => {
  test.each([{ profiles: [] }, { profiles: ["backend"] }])(
    "Tab and Shift+Tab wrap with profiles $profiles",
    async ({ profiles }) => {
      const view = await renderWithInput(render(profiles));
      try {
        const expected: SessionOptionsSectionProps["focusedField"][] = [
          ...Array<null>(leadingFields).fill(null),
          ...(profiles.length > 0 ? ["profile" as const] : []),
          "autoSwitch",
          "submit",
        ];
        expect(section().focusedField).toBe(expected[0]);
        for (const field of [...expected.slice(1), expected[0]]) {
          await sendKeys(view.stdin, TAB);
          expect(section().focusedField).toBe(field);
        }
        for (const field of [...expected.slice(1).reverse(), expected[0]]) {
          await sendKeys(view.stdin, SHIFT_TAB);
          expect(section().focusedField).toBe(field);
        }
      } finally {
        view.unmount();
      }
    },
  );

  test("mouse focus callbacks and profile changes retain valid field identity", async () => {
    const view = await renderWithInput(render([]));
    try {
      section().onFocusField("autoSwitch");
      await tick(2);
      expect(section().focusedField).toBe("autoSwitch");
      await view.rerender(render(["backend"]));
      expect(section().focusedField).toBe("autoSwitch");
      await sendKeys(view.stdin, SHIFT_TAB);
      expect(section().focusedField).toBe("profile");
      await view.rerender(render([]));
      expect(section().focusedField).toBe("autoSwitch");
      section().onFocusField("profile");
      await tick(2);
      expect(section().focusedField).toBe("autoSwitch");
      await sendKeys(view.stdin, TAB);
      expect(section().focusedField).toBe("submit");
      await view.rerender(render(["backend"]));
      expect(section().focusedField).toBe("submit");
      await view.rerender(render([]));
      expect(section().focusedField).toBe("submit");
    } finally {
      view.unmount();
    }
  });
});

test("UpModal resets focus when reopened", async () => {
  const render = (visible: boolean) => (
    <UpModal
      visible={visible}
      profileNames={["backend"]}
      onSubmit={() => {}}
      onCancel={() => {}}
    />
  );
  const view = await renderWithInput(render(true));
  try {
    await sendKeys(view.stdin, SHIFT_TAB);
    expect(section().focusedField).toBe("submit");
    await view.rerender(render(false));
    await view.rerender(render(true));
    expect(section().focusedField).toBe("profile");
  } finally {
    view.unmount();
  }
});
