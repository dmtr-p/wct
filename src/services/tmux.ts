import { $ } from "bun";
import type { TmuxConfig, TmuxWindow } from "../config/schema";
import type { WctEnv } from "../types/env";
import { formatShellCommand, resolveWctBin } from "../utils/bin";
import * as logger from "../utils/logger";

export interface TmuxSession {
  name: string;
  attached: boolean;
  windows: number;
}

export function parseSessionListOutput(output: string): TmuxSession[] {
  if (!output) {
    return [];
  }

  return output.split("\n").map((line) => {
    const [name = "", attached, windows] = line.split(":");
    return {
      name,
      attached: attached === "1",
      windows: parseInt(windows ?? "0", 10),
    };
  });
}

export async function listSessions(): Promise<TmuxSession[] | null> {
  try {
    const result =
      await $`tmux list-sessions -F "#{session_name}:#{session_attached}:#{session_windows}"`.quiet();
    const output = result.text().trim();
    return parseSessionListOutput(output);
  } catch {
    return null;
  }
}

function isMissingPaneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("can't find pane") ||
    normalized.includes("can't find window") ||
    normalized.includes("no such pane")
  );
}

export async function isPaneAlive(pane: string): Promise<boolean | null> {
  try {
    await $`tmux display-message -p -t ${pane} '#{pane_id}'`.quiet();
    return true;
  } catch (error) {
    if (isMissingPaneError(error)) {
      return false;
    }
    return null;
  }
}

export async function sessionExists(name: string): Promise<boolean> {
  try {
    await $`tmux has-session -t =${name}`.quiet();
    return true;
  } catch {
    return false;
  }
}

export async function getSessionStatus(
  name: string,
): Promise<"attached" | "detached" | null> {
  const sessions = await listSessions();
  if (!sessions) {
    return null;
  }
  const session = sessions.find((s) => s.name === name);
  if (!session) {
    return null;
  }
  return session.attached ? "attached" : "detached";
}

export interface CreateSessionResult {
  success: boolean;
  sessionName: string;
  error?: string;
  alreadyExists?: boolean;
}

export interface TmuxCommand {
  type:
    | "new-session"
    | "new-window"
    | "split-window"
    | "set-environment"
    | "send-keys"
    | "select-layout"
    | "select-window"
    | "set-option"
    | "bind-key";
  args: string[];
}

function getDefinedEnvEntries(env?: WctEnv): [string, string][] {
  if (!env) {
    return [];
  }
  return Object.entries(env).filter(
    ([, value]): value is string => value !== undefined,
  );
}

function buildEnvOptionArgs(env?: WctEnv): string[] {
  return getDefinedEnvEntries(env).flatMap(([key, value]) => [
    "-e",
    `${key}=${value}`,
  ]);
}

export function buildWindowPaneCommands(
  windowTarget: string,
  workingDir: string,
  window: TmuxWindow,
  envOptionArgs: string[] = [],
): TmuxCommand[] {
  const commands: TmuxCommand[] = [];
  const panes = window.panes ?? [];
  const split = window.split ?? "horizontal";

  // If no panes, just run the window command (for single-pane windows)
  if (panes.length === 0) {
    if (window.command) {
      commands.push({
        type: "send-keys",
        args: ["-t", windowTarget, window.command, "Enter"],
      });
    }
    return commands;
  }

  // Run first pane command (panes[0] runs in the initial pane)
  // biome-ignore lint/style/noNonNullAssertion: guarded by panes.length > 0 check above
  const firstPane = panes[0]!;
  if (firstPane.command) {
    commands.push({
      type: "send-keys",
      args: ["-t", windowTarget, firstPane.command, "Enter"],
    });
  }

  // Create additional panes (each split creates new pane and makes it active)
  for (let i = 1; i < panes.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index is bounded by loop condition
    const pane = panes[i]!;
    const splitFlag = split === "horizontal" ? "-h" : "-v";

    commands.push({
      type: "split-window",
      args: [splitFlag, "-t", windowTarget, ...envOptionArgs, "-c", workingDir],
    });

    // After split, the new pane is active, so send-keys goes to the right pane
    if (pane.command) {
      commands.push({
        type: "send-keys",
        args: ["-t", windowTarget, pane.command, "Enter"],
      });
    }
  }

  // Apply layout if multiple panes
  if (panes.length > 1) {
    const layout = window.layout ?? "tiled";
    commands.push({
      type: "select-layout",
      args: ["-t", windowTarget, layout],
    });
  }

  return commands;
}

async function executeCommand(cmd: TmuxCommand): Promise<void> {
  switch (cmd.type) {
    case "new-session":
      await $`tmux new-session ${cmd.args}`.quiet();
      break;
    case "new-window":
      await $`tmux new-window ${cmd.args}`.quiet();
      break;
    case "split-window":
      await $`tmux split-window ${cmd.args}`.quiet();
      break;
    case "set-environment":
      await $`tmux set-environment ${cmd.args}`.quiet();
      break;
    case "send-keys":
      await $`tmux send-keys ${cmd.args}`.quiet();
      break;
    case "select-layout":
      await $`tmux select-layout ${cmd.args}`.quiet();
      break;
    case "select-window":
      await $`tmux select-window ${cmd.args}`.quiet();
      break;
    case "set-option":
      await $`tmux set-option ${cmd.args}`.quiet();
      break;
    case "bind-key":
      await $`tmux bind-key ${cmd.args}`.quiet();
      break;
  }
}

async function executeCommands(commands: TmuxCommand[]): Promise<void> {
  for (const cmd of commands) {
    await executeCommand(cmd);
  }
}

export function buildWindowsPaneCommands(
  sessionName: string,
  workingDir: string,
  windows: TmuxWindow[],
  env?: WctEnv,
): TmuxCommand[] {
  const commands: TmuxCommand[] = [];
  const envVars = getDefinedEnvEntries(env);
  const envOptionArgs = buildEnvOptionArgs(env);

  if (windows.length === 0) {
    commands.push({
      type: "new-session",
      args: ["-d", "-s", sessionName, ...envOptionArgs, "-c", workingDir],
    });
    for (const [key, value] of envVars) {
      commands.push({
        type: "set-environment",
        args: ["-t", sessionName, key, value],
      });
    }
    return commands;
  }

  // Create session with first window
  // biome-ignore lint/style/noNonNullAssertion: guarded by windows.length === 0 check above
  const firstWindow = windows[0]!;
  commands.push({
    type: "new-session",
    args: [
      "-d",
      "-s",
      sessionName,
      ...envOptionArgs,
      "-n",
      firstWindow.name,
      "-c",
      workingDir,
    ],
  });
  for (const [key, value] of envVars) {
    commands.push({
      type: "set-environment",
      args: ["-t", sessionName, key, value],
    });
  }
  commands.push(
    ...buildWindowPaneCommands(
      `${sessionName}:${firstWindow.name}`,
      workingDir,
      firstWindow,
      envOptionArgs,
    ),
  );

  // Create remaining windows
  for (let i = 1; i < windows.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index is bounded by loop condition
    const window = windows[i]!;
    commands.push({
      type: "new-window",
      args: [
        "-t",
        sessionName,
        ...envOptionArgs,
        "-n",
        window.name,
        "-c",
        workingDir,
      ],
    });
    commands.push(
      ...buildWindowPaneCommands(
        `${sessionName}:${window.name}`,
        workingDir,
        window,
        envOptionArgs,
      ),
    );
  }

  // Select first window
  commands.push({
    type: "select-window",
    args: ["-t", `${sessionName}:${firstWindow.name}`],
  });

  return commands;
}

async function createSessionWithWindows(
  name: string,
  workingDir: string,
  windows: TmuxWindow[],
  env?: WctEnv,
): Promise<void> {
  const commands = buildWindowsPaneCommands(name, workingDir, windows, env);
  await executeCommands(commands);
}

async function configureQueueStatusBar(sessionName: string): Promise<void> {
  try {
    const wctBin = resolveWctBin();

    // Set status refresh interval
    await executeCommand({
      type: "set-option",
      args: ["-t", sessionName, "status-interval", "5"],
    });

    // Read current status-right
    let currentStatusRight = "";
    try {
      const result =
        await $`tmux show-options -v -t ${sessionName} status-right`.quiet();
      currentStatusRight = result.text().trim();
    } catch {
      try {
        const result = await $`tmux show-options -gv status-right`.quiet();
        currentStatusRight = result.text().trim();
      } catch {
        currentStatusRight = "";
      }
    }

    // Prepend queue count
    const queueCount = `#(${formatShellCommand(wctBin, ["queue", "--count"])})`;
    if (!currentStatusRight.includes(queueCount)) {
      const newStatusRight = currentStatusRight
        ? `${queueCount} ${currentStatusRight}`
        : queueCount;
      await executeCommand({
        type: "set-option",
        args: ["-t", sessionName, "status-right", newStatusRight],
      });
    }

    // Bind C-q to interactive queue popup (root table, no prefix needed)
    await $`tmux bind-key -T root C-q display-popup -E -w 80% -h 50% ${{
      raw: formatShellCommand(wctBin, ["queue", "--interactive"]),
    }}`.quiet();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to set up queue-status widget/popup: ${message}`);
  }
}

export async function createSession(
  name: string,
  workingDir: string,
  config?: TmuxConfig,
  env?: WctEnv,
): Promise<CreateSessionResult> {
  if (await sessionExists(name)) {
    return {
      success: true,
      sessionName: name,
      alreadyExists: true,
    };
  }

  try {
    const windows = config?.windows ?? [];
    await createSessionWithWindows(name, workingDir, windows, env);
    await configureQueueStatusBar(name);
    return { success: true, sessionName: name };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, sessionName: name, error: message };
  }
}

export function formatSessionName(dirName: string): string {
  return dirName.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export interface KillSessionResult {
  success: boolean;
  sessionName: string;
  error?: string;
}

export async function killSession(name: string): Promise<KillSessionResult> {
  try {
    await $`tmux kill-session -t =${name}`.quiet();
    return { success: true, sessionName: name };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, sessionName: name, error: message };
  }
}

export async function getCurrentSession(): Promise<string | null> {
  if (!process.env.TMUX) {
    return null;
  }

  try {
    const result = await $`tmux display-message -p '#S'`.quiet();
    return result.text().trim();
  } catch {
    return null;
  }
}

export interface SwitchSessionResult {
  success: boolean;
  sessionName: string;
  error?: string;
}

export async function switchSession(
  name: string,
): Promise<SwitchSessionResult> {
  try {
    await $`tmux switch-client -t =${name}`.quiet();
    return { success: true, sessionName: name };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, sessionName: name, error: message };
  }
}

export async function attachSession(
  name: string,
): Promise<SwitchSessionResult> {
  try {
    await $`tmux attach-session -t =${name}`;
    return { success: true, sessionName: name };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, sessionName: name, error: message };
  }
}
