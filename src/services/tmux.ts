import { Effect, ServiceMap } from "effect";
import type { TmuxConfig, TmuxWindow } from "../config/schema";
import { runBunPromise } from "../effect/runtime";
import { provideWctServices, type WctServices } from "../effect/services";
import { commandError, type WctError } from "../errors";
import type { WctEnv } from "../types/env";
import { formatShellCommand, resolveWctBin } from "../utils/bin";
import * as logger from "../utils/logger";
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

export type CreateSessionResult =
  | { _tag: "Created"; sessionName: string }
  | { _tag: "AlreadyExists"; sessionName: string };

export interface TmuxService {
  listSessions: () => Effect.Effect<
    TmuxSession[] | null,
    WctError,
    WctServices
  >;
  isPaneAlive: (
    pane: string,
  ) => Effect.Effect<boolean | null, WctError, WctServices>;
  sessionExists: (
    name: string,
  ) => Effect.Effect<boolean, WctError, WctServices>;
  getSessionStatus: (
    name: string,
  ) => Effect.Effect<"attached" | "detached" | null, WctError, WctServices>;
  createSession: (
    name: string,
    workingDir: string,
    config?: TmuxConfig,
    env?: WctEnv,
  ) => Effect.Effect<CreateSessionResult, WctError, WctServices>;
  killSession: (name: string) => Effect.Effect<void, WctError, WctServices>;
  getCurrentSession: () => Effect.Effect<string | null, WctError, WctServices>;
  switchSession: (name: string) => Effect.Effect<void, WctError, WctServices>;
  attachSession: (name: string) => Effect.Effect<void, WctError, WctServices>;
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
    | "set-option"
    | "bind-key";
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

function getSessionLocalStatusRight(sessionName: string) {
  return Effect.catch(
    execProcess("tmux", [
      "show-options",
      "-qv",
      "-t",
      sessionName,
      "status-right",
    ]).pipe(Effect.map((result) => result.stdout.trim())),
    () => Effect.succeed(""),
  );
}

function getGlobalStatusRight() {
  return Effect.catch(
    execProcess("tmux", ["show-options", "-gv", "status-right"]).pipe(
      Effect.map((result) => result.stdout.trim()),
    ),
    () => Effect.succeed(""),
  );
}

export function planQueueStatusRightUpdate(
  queueCount: string,
  sessionStatusRight: string,
  globalStatusRight: string,
): { action: "noop" } | { action: "unset" } | { action: "set"; value: string } {
  const currentSessionStatusRight = sessionStatusRight.trim();
  const currentGlobalStatusRight = globalStatusRight.trim();
  const sessionHasQueue = currentSessionStatusRight.includes(queueCount);
  const globalHasQueue = currentGlobalStatusRight.includes(queueCount);

  if (sessionHasQueue) {
    if (currentSessionStatusRight !== queueCount) {
      return { action: "noop" };
    }

    if (globalHasQueue) {
      return { action: "unset" };
    }

    return currentGlobalStatusRight
      ? { action: "set", value: `${queueCount} ${currentGlobalStatusRight}` }
      : { action: "noop" };
  }

  if (currentSessionStatusRight) {
    return {
      action: "set",
      value: `${queueCount} ${currentSessionStatusRight}`,
    };
  }

  if (globalHasQueue) {
    return { action: "noop" };
  }

  return currentGlobalStatusRight
    ? { action: "set", value: `${queueCount} ${currentGlobalStatusRight}` }
    : { action: "set", value: queueCount };
}

function configureQueueStatusBar(sessionName: string) {
  return Effect.catch(
    Effect.gen(function* () {
      const wctBin = resolveWctBin();

      // Set status refresh interval
      yield* executeCommand({
        type: "set-option",
        args: ["-t", sessionName, "status-interval", "5"],
      });

      const queueCount = `#(${formatShellCommand(wctBin, ["queue", "--count"])})`;
      const sessionStatusRight = yield* getSessionLocalStatusRight(sessionName);
      const globalStatusRight = yield* getGlobalStatusRight();
      const statusRightUpdate = planQueueStatusRightUpdate(
        queueCount,
        sessionStatusRight,
        globalStatusRight,
      );

      if (statusRightUpdate.action === "set") {
        yield* executeCommand({
          type: "set-option",
          args: ["-t", sessionName, "status-right", statusRightUpdate.value],
        });
      } else if (statusRightUpdate.action === "unset") {
        yield* executeCommand({
          type: "set-option",
          args: ["-u", "-t", sessionName, "status-right"],
        });
      }

      // Bind C-q to interactive queue popup (root table, no prefix needed)
      yield* execProcess("tmux", [
        "bind-key",
        "-T",
        "root",
        "C-q",
        "display-popup",
        "-E",
        "-w",
        "80%",
        "-h",
        "50%",
        formatShellCommand(wctBin, ["queue", "--interactive"]),
      ]);
    }),
    (error) =>
      logger.warn(
        `Failed to set up queue-status widget/popup: ${getProcessErrorMessage(error)}`,
      ),
  );
}

function createSessionImpl(
  name: string,
  workingDir: string,
  config?: TmuxConfig,
  env?: WctEnv,
) {
  return Effect.gen(function* () {
    if (yield* sessionExistsImpl(name)) {
      yield* configureQueueStatusBar(name);
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
    yield* configureQueueStatusBar(name);
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
});

function provideTmuxService<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return provideWctServices(
    Effect.provideService(effect, TmuxService, liveTmuxService),
  );
}

export async function listSessions(): Promise<TmuxSession[] | null> {
  return runBunPromise(
    provideTmuxService(TmuxService.use((service) => service.listSessions())),
  );
}

export async function isPaneAlive(pane: string): Promise<boolean | null> {
  return runBunPromise(
    provideTmuxService(TmuxService.use((service) => service.isPaneAlive(pane))),
  );
}

export async function sessionExists(name: string): Promise<boolean> {
  return runBunPromise(
    provideTmuxService(
      TmuxService.use((service) => service.sessionExists(name)),
    ),
  );
}

export async function getSessionStatus(
  name: string,
): Promise<"attached" | "detached" | null> {
  return runBunPromise(
    provideTmuxService(
      TmuxService.use((service) => service.getSessionStatus(name)),
    ),
  );
}

export async function createSession(
  name: string,
  workingDir: string,
  config?: TmuxConfig,
  env?: WctEnv,
): Promise<CreateSessionResult> {
  return runBunPromise(
    provideTmuxService(
      TmuxService.use((service) =>
        service.createSession(name, workingDir, config, env),
      ),
    ),
  );
}

export async function killSession(name: string): Promise<void> {
  return runBunPromise(
    provideTmuxService(TmuxService.use((service) => service.killSession(name))),
  );
}

export async function getCurrentSession(): Promise<string | null> {
  return runBunPromise(
    provideTmuxService(
      TmuxService.use((service) => service.getCurrentSession()),
    ),
  );
}

export async function switchSession(name: string): Promise<void> {
  return runBunPromise(
    provideTmuxService(
      TmuxService.use((service) => service.switchSession(name)),
    ),
  );
}

export async function attachSession(name: string): Promise<void> {
  return runBunPromise(
    provideTmuxService(
      TmuxService.use((service) => service.attachSession(name)),
    ),
  );
}
