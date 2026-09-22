import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";

// Force the regular blink phase off so movement visibility must come from
// the editing hold, not from a conveniently visible animation frame.
vi.mock("../../src/tui/hooks/useBlink", () => ({ useBlink: () => false }));

const { FromPRForm, NewBranchForm } = await import(
  "../../src/tui/components/OpenModal"
);
const { PathInput } = await import("../../src/tui/components/PathInput");
const { CTRL_ENTER, renderWithInput, sendKeys, TAB } = await import(
  "./keypress-harness"
);

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const HOME = "\x1b[H";
const END = "\x1b[F";
const DELETE = "\x1b[3~";
const DOWN = "\x1b[B";

function renderBranch(onSubmit: (result: unknown) => void) {
  return renderWithInput(
    <NewBranchForm
      defaultBase="main"
      profileNames={[]}
      onSubmit={onSubmit}
      onBack={() => {}}
      width={28}
    />,
  );
}

function PathFixture({
  initialValue = "~/test",
  onChange,
}: {
  initialValue?: string;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <PathInput
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      isFocused
      isGitRepo={false}
      width={28}
    />
  );
}

describe("cursor editing through Ink stdin", () => {
  test("a character in the same stdin chunk as path completion extends the completed path", async () => {
    const root = mkdtempSync(join(tmpdir(), "wct-cursor-"));
    mkdirSync(join(root, "completed"));
    const onChange = vi.fn();
    const view = await renderWithInput(
      <PathFixture initialValue={`${root}/comp`} onChange={onChange} />,
    );
    try {
      await vi.waitFor(() => {
        expect(view.lastFrame()).toContain("completed/");
      });
      await sendKeys(view.stdin, `${RIGHT}x`);
      expect(onChange).toHaveBeenLastCalledWith(`${root}/completed/x`);
    } finally {
      view.unmount();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("moving left within a path does not insert a blank column", async () => {
    const view = await renderWithInput(<PathFixture />);
    try {
      await sendKeys(view.stdin, LEFT);
      expect(view.lastFrame()).toContain("~/test");
      expect(view.lastFrame()).not.toContain("~/tes▎t");
      expect(view.lastFrame()).not.toContain("~/tes t");
      await sendKeys(view.stdin, RIGHT);
      expect(view.lastFrame()).toContain("~/test▎");
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(view.lastFrame()).not.toContain("~/test▎");
    } finally {
      view.unmount();
    }
  });

  test("Ghostty Command+Right moves to the end without accepting a path completion", async () => {
    const view = await renderWithInput(<PathFixture />);
    try {
      await sendKeys(view.stdin, LEFT);
      await sendKeys(view.stdin, "\x05"); // Ghostty's default Command+Right (Ctrl+E)
      await sendKeys(view.stdin, "x");
      expect(view.lastFrame()).toContain("~/testx");
      expect(view.lastFrame()).not.toContain("~/tesxt");
    } finally {
      view.unmount();
    }
  });

  test("Ghostty Command+Backspace deletes from the cursor to the start", async () => {
    const view = await renderWithInput(<PathFixture />);
    try {
      await sendKeys(view.stdin, LEFT);
      await sendKeys(view.stdin, LEFT);
      await sendKeys(view.stdin, "\x15"); // Ghostty's default Command+Backspace (Ctrl+U)
      await sendKeys(view.stdin, "x");
      expect(view.lastFrame()).toContain("xst");
      expect(view.lastFrame()).not.toContain("~/texst");
    } finally {
      view.unmount();
    }
  });

  test("Kitty super+Backspace deletes to the start of the field", async () => {
    const submit = vi.fn();
    const view = await renderBranch(submit);
    try {
      await sendKeys(view.stdin, "abcdef");
      await sendKeys(view.stdin, LEFT);
      await sendKeys(view.stdin, LEFT);
      await sendKeys(view.stdin, "\x1b[127;9u");
      await sendKeys(view.stdin, CTRL_ENTER);
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "ef" }),
      );
    } finally {
      view.unmount();
    }
  });

  test("branch edits in the middle and base edits from Home preserve submission", async () => {
    const submit = vi.fn();
    const view = await renderBranch(submit);
    try {
      await sendKeys(view.stdin, "axc");
      await sendKeys(view.stdin, LEFT);
      // The insertion point must not add a printable column in the value.
      expect(view.lastFrame()).toContain("axc");
      expect(view.lastFrame()).not.toContain("ax▎c");
      expect(view.lastFrame()).not.toContain("ax c");
      await sendKeys(view.stdin, "b");
      await sendKeys(view.stdin, LEFT);
      await sendKeys(view.stdin, DELETE);
      await sendKeys(view.stdin, RIGHT);
      await sendKeys(view.stdin, END);
      await sendKeys(view.stdin, TAB);
      await sendKeys(view.stdin, HOME);
      await sendKeys(view.stdin, "origin/");
      await sendKeys(view.stdin, CTRL_ENTER);
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: "axc",
          base: "origin/main",
        }),
      );
    } finally {
      view.unmount();
    }
  });

  test("bracketed multiline paste inserts at the cursor without submitting", async () => {
    const submit = vi.fn();
    const view = await renderBranch(submit);
    try {
      await sendKeys(view.stdin, "ac");
      await sendKeys(view.stdin, LEFT);
      await sendKeys(view.stdin, "\x1b[200~b\r\nc\nd\re\x1b[201~");
      expect(submit).not.toHaveBeenCalled();
      await sendKeys(view.stdin, CTRL_ENTER);
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: "ab c d ec",
        }),
      );
    } finally {
      view.unmount();
    }
  });

  test("arrow and Backspace treat an emoji as one grapheme", async () => {
    const submit = vi.fn();
    const view = await renderBranch(submit);
    try {
      await sendKeys(view.stdin, "a🙂c");
      await sendKeys(view.stdin, LEFT);
      await sendKeys(view.stdin, "\x7f");
      await sendKeys(view.stdin, CTRL_ENTER);
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "ac" }),
      );
    } finally {
      view.unmount();
    }
  });

  test("moving the PR filter cursor keeps the selected result", async () => {
    const submit = vi.fn();
    const view = await renderWithInput(
      <FromPRForm
        prList={[
          {
            number: 1,
            title: "First",
            state: "OPEN",
            headRefName: "feat-one",
            rollupState: null,
          },
          {
            number: 2,
            title: "Second",
            state: "OPEN",
            headRefName: "feat-two",
            rollupState: null,
          },
        ]}
        profileNames={[]}
        isRefreshing={false}
        onRefresh={() => {}}
        onSubmit={submit}
        onBack={() => {}}
        width={40}
      />,
    );
    try {
      await sendKeys(view.stdin, "feat");
      await sendKeys(view.stdin, DOWN);
      await sendKeys(view.stdin, LEFT);
      await sendKeys(view.stdin, RIGHT);
      await sendKeys(view.stdin, CTRL_ENTER);
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ pr: "2" }));
    } finally {
      view.unmount();
    }
  });
});
