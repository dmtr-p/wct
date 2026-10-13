import { Text } from "ink";
import { describe, expect, test } from "vitest";
import { useFieldFocus } from "../../src/tui/hooks/useFieldFocus";
import { renderWithInput, tick } from "./keypress-harness";

type Field = "branch" | "profile" | "autoSwitch" | "submit";
const withoutProfile: Field[] = ["branch", "autoSwitch", "submit"];
const withProfile: Field[] = ["branch", "profile", "autoSwitch", "submit"];

async function renderFocus(fields: Field[]) {
  let focus: ReturnType<typeof useFieldFocus<Field>>;
  function Probe({
    fields,
    resetKey,
  }: {
    fields: Field[];
    resetKey?: boolean;
  }) {
    focus = useFieldFocus(fields, resetKey);
    return <Text>{focus.currentField ?? "none"}</Text>;
  }
  const view = await renderWithInput(<Probe fields={fields} />);
  return {
    ...view,
    current: () => focus.currentField,
    async select(field: Field) {
      focus.focusField(field);
      await tick(2);
    },
    async move(direction: -1 | 1) {
      focus.moveFocus(direction);
      await tick(2);
    },
    update: (fields: Field[], resetKey?: boolean) =>
      view.rerender(<Probe fields={fields} resetKey={resetKey} />),
  };
}

describe("useFieldFocus", () => {
  test.each([{ fields: withoutProfile }, { fields: withProfile }])(
    "cycles forward and backward through available fields $fields",
    async ({ fields }) => {
      const view = await renderFocus(fields);
      try {
        expect(view.current()).toBe(fields[0]);
        for (const field of [...fields.slice(1), fields[0]]) {
          await view.move(1);
          expect(view.current()).toBe(field);
        }
        for (const field of [...fields.slice(1).reverse(), fields[0]]) {
          await view.move(-1);
          expect(view.current()).toBe(field);
        }
      } finally {
        view.unmount();
      }
    },
  );

  test("preserves field identity through insertion, removal, and reordering", async () => {
    const view = await renderFocus(withoutProfile);
    try {
      await view.select("autoSwitch");
      await view.update(withProfile);
      expect(view.current()).toBe("autoSwitch");
      await view.move(-1);
      expect(view.current()).toBe("profile");
      await view.select("submit");
      await view.update(withoutProfile);
      expect(view.current()).toBe("submit");
      await view.update(["submit", "branch", "autoSwitch"]);
      expect(view.current()).toBe("submit");
      await view.move(1);
      expect(view.current()).toBe("branch");
    } finally {
      view.unmount();
    }
  });

  test("falls back to the same position, then the last field when necessary", async () => {
    const view = await renderFocus(withProfile);
    try {
      await view.select("profile");
      await view.update(withoutProfile);
      expect(view.current()).toBe("autoSwitch");
      await view.update(withProfile);
      expect(view.current()).toBe("autoSwitch");
      await view.select("submit");
      await view.update(["branch", "profile"]);
      expect(view.current()).toBe("profile");
    } finally {
      view.unmount();
    }
  });

  test("ignores unavailable field selections and handles empty fields", async () => {
    const view = await renderFocus(withoutProfile);
    try {
      await view.select("submit");
      await view.select("profile");
      expect(view.current()).toBe("submit");
      await view.update([]);
      expect(view.current()).toBeNull();
      await view.move(1);
      await view.move(-1);
      await view.select("branch");
      expect(view.current()).toBeNull();
      await view.update(withProfile);
      expect(view.current()).toBe("branch");
    } finally {
      view.unmount();
    }
  });

  test("equal field lists retain focus and reset keys return to the first field", async () => {
    const view = await renderFocus(withProfile);
    try {
      await view.select("submit");
      await view.update([...withProfile]);
      expect(view.current()).toBe("submit");
      await view.update(withProfile, true);
      expect(view.current()).toBe("branch");
      await view.select("autoSwitch");
      await view.update([...withProfile], true);
      expect(view.current()).toBe("autoSwitch");
      await view.update(withProfile, false);
      expect(view.current()).toBe("branch");
    } finally {
      view.unmount();
    }
  });
});
