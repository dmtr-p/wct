// Regression tests for the manual-testing bug where clicking the terminal
// while a modal text input was focused pasted raw SGR mouse escape text
// (`[<0;12;38M[<0;12;38m[<0;1;1m`) into the field.
//
// Delivery model (verified against ink/build/input-parser.js): Ink 7.1 splits
// every complete CSI sequence in a stdin chunk into its OWN useInput event
// and strips the leading ESC per event. The screenshot garble was therefore
// THREE per-sequence events (press, release, release) each appended in order
// by the unguarded modal handlers — the per-hook guard in useGuardedInput is
// the real fix, and it must live in the shared wrapper because Ink dispatches
// every event to ALL active useInput hooks, not only App.tsx's dispatcher.
// (The guard's multi-sequence regex additionally covers Ink's bracketed-paste
// fallback, the one path that can deliver a concatenated string.)
//
// These tests render the real modal components through the PassThrough-stdout
// harness and write the bug's sequences to stdin — as one chunk (which Ink
// splits into per-sequence events before dispatch) and individually.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const runPromiseMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/tui/runtime", () => ({
  tuiRuntime: {
    runPromise: runPromiseMock,
  },
  runTuiSilentPromise: (effect: unknown) => runPromiseMock(effect),
}));

vi.mock("../../src/tui/hooks/useBlink", () => ({
  useBlink: () => false,
}));

const { NewBranchForm } = await import("../../src/tui/components/OpenModal");
const { AddProjectModal } = await import(
  "../../src/tui/components/AddProjectModal"
);
const { CTRL_ENTER, renderWithInput, sendKeys } = await import(
  "./keypress-harness"
);

// The bug's press + release + release written as one stdin chunk. Ink's
// parser splits this into three per-sequence useInput events (one leading
// ESC stripped per event), so each event must be swallowed by the guard.
const BATCHED_CLICK = "[<0;12;38M\x1b[<0;12;38m\x1b[<0;1;1m";
const SINGLE_PRESS = "\x1b[<0;12;38M";
const SINGLE_RELEASE = "\x1b[<0;12;38m";
const click = (col: number, row: number) => `\x1b[<0;${col};${row}M`;

function renderNewBranchForm(onSubmit: (result: unknown) => void) {
  return renderWithInput(
    <NewBranchForm
      defaultBase="main"
      profileNames={["default"]}
      onSubmit={onSubmit}
      onBack={() => {}}
      width={80}
    />,
  );
}

describe("modal text inputs never consume mouse sequences as text", () => {
  const originalConsoleError = console.error;
  const suppressedPattern =
    /Encountered two children with the same key|Raw mode is not supported/;

  beforeEach(() => {
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === "string" && suppressedPattern.test(args[0]))
        return;
      originalConsoleError(...args);
    };
  });

  afterEach(() => {
    console.error = originalConsoleError;
    vi.clearAllMocks();
    runPromiseMock.mockReset();
  });

  test("OpenModal Branch input: a batched click chunk inserts nothing (screenshot bug)", async () => {
    const onSubmitMock = vi.fn();
    const rendered = await renderNewBranchForm(onSubmitMock);

    try {
      await sendKeys(rendered.stdin, "feature-x");
      await sendKeys(rendered.stdin, BATCHED_CLICK);
      await sendKeys(rendered.stdin, SINGLE_PRESS);
      await sendKeys(rendered.stdin, SINGLE_RELEASE);
      await sendKeys(rendered.stdin, CTRL_ENTER);

      expect(onSubmitMock).toHaveBeenCalledTimes(1);
      expect(onSubmitMock).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "feature-x" }),
      );
      // The rendered frame must never show the escape garble either.
      expect(rendered.output()).not.toContain("[<0;");
    } finally {
      rendered.unmount();
    }
  });

  test("OpenModal Branch input: a click on an empty field leaves it empty (submit stays blocked)", async () => {
    const onSubmitMock = vi.fn();
    const rendered = await renderNewBranchForm(onSubmitMock);

    try {
      await sendKeys(rendered.stdin, BATCHED_CLICK);
      // doSubmit is a no-op while branch is empty — if the chunk had been
      // pasted into the field, this Ctrl+Enter would submit the garble.
      await sendKeys(rendered.stdin, CTRL_ENTER);

      expect(onSubmitMock).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
    }
  });

  test("AddProjectModal PathInput: a batched click chunk does not corrupt the path", async () => {
    runPromiseMock.mockResolvedValue(true); // git-repo check passes; completions fail harmlessly
    const onSubmitMock = vi.fn();
    const rendered = await renderWithInput(
      <AddProjectModal
        visible
        width={60}
        onSubmit={onSubmitMock}
        onCancel={() => {}}
      />,
    );

    try {
      await new Promise((r) => setTimeout(r, 150)); // past the git-check debounce
      await sendKeys(rendered.stdin, BATCHED_CLICK);
      await sendKeys(rendered.stdin, CTRL_ENTER);

      expect(onSubmitMock).toHaveBeenCalledTimes(1);
      const result = onSubmitMock.mock.calls[0]?.[0] as { path: string };
      expect(result.path).toBe(process.env.HOME ?? "/tmp");
      expect(result.path).not.toContain("[<");
    } finally {
      rendered.unmount();
    }
  });
});

describe("modal mouse controls", () => {
  afterEach(() => {
    vi.clearAllMocks();
    runPromiseMock.mockReset();
  });

  test("clicking an unfocused input focuses it before typing", async () => {
    const onSubmitMock = vi.fn();
    const rendered = await renderNewBranchForm(onSubmitMock);

    try {
      await sendKeys(rendered.stdin, "feature-x");
      // NewBranchForm's Base input content is rendered on row 7.
      await sendKeys(rendered.stdin, click(5, 7));
      await sendKeys(rendered.stdin, "-next");
      await sendKeys(rendered.stdin, CTRL_ENTER);

      expect(onSubmitMock).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "feature-x", base: "main-next" }),
      );
    } finally {
      rendered.unmount();
    }
  });

  test("clicking a visible profile option selects it", async () => {
    const onSubmitMock = vi.fn();
    const rendered = await renderNewBranchForm(onSubmitMock);

    try {
      await sendKeys(rendered.stdin, "feature-x");
      // Profile rows are 10=(default), 11=default profile.
      await sendKeys(rendered.stdin, click(5, 11));
      await sendKeys(rendered.stdin, CTRL_ENTER);

      expect(onSubmitMock).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "feature-x", profile: "default" }),
      );
    } finally {
      rendered.unmount();
    }
  });

  test("clicking the enabled Submit row submits", async () => {
    const onSubmitMock = vi.fn();
    const rendered = await renderNewBranchForm(onSubmitMock);

    try {
      await sendKeys(rendered.stdin, "feature-x");
      // The five-row profile box is followed by a spacer and Auto-switch.
      await sendKeys(rendered.stdin, click(5, 19));

      expect(onSubmitMock).toHaveBeenCalledTimes(1);
      expect(onSubmitMock).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "feature-x" }),
      );
    } finally {
      rendered.unmount();
    }
  });

  test("two Submit presses delivered together submit only once", async () => {
    const onSubmitMock = vi.fn();
    const rendered = await renderNewBranchForm(onSubmitMock);

    try {
      await sendKeys(rendered.stdin, "feature-x");
      const submitClick = click(5, 19);
      await sendKeys(rendered.stdin, `${submitClick}${submitClick}`);

      expect(onSubmitMock).toHaveBeenCalledTimes(1);
    } finally {
      rendered.unmount();
    }
  });

  test("the blank spacer above the session controls is not clickable", async () => {
    const onSubmitMock = vi.fn();
    const rendered = await renderNewBranchForm(onSubmitMock);

    try {
      await sendKeys(rendered.stdin, "feature-x");
      await sendKeys(rendered.stdin, click(5, 17));

      expect(onSubmitMock).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
    }
  });

  test("clicking the disabled Submit row does not submit", async () => {
    const onSubmitMock = vi.fn();
    const rendered = await renderNewBranchForm(onSubmitMock);

    try {
      await sendKeys(rendered.stdin, click(5, 19));
      expect(onSubmitMock).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
    }
  });
});
