import type { BunServices } from "@effect/platform-bun";
import { Context, Effect } from "effect";
import type { TmuxConfig, TmuxWindow } from "../config/schema";
import {
  captureBunService,
  type ServiceImplementation,
} from "../effect/service-context";
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
  zoomed: boolean;
  active: boolean;
}

/** Observation-only metadata; never part of the CLI JSON contract. */
export interface AgentPaneMetadata {
  server: string;
  session: string;
  paneId: string;
  tty: string;
  initialPid: number;
  command: string;
  title: string;
  width: number;
  height: number;
  dead: boolean;
  progress?: string;
}

export function parseAgentPaneMetadata(output: string): AgentPaneMetadata[] {
  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [
        socket,
        pid,
        start,
        session,
        paneId,
        tty,
        initialPid,
        command,
        width,
        height,
        dead,
        progress,
        ...title
      ] = line.split("\t");
      if (
        !socket ||
        !pid ||
        !start ||
        !session ||
        !paneId ||
        !tty ||
        !/^%\d+$/.test(paneId) ||
        !/^\d+$/.test(initialPid ?? "") ||
        !/^\d+$/.test(width ?? "") ||
        !/^\d+$/.test(height ?? "")
      )
        return [];
      return [
        {
          server: `${socket}\0${pid}\0${start}`,
          session,
          paneId,
          tty,
          initialPid: Number(initialPid),
          command: command ?? "",
          title: title.join("\t"),
          width: Number(width),
          height: Number(height),
          dead: dead === "1",
          progress: [
            "hidden",
            "normal",
            "error",
            "indeterminate",
            "paused",
          ].includes(progress ?? "")
            ? progress
            : undefined,
        },
      ];
    });
}

// Unknown format variables expand to empty on older servers. A recognized
// progress value is the capability check; no client-version assumption.
export const discoverAgentPanes = execProcess(
  "tmux",
  [
    "list-panes",
    "-a",
    "-F",
    "#{socket_path}\t#{pid}\t#{start_time}\t#{session_name}\t#{pane_id}\t#{pane_tty}\t#{pane_pid}\t#{pane_current_command}\t#{pane_width}\t#{pane_height}\t#{pane_dead}\t#{pane_pb_state}\t#{pane_title}",
  ],
  { maxOutputBytes: 1024 * 1024 },
).pipe(
  Effect.flatMap(({ stdout }) => {
    const panes = parseAgentPaneMetadata(stdout);
    return stdout.trim() && !panes.length
      ? Effect.fail(
          commandError("tmux_error", "Tmux observation metadata unavailable"),
        )
      : Effect.succeed(panes);
  }),
  Effect.timeout("1 second"),
  Effect.catchIf(
    (error) =>
      error instanceof ProcessExitError &&
      error.exitCode === 1 &&
      error.cause === undefined &&
      /^(?:no server running on [^\r\n]+|error connecting to [^\r\n]+ \((?:No such file or directory|Connection refused)\))$/.test(
        error.stderr.trim(),
      ),
    () => Effect.succeed([] as AgentPaneMetadata[]),
  ),
);

export function captureAgentPane(paneId: string) {
  return execProcess("tmux", ["capture-pane", "-p", "-t", paneId], {
    maxOutputBytes: 256 * 1024,
  }).pipe(
    Effect.map(({ stdout }) => stdout),
    Effect.timeout("1 second"),
  );
}

export interface TmuxClient {
  tty: string;
  session: string;
}

export type CreateSessionResult =
  | { _tag: "Created"; sessionName: string }
  | { _tag: "AlreadyExists"; sessionName: string };

export interface TmuxService {
  listSessions: Effect.Effect<TmuxSession[] | null, WctError>;
  sessionExists: (name: string) => Effect.Effect<boolean, WctError>;
  createSession: (
    name: string,
    workingDir: string,
    config?: TmuxConfig,
    env?: WctEnv,
  ) => Effect.Effect<CreateSessionResult, WctError>;
  killSession: (name: string) => Effect.Effect<void, WctError>;
  getCurrentSession: Effect.Effect<string | null, WctError>;
  switchSession: (name: string) => Effect.Effect<void, WctError>;
  attachSession: (name: string) => Effect.Effect<void, WctError>;
  listPanes: (sessionName: string) => Effect.Effect<TmuxPaneInfo[], WctError>;
  listClients: Effect.Effect<TmuxClient[], WctError>;
  detachClient: (clientTty: string) => Effect.Effect<void, WctError>;
  switchClientToPane: (
    clientTty: string,
    target: string,
  ) => Effect.Effect<void, WctError>;
  togglePaneZoom: (paneId: string) => Effect.Effect<void, WctError>;
  killPane: (paneId: string) => Effect.Effect<void, WctError>;
}

export const TmuxService = Context.Service<TmuxService>("wct/TmuxService");

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
      const [pid, pIdx, cmd, win, zoom, active] = line.split("\t");
      return pid
        ? [
            {
              paneId: pid,
              paneIndex: Number(pIdx),
              command: cmd || "",
              window: win || "",
              zoomed: zoom === "1",
              active: active === "1",
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
  return Effect.orElseSucceed(
    execProcess("tmux", [
      "list-sessions",
      "-F",
      "#{session_name}:#{session_attached}:#{session_windows}",
    ]).pipe(
      Effect.map((result) => parseSessionListOutput(result.stdout.trim())),
    ),
    () => null,
  );
}

function sessionExistsImpl(name: string) {
  return runProcess("tmux", ["has-session", "-t", `=${name}`]).pipe(
    Effect.map((result) => result.success),
  );
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

  if (panes.length === 0) {
    if (window.command) {
      commands.push({
        type: "send-keys",
        args: ["-t", windowTarget, window.command, "Enter"],
      });
    }
    return commands;
  }

  // biome-ignore lint/style/noNonNullAssertion: guarded by panes.length > 0 check above
  const firstPane = panes[0]!;
  if (firstPane.command) {
    commands.push({
      type: "send-keys",
      args: ["-t", windowTarget, firstPane.command, "Enter"],
    });
  }

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
          yield* Effect.ignore(killSessionImpl(name));
          return yield* error;
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

function togglePaneZoomImpl(paneId: string) {
  return execProcess("tmux", ["resize-pane", "-Z", "-t", paneId]).pipe(
    Effect.asVoid,
  );
}

function killPaneImpl(paneId: string) {
  return execProcess("tmux", ["kill-pane", "-t", paneId]).pipe(Effect.asVoid);
}

const getCurrentSessionImpl = Effect.suspend(() => {
  if (!process.env.TMUX) {
    return Effect.succeed(null);
  }

  return Effect.orElseSucceed(
    execProcess("tmux", [
      "display-message",
      ...(process.env.TMUX_PANE ? ["-t", process.env.TMUX_PANE] : []),
      "-p",
      "#S",
    ]).pipe(Effect.map((result) => result.stdout.trim())),
    () => null,
  );
});

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
      return yield* new ProcessExitError({
        command: "tmux",
        args: ["attach-session", "-t", `=${name}`],
        stdout: "",
        stderr: "",
        exitCode,
      });
    }
  });
}

function listPanesImpl(sessionName: string) {
  return Effect.orElseSucceed(
    execProcess("tmux", [
      "list-panes",
      "-s",
      "-t",
      `=${sessionName}`,
      "-F",
      "#{pane_id}\t#{pane_index}\t#{pane_current_command}\t#{window_name}\t#{window_zoomed_flag}\t#{pane_active}",
    ]).pipe(Effect.map((result) => parsePaneListOutput(result.stdout.trim()))),
    () => [] as TmuxPaneInfo[],
  );
}

function listClientsImpl() {
  return Effect.orElseSucceed(
    execProcess("tmux", [
      "list-clients",
      "-F",
      "#{client_tty}\t#{client_session}",
    ]).pipe(
      Effect.map((result) => parseClientListOutput(result.stdout.trim())),
    ),
    () => [] as TmuxClient[],
  );
}

function detachClientImpl(clientTty: string) {
  return execProcess("tmux", ["detach-client", "-t", clientTty]).pipe(
    Effect.asVoid,
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

export type TmuxServiceImplementation = ServiceImplementation<
  TmuxService,
  BunServices.BunServices
>;

export const liveTmuxService: TmuxServiceImplementation = {
  listSessions: Effect.mapError(listSessionsImpl(), (error) =>
    commandError("tmux_error", "Failed to list tmux sessions", error),
  ),
  sessionExists: (name) =>
    Effect.mapError(sessionExistsImpl(name), (error) =>
      commandError(
        "tmux_error",
        `Failed to check tmux session '${name}'`,
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
        `Failed to stop tmux session: ${getProcessErrorMessage(error)}`,
        error,
      ),
    ),
  getCurrentSession: Effect.mapError(getCurrentSessionImpl, (error) =>
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
  listClients: Effect.mapError(listClientsImpl(), (error) =>
    commandError("tmux_error", "Failed to list tmux clients", error),
  ),
  detachClient: (clientTty) =>
    Effect.mapError(detachClientImpl(clientTty), (error) =>
      commandError("tmux_error", "Failed to detach tmux client", error),
    ),
  switchClientToPane: (clientTty, target) =>
    Effect.mapError(switchClientToPaneImpl(clientTty, target), (error) =>
      commandError(
        "tmux_error",
        `Failed to switch client to '${target}'`,
        error,
      ),
    ),
  togglePaneZoom: (paneId) =>
    Effect.mapError(togglePaneZoomImpl(paneId), (error) =>
      commandError(
        "tmux_error",
        `Failed to toggle zoom for pane '${paneId}': ${getProcessErrorMessage(error)}`,
        error,
      ),
    ),
  killPane: (paneId) =>
    Effect.mapError(killPaneImpl(paneId), (error) =>
      commandError(
        "tmux_error",
        `Failed to kill pane '${paneId}': ${getProcessErrorMessage(error)}`,
        error,
      ),
    ),
};

export function makeTmuxService(
  implementation: TmuxServiceImplementation = liveTmuxService,
) {
  return captureBunService<TmuxService>(implementation);
}
