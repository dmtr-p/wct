import { describe, expect, test } from "bun:test";
import {
  buildWindowsPaneCommands,
  formatSessionName,
  getCurrentSession,
  parseSessionListOutput,
  switchSession,
} from "../src/services/tmux";

const TEST_ENV = {
  WCT_WORKTREE_DIR: "/worktrees/feature-auth",
  WCT_MAIN_DIR: "/repos/main",
  WCT_BRANCH: "feature-auth",
  WCT_PROJECT: "myapp",
};

describe("formatSessionName", () => {
  test("returns dirname unchanged when already clean", () => {
    const result = formatSessionName("myapp-feature-auth");
    expect(result).toBe("myapp-feature-auth");
  });

  test("sanitizes special characters", () => {
    const result = formatSessionName("myapp-feature@auth#test");
    expect(result).toBe("myapp-feature-auth-test");
  });

  test("preserves underscores and hyphens", () => {
    const result = formatSessionName("my_app-feature_auth-test");
    expect(result).toBe("my_app-feature_auth-test");
  });

  test("sanitizes dots", () => {
    const result = formatSessionName("myapp.v2");
    expect(result).toBe("myapp-v2");
  });
});

describe("parseSessionListOutput", () => {
  test("parses session list output", () => {
    const output = `main:0:3
myapp-feature-auth:1:2
myapp-fix-login:0:1`;

    const sessions = parseSessionListOutput(output);

    expect(sessions).toHaveLength(3);

    expect(sessions[0].name).toBe("main");
    expect(sessions[0].attached).toBe(false);
    expect(sessions[0].windows).toBe(3);

    expect(sessions[1].name).toBe("myapp-feature-auth");
    expect(sessions[1].attached).toBe(true);
    expect(sessions[1].windows).toBe(2);

    expect(sessions[2].name).toBe("myapp-fix-login");
    expect(sessions[2].attached).toBe(false);
    expect(sessions[2].windows).toBe(1);
  });

  test("handles empty session list", () => {
    const sessions = parseSessionListOutput("");
    expect(sessions).toHaveLength(0);
  });
});

describe("getCurrentSession", () => {
  test("returns null when TMUX env is not set", async () => {
    const originalTmux = process.env.TMUX;
    delete process.env.TMUX;

    const result = await getCurrentSession();
    expect(result).toBeNull();

    if (originalTmux !== undefined) {
      process.env.TMUX = originalTmux;
    }
  });
});

describe("buildWindowsPaneCommands", () => {
  test("injects session environment variables when provided", () => {
    const commands = buildWindowsPaneCommands(
      "test-session",
      "/work",
      [{ name: "shell" }],
      TEST_ENV,
    );

    expect(commands).toEqual([
      {
        type: "new-session",
        args: [
          "-d",
          "-s",
          "test-session",
          "-e",
          "WCT_WORKTREE_DIR=/worktrees/feature-auth",
          "-e",
          "WCT_MAIN_DIR=/repos/main",
          "-e",
          "WCT_BRANCH=feature-auth",
          "-e",
          "WCT_PROJECT=myapp",
          "-n",
          "shell",
          "-c",
          "/work",
        ],
      },
      {
        type: "set-environment",
        args: [
          "-t",
          "test-session",
          "WCT_WORKTREE_DIR",
          "/worktrees/feature-auth",
        ],
      },
      {
        type: "set-environment",
        args: ["-t", "test-session", "WCT_MAIN_DIR", "/repos/main"],
      },
      {
        type: "set-environment",
        args: ["-t", "test-session", "WCT_BRANCH", "feature-auth"],
      },
      {
        type: "set-environment",
        args: ["-t", "test-session", "WCT_PROJECT", "myapp"],
      },
      {
        type: "select-window",
        args: ["-t", "test-session:shell"],
      },
    ]);
  });

  test("does not inject session environment variables when env is omitted", () => {
    const commands = buildWindowsPaneCommands("test-session", "/work", [
      { name: "shell" },
    ]);

    const setEnvCommands = commands.filter((c) => c.type === "set-environment");
    expect(setEnvCommands).toHaveLength(0);
  });

  test("sets session environment before window commands", () => {
    const commands = buildWindowsPaneCommands(
      "test-session",
      "/work",
      [{ name: "dev", command: "echo $WCT_BRANCH" }],
      TEST_ENV,
    );

    const firstSetEnvIndex = commands.findIndex(
      (c) => c.type === "set-environment",
    );
    const firstSendKeysIndex = commands.findIndex(
      (c) => c.type === "send-keys",
    );

    expect(firstSetEnvIndex).toBeGreaterThan(0);
    expect(firstSendKeysIndex).toBeGreaterThan(firstSetEnvIndex);
  });

  test("passes env to new-session via -e options", () => {
    const commands = buildWindowsPaneCommands(
      "test-session",
      "/work",
      [{ name: "dev", command: "echo $WCT_BRANCH" }],
      TEST_ENV,
    );

    expect(commands[0]).toEqual({
      type: "new-session",
      args: [
        "-d",
        "-s",
        "test-session",
        "-e",
        "WCT_WORKTREE_DIR=/worktrees/feature-auth",
        "-e",
        "WCT_MAIN_DIR=/repos/main",
        "-e",
        "WCT_BRANCH=feature-auth",
        "-e",
        "WCT_PROJECT=myapp",
        "-n",
        "dev",
        "-c",
        "/work",
      ],
    });
  });

  test("passes env to additional panes and windows via -e options", () => {
    const commands = buildWindowsPaneCommands(
      "test-session",
      "/work",
      [
        {
          name: "dev",
          panes: [{ command: "echo one" }, { command: "echo two" }],
        },
        { name: "shell" },
      ],
      TEST_ENV,
    );

    const splitCmd = commands.find((c) => c.type === "split-window");
    expect(splitCmd?.args).toContain("-e");
    expect(splitCmd?.args).toContain("WCT_BRANCH=feature-auth");

    const newWindowCmd = commands.find((c) => c.type === "new-window");
    expect(newWindowCmd?.args).toContain("-e");
    expect(newWindowCmd?.args).toContain("WCT_MAIN_DIR=/repos/main");
  });

  test("emits session set-environment commands for empty windows with env", () => {
    const commands = buildWindowsPaneCommands(
      "test-session",
      "/work",
      [],
      TEST_ENV,
    );
    const setEnvCommands = commands.filter((c) => c.type === "set-environment");

    expect(setEnvCommands).toHaveLength(Object.keys(TEST_ENV).length);

    for (const [key, value] of Object.entries(TEST_ENV)) {
      const match = setEnvCommands.find((c) => {
        return (
          c.args[0] === "-t" &&
          c.args[1] === "test-session" &&
          c.args[2] === key &&
          c.args[3] === value
        );
      });
      expect(match).toBeDefined();
    }
  });

  test("creates session with single window, no panes", () => {
    const commands = buildWindowsPaneCommands("test-session", "/work", [
      { name: "shell" },
    ]);

    expect(commands).toEqual([
      {
        type: "new-session",
        args: ["-d", "-s", "test-session", "-n", "shell", "-c", "/work"],
      },
      {
        type: "select-window",
        args: ["-t", "test-session:shell"],
      },
    ]);
  });

  test("creates session with single window and command", () => {
    const commands = buildWindowsPaneCommands("test-session", "/work", [
      { name: "dev", command: "bun run dev" },
    ]);

    expect(commands).toEqual([
      {
        type: "new-session",
        args: ["-d", "-s", "test-session", "-n", "dev", "-c", "/work"],
      },
      {
        type: "send-keys",
        args: ["-t", "test-session:dev", "bun run dev", "Enter"],
      },
      {
        type: "select-window",
        args: ["-t", "test-session:dev"],
      },
    ]);
  });

  test("creates session with single window and multiple panes (horizontal)", () => {
    const commands = buildWindowsPaneCommands("test-session", "/work", [
      {
        name: "dev",
        split: "horizontal",
        panes: [{ command: "bun run dev" }, { command: "bun run watch" }],
      },
    ]);

    expect(commands).toEqual([
      {
        type: "new-session",
        args: ["-d", "-s", "test-session", "-n", "dev", "-c", "/work"],
      },
      {
        type: "send-keys",
        args: ["-t", "test-session:dev", "bun run dev", "Enter"],
      },
      {
        type: "split-window",
        args: ["-h", "-t", "test-session:dev", "-c", "/work"],
      },
      {
        type: "send-keys",
        args: ["-t", "test-session:dev", "bun run watch", "Enter"],
      },
      {
        type: "select-layout",
        args: ["-t", "test-session:dev", "tiled"],
      },
      {
        type: "select-window",
        args: ["-t", "test-session:dev"],
      },
    ]);
  });

  test("creates session with single window and multiple panes (vertical)", () => {
    const commands = buildWindowsPaneCommands("test-session", "/work", [
      {
        name: "dev",
        split: "vertical",
        panes: [{ command: "pane1" }, { command: "pane2" }],
      },
    ]);

    const splitCmd = commands.find((c) => c.type === "split-window");
    expect(splitCmd?.args[0]).toBe("-v");
  });

  test("creates session with multiple windows", () => {
    const commands = buildWindowsPaneCommands("test-session", "/work", [
      { name: "dev", command: "bun run dev" },
      { name: "shell" },
      { name: "test", command: "bun test --watch" },
    ]);

    expect(commands[0]).toEqual({
      type: "new-session",
      args: ["-d", "-s", "test-session", "-n", "dev", "-c", "/work"],
    });

    const newWindowCmds = commands.filter((c) => c.type === "new-window");
    expect(newWindowCmds).toHaveLength(2);
    expect(newWindowCmds[0].args).toContain("shell");
    expect(newWindowCmds[1].args).toContain("test");

    // Last command should select first window
    expect(commands[commands.length - 1]).toEqual({
      type: "select-window",
      args: ["-t", "test-session:dev"],
    });
  });

  test("creates session with mixed single and multi-pane windows", () => {
    const commands = buildWindowsPaneCommands("test-session", "/work", [
      {
        name: "dev",
        split: "horizontal",
        panes: [{ command: "bun run dev" }, { command: "bun run watch" }],
      },
      { name: "shell" },
    ]);

    // First window should have split-window command
    const splitCmds = commands.filter((c) => c.type === "split-window");
    expect(splitCmds).toHaveLength(1);

    // Second window should be created
    const newWindowCmds = commands.filter((c) => c.type === "new-window");
    expect(newWindowCmds).toHaveLength(1);
    expect(newWindowCmds[0].args).toContain("shell");
  });

  test("handles empty windows array", () => {
    const commands = buildWindowsPaneCommands("test-session", "/work", []);

    expect(commands).toEqual([
      {
        type: "new-session",
        args: ["-d", "-s", "test-session", "-c", "/work"],
      },
    ]);
  });

  test("handles window with empty panes array", () => {
    const commands = buildWindowsPaneCommands("test-session", "/work", [
      { name: "shell", panes: [] },
    ]);

    // Empty panes array means no pane commands, just create window
    expect(commands).toEqual([
      {
        type: "new-session",
        args: ["-d", "-s", "test-session", "-n", "shell", "-c", "/work"],
      },
      {
        type: "select-window",
        args: ["-t", "test-session:shell"],
      },
    ]);
  });

  test("handles panes without commands", () => {
    const commands = buildWindowsPaneCommands("test-session", "/work", [
      {
        name: "dev",
        panes: [{}, { command: "bun run watch" }],
      },
    ]);

    // First pane has no command, second does
    const sendKeysCmds = commands.filter((c) => c.type === "send-keys");
    expect(sendKeysCmds).toHaveLength(1);
    expect(sendKeysCmds[0].args).toContain("bun run watch");
  });

  test("defaults to horizontal split when not specified", () => {
    const commands = buildWindowsPaneCommands("test-session", "/work", [
      {
        name: "dev",
        panes: [{ command: "pane1" }, { command: "pane2" }],
      },
    ]);

    const splitCmd = commands.find((c) => c.type === "split-window");
    expect(splitCmd?.args[0]).toBe("-h");
  });

  test("uses specified layout preset for multi-pane window", () => {
    const commands = buildWindowsPaneCommands("test-session", "/work", [
      {
        name: "editor",
        layout: "main-vertical",
        panes: [{ command: "nvim" }, { command: "bun test" }, {}],
      },
    ]);

    const layoutCmd = commands.find((c) => c.type === "select-layout");
    expect(layoutCmd).toBeDefined();
    expect(layoutCmd?.args).toEqual([
      "-t",
      "test-session:editor",
      "main-vertical",
    ]);
  });

  test("defaults to tiled layout when layout not specified", () => {
    const commands = buildWindowsPaneCommands("test-session", "/work", [
      {
        name: "dev",
        panes: [{ command: "pane1" }, { command: "pane2" }],
      },
    ]);

    const layoutCmd = commands.find((c) => c.type === "select-layout");
    expect(layoutCmd).toBeDefined();
    expect(layoutCmd?.args).toEqual(["-t", "test-session:dev", "tiled"]);
  });

  test("applies each layout preset correctly", () => {
    const layouts = [
      "even-horizontal",
      "even-vertical",
      "main-horizontal",
      "main-vertical",
      "tiled",
    ] as const;

    for (const layout of layouts) {
      const commands = buildWindowsPaneCommands("test-session", "/work", [
        {
          name: "win",
          layout,
          panes: [{}, {}],
        },
      ]);

      const layoutCmd = commands.find((c) => c.type === "select-layout");
      expect(layoutCmd?.args[2]).toBe(layout);
    }
  });

  test("does not add layout command for single-pane window", () => {
    const commands = buildWindowsPaneCommands("test-session", "/work", [
      {
        name: "editor",
        layout: "main-vertical",
        panes: [{ command: "nvim" }],
      },
    ]);

    const layoutCmd = commands.find((c) => c.type === "select-layout");
    expect(layoutCmd).toBeUndefined();
  });

  test("creates window with three or more panes", () => {
    const commands = buildWindowsPaneCommands("test-session", "/work", [
      {
        name: "editor",
        layout: "main-vertical",
        panes: [
          { command: "nvim" },
          { command: "bun test --watch" },
          { command: "bun run dev" },
          {}, // empty shell pane
        ],
      },
    ]);

    // Should have 3 split-window commands (first pane uses initial window)
    const splitCmds = commands.filter((c) => c.type === "split-window");
    expect(splitCmds).toHaveLength(3);

    // Should have 3 send-keys commands (4th pane has no command)
    const sendKeysCmds = commands.filter((c) => c.type === "send-keys");
    expect(sendKeysCmds).toHaveLength(3);

    // Should have layout command
    const layoutCmd = commands.find((c) => c.type === "select-layout");
    expect(layoutCmd?.args[2]).toBe("main-vertical");
  });
});

describe("switchSession", () => {
  test("switchSession function is defined", () => {
    expect(typeof switchSession).toBe("function");
  });
});
