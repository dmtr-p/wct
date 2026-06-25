import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PRInfo } from "../../src/tui/types";

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

const { NewBranchForm, FromPRForm, ExistingBranchForm } = await import(
  "../../src/tui/components/OpenModal"
);
const { UpModal } = await import("../../src/tui/components/UpModal");
const { AddProjectModal } = await import(
  "../../src/tui/components/AddProjectModal"
);
const { CTRL_ENTER, DOWN_ARROW, ENTER, TAB, renderWithInput, sendKeys, tick } =
  await import("./keypress-harness");

const defaultIdeDefaults = { baseNoIde: true, profileNoIde: {} };

function renderForm(onSubmit: () => void) {
  return renderWithInput(
    <NewBranchForm
      defaultBase="main"
      profileNames={["default"]}
      ideDefaults={defaultIdeDefaults}
      onSubmit={onSubmit}
      onBack={() => {}}
      width={80}
    />,
  );
}

const singlePR: PRInfo = {
  number: 123,
  title: "Feature",
  state: "OPEN",
  headRefName: "feature-from-pr",
  rollupState: null,
};

function renderFromPRForm(
  onSubmit: () => void,
  onRefresh: () => void = () => {},
  prList: PRInfo[] = [singlePR],
) {
  return renderWithInput(
    <FromPRForm
      prList={prList}
      profileNames={["default"]}
      ideDefaults={defaultIdeDefaults}
      isRefreshing={false}
      onRefresh={onRefresh}
      onSubmit={onSubmit}
      onBack={() => {}}
      width={80}
    />,
  );
}

function renderExistingBranchForm(onSubmit: () => void) {
  return renderWithInput(
    <ExistingBranchForm
      repoPath="/repo"
      profileNames={["default"]}
      ideDefaults={defaultIdeDefaults}
      onSubmit={onSubmit}
      onBack={() => {}}
      width={80}
    />,
  );
}

function renderUpModal(
  onSubmit: () => void,
  profileNames: string[] = ["default"],
) {
  return renderWithInput(
    <UpModal
      visible
      profileNames={profileNames}
      ideDefaults={defaultIdeDefaults}
      onSubmit={onSubmit}
      onCancel={() => {}}
    />,
  );
}

function renderAddProjectModal(onSubmit: () => void) {
  return renderWithInput(
    <AddProjectModal
      visible
      width={60}
      onSubmit={onSubmit}
      onCancel={() => {}}
    />,
  );
}

describe("Ctrl+Enter submit", () => {
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

  describe("NewBranchForm", () => {
    test("Ctrl+Enter from the Branch field fires onSubmit with the expected payload", async () => {
      const onSubmitMock = vi.fn();
      const rendered = await renderForm(onSubmitMock);

      try {
        await sendKeys(rendered.stdin, "feature-x");
        await sendKeys(rendered.stdin, CTRL_ENTER);

        expect(onSubmitMock).toHaveBeenCalledTimes(1);
        expect(onSubmitMock).toHaveBeenCalledWith(
          expect.objectContaining({
            branch: "feature-x",
            existing: false,
          }),
        );
      } finally {
        rendered.unmount();
      }
    });

    test("Ctrl+Enter while disabled (empty branch) is a silent no-op", async () => {
      const onSubmitMock = vi.fn();
      const rendered = await renderForm(onSubmitMock);

      try {
        await sendKeys(rendered.stdin, CTRL_ENTER);

        expect(onSubmitMock).not.toHaveBeenCalled();
      } finally {
        rendered.unmount();
      }
    });

    test("plain Enter while Branch field is focused does not submit and does not change branch", async () => {
      const onSubmitMock = vi.fn();
      const rendered = await renderForm(onSubmitMock);

      try {
        await sendKeys(rendered.stdin, "abc");
        await sendKeys(rendered.stdin, ENTER);
        await sendKeys(rendered.stdin, CTRL_ENTER);

        expect(onSubmitMock).toHaveBeenCalledTimes(1);
        expect(onSubmitMock).toHaveBeenCalledWith(
          expect.objectContaining({ branch: "abc" }),
        );
      } finally {
        rendered.unmount();
      }
    });

    test("Ctrl+Enter from the Prompt field submits without inserting a newline", async () => {
      const onSubmitMock = vi.fn();
      const rendered = await renderForm(onSubmitMock);

      try {
        await sendKeys(rendered.stdin, "feature-x");
        await sendKeys(rendered.stdin, TAB);
        await tick(2);
        await sendKeys(rendered.stdin, TAB);
        await tick(2);
        await sendKeys(rendered.stdin, "my prompt text");
        await sendKeys(rendered.stdin, CTRL_ENTER);

        expect(onSubmitMock).toHaveBeenCalledTimes(1);
        expect(onSubmitMock).toHaveBeenCalledWith(
          expect.objectContaining({
            branch: "feature-x",
            prompt: "my prompt text",
            existing: false,
          }),
        );
      } finally {
        rendered.unmount();
      }
    });

    test("Ctrl+Enter from the Submit field fires onSubmit exactly once (no double-fire)", async () => {
      const onSubmitMock = vi.fn();
      const rendered = await renderForm(onSubmitMock);

      try {
        await sendKeys(rendered.stdin, "feature-x");
        await sendKeys(rendered.stdin, TAB);
        await tick(2);
        await sendKeys(rendered.stdin, TAB);
        await tick(2);
        await sendKeys(rendered.stdin, TAB);
        await tick(2);
        await sendKeys(rendered.stdin, TAB);
        await tick(2);
        await sendKeys(rendered.stdin, TAB);
        await tick(2);
        await sendKeys(rendered.stdin, TAB);
        await tick(2);
        await sendKeys(rendered.stdin, CTRL_ENTER);

        expect(onSubmitMock).toHaveBeenCalledTimes(1);
        expect(onSubmitMock).toHaveBeenCalledWith(
          expect.objectContaining({
            branch: "feature-x",
            existing: false,
          }),
        );
      } finally {
        rendered.unmount();
      }
    });
  });

  describe("FromPRForm", () => {
    test("Ctrl+Enter with a PR selected fires onSubmit with that PR's payload", async () => {
      const onSubmitMock = vi.fn();
      const rendered = await renderFromPRForm(onSubmitMock);

      try {
        await sendKeys(rendered.stdin, CTRL_ENTER);

        expect(onSubmitMock).toHaveBeenCalledTimes(1);
        expect(onSubmitMock).toHaveBeenCalledWith(
          expect.objectContaining({
            branch: "feature-from-pr",
            pr: "123",
            existing: false,
          }),
        );
      } finally {
        rendered.unmount();
      }
    });

    test("Ctrl+Enter on the refresh row is a silent no-op", async () => {
      const onSubmitMock = vi.fn();
      const rendered = await renderFromPRForm(onSubmitMock);

      try {
        await sendKeys(rendered.stdin, DOWN_ARROW);
        await sendKeys(rendered.stdin, CTRL_ENTER);

        expect(onSubmitMock).not.toHaveBeenCalled();
      } finally {
        rendered.unmount();
      }
    });

    test("Ctrl+Enter with no PR selected (empty prList) is a silent no-op", async () => {
      const onSubmitMock = vi.fn();
      const rendered = await renderFromPRForm(onSubmitMock, () => {}, []);

      try {
        await sendKeys(rendered.stdin, CTRL_ENTER);

        expect(onSubmitMock).not.toHaveBeenCalled();
      } finally {
        rendered.unmount();
      }
    });

    test("plain Enter on the refresh row still triggers onRefresh", async () => {
      const onRefreshMock = vi.fn();
      const onSubmitMock = vi.fn();
      const rendered = await renderFromPRForm(onSubmitMock, onRefreshMock);

      try {
        await sendKeys(rendered.stdin, DOWN_ARROW);
        await sendKeys(rendered.stdin, ENTER);

        expect(onRefreshMock).toHaveBeenCalledTimes(1);
      } finally {
        rendered.unmount();
      }
    });
  });

  describe("ExistingBranchForm", () => {
    test("Ctrl+Enter with a branch selected fires onSubmit with that branch's payload", async () => {
      runPromiseMock.mockResolvedValueOnce(["feature-x"]);
      const onSubmitMock = vi.fn();
      const rendered = await renderExistingBranchForm(onSubmitMock);

      try {
        await tick(5);

        expect(runPromiseMock).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => {
          expect(rendered.output()).toContain("feature-x");
        });

        await sendKeys(rendered.stdin, CTRL_ENTER);

        expect(onSubmitMock).toHaveBeenCalledTimes(1);
        expect(onSubmitMock).toHaveBeenCalledWith(
          expect.objectContaining({
            branch: "feature-x",
            existing: true,
          }),
        );
      } finally {
        rendered.unmount();
      }
    });

    test("Ctrl+Enter with no branch selected (empty branch list) is a silent no-op", async () => {
      runPromiseMock.mockResolvedValueOnce([]);
      const onSubmitMock = vi.fn();
      const rendered = await renderExistingBranchForm(onSubmitMock);

      try {
        await tick(5);
        await sendKeys(rendered.stdin, CTRL_ENTER);

        expect(onSubmitMock).not.toHaveBeenCalled();
      } finally {
        rendered.unmount();
      }
    });
  });

  describe("UpModal", () => {
    test("Ctrl+Enter from a non-submit field fires onSubmit with the expected payload", async () => {
      const onSubmitMock = vi.fn();
      const rendered = await renderUpModal(onSubmitMock);

      try {
        await sendKeys(rendered.stdin, CTRL_ENTER);

        expect(onSubmitMock).toHaveBeenCalledTimes(1);
        expect(onSubmitMock).toHaveBeenCalledWith(
          expect.objectContaining({
            noIde: expect.any(Boolean),
            autoSwitch: expect.any(Boolean),
          }),
        );
      } finally {
        rendered.unmount();
      }
    });

    test("Ctrl+Enter while disabled (profile filter has no match) is a silent no-op", async () => {
      const onSubmitMock = vi.fn();
      const rendered = await renderUpModal(onSubmitMock);

      try {
        await sendKeys(rendered.stdin, "zzz", 5);
        await sendKeys(rendered.stdin, CTRL_ENTER);

        expect(onSubmitMock).not.toHaveBeenCalled();
      } finally {
        rendered.unmount();
      }
    });
  });

  describe("AddProjectModal", () => {
    test("Ctrl+Enter from path field fires onSubmit with nameManuallyEdited=false (name never touched)", async () => {
      runPromiseMock.mockResolvedValue(true);
      const onSubmitMock = vi.fn();
      const rendered = await renderAddProjectModal(onSubmitMock);

      try {
        await new Promise((r) => setTimeout(r, 150));
        await sendKeys(rendered.stdin, CTRL_ENTER);

        expect(onSubmitMock).toHaveBeenCalledTimes(1);
        expect(onSubmitMock).toHaveBeenCalledWith(
          expect.objectContaining({
            path: expect.any(String),
            name: expect.any(String),
            nameManuallyEdited: false,
          }),
        );
      } finally {
        rendered.unmount();
      }
    });

    test("Ctrl+Enter after typing a custom name fires onSubmit with nameManuallyEdited=true", async () => {
      runPromiseMock.mockResolvedValue(true);
      const onSubmitMock = vi.fn();
      const rendered = await renderAddProjectModal(onSubmitMock);

      try {
        await new Promise((r) => setTimeout(r, 150));
        await sendKeys(rendered.stdin, ENTER);
        await new Promise((r) => setTimeout(r, 0));
        await sendKeys(rendered.stdin, "\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f");
        await sendKeys(rendered.stdin, "my-proj");
        await new Promise((r) => setTimeout(r, 0));
        await sendKeys(rendered.stdin, CTRL_ENTER);

        expect(onSubmitMock).toHaveBeenCalledTimes(1);
        expect(onSubmitMock).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "my-proj",
            nameManuallyEdited: true,
          }),
        );
      } finally {
        rendered.unmount();
      }
    });

    test("Ctrl+Enter with a non-git path is a silent no-op", async () => {
      const onSubmitMock = vi.fn();
      const rendered = await renderAddProjectModal(onSubmitMock);

      try {
        await new Promise((r) => setTimeout(r, 150));
        await sendKeys(rendered.stdin, CTRL_ENTER);

        expect(onSubmitMock).not.toHaveBeenCalled();
      } finally {
        rendered.unmount();
      }
    });

    test("plain Enter on the path field still advances to name", async () => {
      runPromiseMock.mockResolvedValue(true);
      const onSubmitMock = vi.fn();
      const rendered = await renderAddProjectModal(onSubmitMock);

      try {
        await new Promise((r) => setTimeout(r, 150));
        await sendKeys(rendered.stdin, ENTER);
        await new Promise((r) => setTimeout(r, 0));
        expect(onSubmitMock).not.toHaveBeenCalled();
        await sendKeys(rendered.stdin, CTRL_ENTER);

        expect(onSubmitMock).toHaveBeenCalledTimes(1);
      } finally {
        rendered.unmount();
      }
    });
  });
});
