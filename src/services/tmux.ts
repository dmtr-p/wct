import { Effect, ServiceMap } from "effect";
import type { TmuxConfig, TmuxWindow } from "../config/schema";
import type { WctRuntimeServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import type { WctEnv } from "../types/env";
import {
  execProcess,
  getProcessErrorMessage,
  ProcessExitError,
  runProcess,
  spawnInteractive,
} from "./process";

export interface TmuxSession {
  name: string;
  attached: boolean;
  windows: number;
}

export interface TmuxPaneInfo {
  paneId: string;
  paneIndex: number;
  command: string;
  window: string;
}

export interface TmuxClient {
  tty: string;
  session: string;
}

export type CreateSessionResult =
  | { _tag: "Created"; sessionName: string }
  | { _tag: "AlreadyExists"; sessionName: string };

export interface TmuxService {
  listSessions: () => Effect.Effect<
    TmuxSession[] | null,
    WctError,
    WctRuntimeServices
  >;
  isPaneAlive: (
    pane: string,
  ) => Effect.Effect<boolean | null, WctError, WctRuntimeServices>;
  sessionExists: (
    name: string,
  ) => Effect.Effect<boolean, WctError, WctRuntimeServices>;
  getSessionStatus: (
    name: string,
  ) => Effect.Effect<
    "attached" | "detached" | null,
    WctError,
    WctRuntimeServices
  >;
  createSession: (
    name: string,
    workingDir: string,
    config?: TmuxConfig,
    env?: WctEnv,
  ) => Effect.Effect<CreateSessionResult, WctError, WctRuntimeServices>;
  killSession: (
    name: string,
  ) => Effect.Effect<void, WctError, WctRuntimeServices>;
  getCurrentSession: () => Effect.Effect<
    string | null,
    WctError,
    WctRuntimeServices
  >;
  switchSession: (
    name: string,
  ) => Effect.Effect<void, WctError, WctRuntimeServices>;
  attachSession: (
    name: string,
  ) => Effect.Effect<void, WctError, WctRuntimeServices>;
  listPanes: (
    sessionName: string,
  ) => Effect.Effect<TmuxPaneInfo[], WctError, WctRuntimeServices>;
  listClients: () => Effect.Effect<TmuxClient[], WctError, WctRuntimeServices>;
  switchClientToPane: (
    clientTty: string,
    target: string,
  ) => Effect.Effect<void, WctError, WctRuntimeServices>;
  selectPane: (
    pane: string,
  ) => Effect.Effect<void, WctError, WctRuntimeServices>;
  refreshClient: () => Effect.Effect<void, WctError, WctRuntimeServices>;
}

export const TmuxService = ServiceMap.Service<TmuxService>("wct/TmuxService");

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

export function parsePaneListOutput(output: string): TmuxPaneInfo[] {
  if (!output) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [pid, pIdx, cmd, win] = line.split("\t");
      return pid
        ? [
            {
              paneId: pid,
              paneIndex: Number(pIdx),
              command: cmd || "",
              window: win || "",
            },
          ]
        : [];
    });
}

export function parseClientListOutput(output: string): TmuxClient[] {
  if (!output) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [tty, session] = line.split("\t");
      return tty && session ? [{ tty, session }] : [];
    });
}

function listSessionsImpl() {
  return Effect.catch(
    execProcess("tmux", [
      "list-sessions",
      "-F",
      "#{session_name}:#{session_attached}:#{session_windows}",
    ]).pipe(
      Effect.map((result) => parseSessionListOutput(result.stdout.trim())),
    ),
    () => Effect.succeed(null),
  );
}

export function isMissingPaneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("can't find pane") ||
    normalized.includes("can't find window") ||
    normalized.includes("no such pane")
  );
}

function isPaneAliveImpl(pane: string) {
  return Effect.gen(function* () {
    const result = yield* runProcess("tmux", [
      "display-message",
      "-p",
      "-t",
      pane,
      "#{pane_id}",
    ]);

    if (result.success) {
      return true;
    }

    if (isMissingPaneError(result.stderr || result.stdout)) {
      return false;
    }

    return null;
  });
}

function sessionExistsImpl(name: string) {
  return runProcess("tmux", ["has-session", "-t", `=${name}`]).pipe(
    Effect.map((result) => result.success),
  );
}

function getSessionStatusImpl(name: string) {
  return Effect.gen(function* () {
    const sessions = yield* listSessionsImpl();
    if (!sessions) {
      return null;
    }
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return null;
    }
    return session.attached ? "attached" : "detached";
  });
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
    | "set-option";
  args: string[];
}

function getDefinedEnvEntries(env?: WctEnv): [string, string][] {
  if (!env) {
    return [];
  }
  return Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
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

function executeCommand(cmd: TmuxCommand) {
  return execProcess("tmux", [cmd.type, ...cmd.args]).pipe(Effect.asVoid);
}

function executeCommands(commands: TmuxCommand[]) {
  return Effect.forEach(commands, executeCommand, { discard: true });
}

export function buildWindowsPaneCommands(
  sessionName: string,
  workingDir: string,
  windows: ReadonlyArray<TmuxWindow>,
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

function createSessionWithWindows(
  name: string,
  workingDir: string,
  windows: ReadonlyArray<TmuxWindow>,
  env?: WctEnv,
) {
  const commands = buildWindowsPaneCommands(name, workingDir, windows, env);
  return executeCommands(commands);
}

function createSessionImpl(
  name: string,
  workingDir: string,
  config?: TmuxConfig,
  env?: WctEnv,
) {
  return Effect.gen(function* () {
    if (yield* sessionExistsImpl(name)) {
      return { _tag: "AlreadyExists" as const, sessionName: name };
    }

    const windows = config?.windows ?? [];
    yield* Effect.catch(
      createSessionWithWindows(name, workingDir, windows, env),
      (error) =>
        Effect.gen(function* () {
          yield* Effect.catch(killSessionImpl(name), () => Effect.void);
          return yield* Effect.fail(error);
        }),
    );
    return { _tag: "Created" as const, sessionName: name };
  });
}

export function formatSessionName(dirName: string): string {
  return dirName.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function killSessionImpl(name: string) {
  return execProcess("tmux", ["kill-session", "-t", `=${name}`]).pipe(
    Effect.asVoid,
  );
}

function getCurrentSessionImpl() {
  if (!process.env.TMUX) {
    return Effect.succeed(null);
  }

  return Effect.catch(
    execProcess("tmux", ["display-message", "-p", "#S"]).pipe(
      Effect.map((result) => result.stdout.trim()),
    ),
    () => Effect.succeed(null),
  );
}

function switchSessionImpl(name: string) {
  return execProcess("tmux", ["switch-client", "-t", `=${name}`]).pipe(
    Effect.asVoid,
  );
}

function attachSessionImpl(name: string) {
  return Effect.gen(function* () {
    const exitCode = yield* spawnInteractive("tmux", [
      "attach-session",
      "-t",
      `=${name}`,
    ]);

    if (exitCode !== 0) {
      return yield* Effect.fail(
        new ProcessExitError({
          command: "tmux",
          args: ["attach-session", "-t", `=${name}`],
          stdout: "",
          stderr: "",
          exitCode,
        }),
      );
    }
  });
}

function listPanesImpl(sessionName: string) {
  return Effect.catch(
    execProcess("tmux", [
      "list-panes",
      "-s",
      "-t",
      `=${sessionName}`,
      "-F",
      "#{pane_id}\t#{pane_index}\t#{pane_current_command}\t#{window_name}",
    ]).pipe(Effect.map((result) => parsePaneListOutput(result.stdout.trim()))),
    () => Effect.succeed([] as TmuxPaneInfo[]),
  );
}

function listClientsImpl() {
  return Effect.catch(
    execProcess("tmux", [
      "list-clients",
      "-F",
      "#{client_tty}\t#{client_session}",
    ]).pipe(
      Effect.map((result) => parseClientListOutput(result.stdout.trim())),
    ),
    () => Effect.succeed([] as TmuxClient[]),
  );
}

function switchClientToPaneImpl(clientTty: string, target: string) {
  return execProcess("tmux", [
    "switch-client",
    "-c",
    clientTty,
    "-t",
    target,
  ]).pipe(Effect.asVoid);
}

function selectPaneImpl(pane: string) {
  return execProcess("tmux", ["select-pane", "-t", pane]).pipe(Effect.asVoid);
}

function refreshClientImpl() {
  return execProcess("tmux", ["refresh-client", "-S"]).pipe(Effect.asVoid);
}

export const liveTmuxService: TmuxService = TmuxService.of({
  listSessions: () =>
    Effect.mapError(listSessionsImpl(), (error) =>
      commandError("tmux_error", "Failed to list tmux sessions", error),
    ),
  isPaneAlive: (pane) =>
    Effect.mapError(isPaneAliveImpl(pane), (error) =>
      commandError(
        "tmux_error",
        `Failed to inspect tmux pane '${pane}'`,
        error,
      ),
    ),
  sessionExists: (name) =>
    Effect.mapError(sessionExistsImpl(name), (error) =>
      commandError(
        "tmux_error",
        `Failed to check tmux session '${name}'`,
        error,
      ),
    ),
  getSessionStatus: (name) =>
    Effect.mapError(getSessionStatusImpl(name), (error) =>
      commandError(
        "tmux_error",
        `Failed to get tmux session status for '${name}'`,
        error,
      ),
    ),
  createSession: (name, workingDir, config, env) =>
    Effect.mapError(createSessionImpl(name, workingDir, config, env), (error) =>
      commandError(
        "tmux_error",
        `Failed to create tmux session '${name}': ${getProcessErrorMessage(error)}`,
        error,
      ),
    ),
  killSession: (name) =>
    Effect.mapError(killSessionImpl(name), (error) =>
      commandError(
        "tmux_error",
        `Failed to kill tmux session: ${getProcessErrorMessage(error)}`,
        error,
      ),
    ),
  getCurrentSession: () =>
    Effect.mapError(getCurrentSessionImpl(), (error) =>
      commandError(
        "tmux_error",
        "Failed to determine current tmux session",
        error,
      ),
    ),
  switchSession: (name) =>
    Effect.mapError(switchSessionImpl(name), (error) =>
      commandError(
        "tmux_error",
        `Failed to switch to session '${name}': ${getProcessErrorMessage(error)}`,
        error,
      ),
    ),
  attachSession: (name) =>
    Effect.mapError(attachSessionImpl(name), (error) =>
      commandError(
        "tmux_error",
        `Failed to attach to session '${name}': ${getProcessErrorMessage(error)}`,
        error,
      ),
    ),
  listPanes: (sessionName) =>
    Effect.mapError(listPanesImpl(sessionName), (error) =>
      commandError(
        "tmux_error",
        `Failed to list panes for session '${sessionName}'`,
        error,
      ),
    ),
  listClients: () =>
    Effect.mapError(listClientsImpl(), (error) =>
      commandError("tmux_error", "Failed to list tmux clients", error),
    ),
  switchClientToPane: (clientTty, target) =>
    Effect.mapError(switchClientToPaneImpl(clientTty, target), (error) =>
      commandError(
        "tmux_error",
        `Failed to switch client to '${target}'`,
        error,
      ),
    ),
  selectPane: (pane) =>
    Effect.mapError(selectPaneImpl(pane), (error) =>
      commandError("tmux_error", `Failed to select pane '${pane}'`, error),
    ),
  refreshClient: () =>
    Effect.mapError(refreshClientImpl(), (error) =>
      commandError("tmux_error", "Failed to refresh tmux client", error),
    ),
});
