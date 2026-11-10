import type { BunServices } from "@effect/platform-bun";
import { Config, Context, Effect } from "effect";
import type { TmuxConfig, TmuxWindow } from "../config/schema";
import { loadRuntimeConfig } from "../effect/config";
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
import {
  canonicalSessionTarget,
  selectWorkspaceSession,
  sessionIdentity,
  type SessionOwnership,
  type WorkspaceSession,
  workspaceSessionName,
  type WorkspaceSessionTarget,
} from "./session-identity";
export { formatSessionName } from "./session-identity";

export interface TmuxSession extends WorkspaceSession {
  name: string;
  attached: boolean;
  windows: number;
}

export interface TmuxPaneInfo {
  paneId: string;
  paneIndex: number;
  command: string;
  window: string;
  title?: string;
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
  resolveSession: (
    target: WorkspaceSessionTarget,
    expected?: WorkspaceSession | null,
  ) => Effect.Effect<TmuxSession | null, WctError>;
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
    const [summary = "", id, server] = line.split("\t");
    const [name = "", attached, windows] = summary.split(":");
    return {
      name,
      attached: attached === "1",
      windows: parseInt(windows ?? "0", 10),
      ...(id && /^\$\d+$/.test(id) && server ? { id, server } : {}),
    };
  });
}

export function parsePaneListOutput(output: string): TmuxPaneInfo[] {
  if (!output) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [pid, pIdx, cmd, win, zoom, active, ...title] = line.split("\t");
      return pid
        ? [
            {
              paneId: pid,
              paneIndex: Number(pIdx),
              command: cmd || "",
              window: win || "",
              ...(title.length ? { title: title.join("\t") } : {}),
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

export function parseSessionVariable(
  key: string,
  output: string,
): string | undefined {
  if (output === `-${key}\n`) return undefined;
  const prefix = `${key}=`;
  if (!output.startsWith(prefix) || !output.endsWith("\n"))
    throw commandError(
      "tmux_error",
      `Malformed tmux session environment entry '${key}'`,
    );
  return output.slice(prefix.length, -1);
}

function readSessionVariable(id: string, key: string) {
  return execProcess("tmux", ["show-environment", "-t", id, key]).pipe(
    Effect.flatMap(({ stdout }) =>
      Effect.try({
        try: () => parseSessionVariable(key, stdout),
        catch: (error) =>
          commandError(
            "tmux_error",
            `Cannot read session environment '${key}'`,
            error,
          ),
      }),
    ),
    Effect.catchIf(
      (error) =>
        error instanceof ProcessExitError &&
        error.exitCode === 1 &&
        error.cause === undefined &&
        error.stderr.trim() === `unknown variable: ${key}`,
      () => Effect.undefined,
    ),
  );
}

function readSessionOwnership(id: string) {
  return Effect.all({
    identity: readSessionVariable(id, "WCT_WORKSPACE_ID"),
    mainRepoPath: readSessionVariable(id, "WCT_MAIN_DIR"),
    branch: readSessionVariable(id, "WCT_BRANCH"),
    worktreePath: readSessionVariable(id, "WCT_WORKTREE_DIR"),
  });
}

function noTmuxSessions(error: unknown): boolean {
  return (
    error instanceof ProcessExitError &&
    error.exitCode === 1 &&
    error.cause === undefined &&
    /^(?:no sessions|no server running on [^\r\n]+|error connecting to [^\r\n]+ \((?:No such file or directory|Connection refused)\))$/.test(
      error.stderr.trim(),
    )
  );
}

function listSessionsImpl() {
  return Effect.gen(function* () {
    const result = yield* execProcess("tmux", [
      "list-sessions",
      "-F",
      "#{session_name}:#{session_attached}:#{session_windows}\t#{session_id}\t#{socket_path}|#{pid}|#{start_time}",
    ]);
    return yield* Effect.forEach(
      parseSessionListOutput(result.stdout.trim()),
      (session) =>
        Effect.gen(function* () {
          if (!session.id) return session;
          // Read keys separately: a different variable's multiline value must
          // never be interpreted as Workspace ownership evidence.
          let ownership: SessionOwnership = yield* readSessionOwnership(
            session.id,
          );
          if (
            ownership.mainRepoPath &&
            ownership.worktreePath &&
            ownership.branch !== undefined
          ) {
            const target = yield* canonicalSessionTarget({
              mainRepoPath: ownership.mainRepoPath,
              worktreePath: ownership.worktreePath,
              branch: ownership.branch,
            });
            ownership = { ...ownership, ...target };
          }
          return { ...session, ownership };
        }).pipe(Effect.orElseSucceed(() => session)),
      { concurrency: 4 },
    );
  });
}

function resolveSessionImpl(
  target: WorkspaceSessionTarget,
  expected?: WorkspaceSession | null,
) {
  return Effect.gen(function* () {
    const canonical = yield* canonicalSessionTarget(target);
    const sessions = yield* listSessionsImpl().pipe(
      Effect.catchIf(noTmuxSessions, () => Effect.succeed([] as TmuxSession[])),
    );
    const selection = selectWorkspaceSession(sessions, canonical);
    if (selection.type === "conflict")
      return yield* commandError("tmux_error", selection.message);
    const session = selection.type === "owned" ? selection.session : null;
    if (
      session &&
      expected !== undefined &&
      (!expected ||
        session.id !== expected.id ||
        session.server !== expected.server)
    ) {
      return yield* commandError(
        "tmux_error",
        "Workspace tmux session changed after resolution; retry the operation",
      );
    }
    if (session && session.ownership?.identity === undefined && session.id) {
      yield* execProcess("tmux", [
        "set-environment",
        "-t",
        session.id,
        "WCT_WORKSPACE_ID",
        sessionIdentity({
          ...canonical,
          branch: session.ownership?.branch ?? canonical.branch,
        }),
      ]);
    }
    return session;
  }).pipe(
    Effect.mapError((error) =>
      commandError("tmux_error", getProcessErrorMessage(error), error),
    ),
  );
}

function sessionExistsImpl(name: string) {
  return runProcess("tmux", ["has-session", "-t", sessionTarget(name)]).pipe(
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
    | "select-window";
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

  // eslint-disable-next-line typescript/no-non-null-assertion -- guarded by panes.length > 0 check above
  const firstPane = panes[0]!;
  if (firstPane.command) {
    commands.push({
      type: "send-keys",
      args: ["-t", windowTarget, firstPane.command, "Enter"],
    });
  }

  for (let i = 1; i < panes.length; i++) {
    // eslint-disable-next-line typescript/no-non-null-assertion -- index is bounded by loop condition
    const pane = panes[i]!;
    const splitFlag = split === "horizontal" ? "-h" : "-v";

    commands.push({
      type: "split-window",
      args: [splitFlag, "-t", windowTarget, ...envOptionArgs, "-c", workingDir],
    });

    // split-window makes the new pane active; send-keys targets it implicitly.
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
  return Effect.forEach(commands, (command) => executeCommand(command), {
    discard: true,
  });
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

  // eslint-disable-next-line typescript/no-non-null-assertion -- guarded by windows.length === 0 check above
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
    // eslint-disable-next-line typescript/no-non-null-assertion -- index is bounded by loop condition
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

function createSessionImpl(
  name: string,
  workingDir: string,
  config?: TmuxConfig,
  env?: WctEnv,
) {
  return Effect.gen(function* () {
    if (!env)
      return yield* commandError(
        "tmux_error",
        "Workspace environment is required to create a tmux session",
      );
    const target = yield* canonicalSessionTarget({
      mainRepoPath: env.WCT_MAIN_DIR,
      branch: env.WCT_BRANCH,
      worktreePath: env.WCT_WORKTREE_DIR,
    });
    const existing = yield* resolveSessionImpl(target);
    if (existing)
      return { _tag: "AlreadyExists" as const, sessionName: existing.name };
    if (name !== workspaceSessionName(target))
      return yield* commandError(
        "tmux_error",
        "Tmux session name does not match Workspace identity",
      );
    const ownedEnv = {
      ...env,
      WCT_MAIN_DIR: target.mainRepoPath,
      WCT_WORKTREE_DIR: target.worktreePath,
      WCT_WORKSPACE_ID: sessionIdentity(target),
    };
    const commands = buildWindowsPaneCommands(
      name,
      workingDir,
      config?.windows ?? [],
      ownedEnv,
    );
    const first = commands[0];
    if (!first)
      return yield* commandError(
        "tmux_error",
        "Missing tmux session creation command",
      );
    // Only a successful new-session may authorize rollback. Keep all later
    // construction commands on that acquired ID, even if its name is reused.
    const created = yield* execProcess("tmux", [
      first.type,
      ...first.args,
      "-P",
      "-F",
      "#{session_id}",
    ]);
    const id = created.stdout.trim();
    if (!/^\$\d+$/.test(id))
      return yield* commandError(
        "tmux_error",
        "Tmux did not return the acquired session ID",
      );
    const remaining = commands.slice(1).map((command) => ({
      ...command,
      args: command.args.map((argument, index) =>
        command.args[index - 1] === "-t" &&
        (argument === name || argument.startsWith(`${name}:`))
          ? id + argument.slice(name.length)
          : argument,
      ),
    }));
    yield* executeCommands(remaining).pipe(
      Effect.onError(() => Effect.ignore(killSessionImpl(id))),
    );
    return { _tag: "Created" as const, sessionName: name };
  });
}

export function sessionTarget(name: string): string {
  return /^\$\d+$/.test(name) ? name : `=${name}`;
}

function killSessionImpl(name: string) {
  return execProcess("tmux", ["kill-session", "-t", sessionTarget(name)]).pipe(
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

const getCurrentSessionImpl = Effect.gen(function* () {
  const { tmux, pane } = yield* loadRuntimeConfig(
    Config.all({
      tmux: Config.String("TMUX").pipe(Config.withDefault("")),
      pane: Config.String("TMUX_PANE").pipe(Config.withDefault("")),
    }),
  );
  if (!tmux) return null;

  return yield* Effect.orElseSucceed(
    execProcess("tmux", [
      "display-message",
      ...(pane ? ["-t", pane] : []),
      "-p",
      "#S",
    ]).pipe(Effect.map((result) => result.stdout.trim())),
    () => null,
  );
});

function switchSessionImpl(name: string) {
  return execProcess("tmux", ["switch-client", "-t", sessionTarget(name)]).pipe(
    Effect.asVoid,
  );
}

function attachSessionImpl(name: string) {
  return Effect.gen(function* () {
    const exitCode = yield* spawnInteractive("tmux", [
      "attach-session",
      "-t",
      sessionTarget(name),
    ]);

    if (exitCode !== 0) {
      return yield* new ProcessExitError({
        command: "tmux",
        args: ["attach-session", "-t", sessionTarget(name)],
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
      sessionTarget(sessionName),
      "-F",
      "#{pane_id}\t#{pane_index}\t#{pane_current_command}\t#{window_name}\t#{window_zoomed_flag}\t#{pane_active}\t#{pane_title}",
    ]).pipe(Effect.map((result) => parsePaneListOutput(result.stdout))),
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
  listSessions: listSessionsImpl().pipe(Effect.orElseSucceed(() => null)),
  sessionExists: sessionExistsImpl,
  resolveSession: resolveSessionImpl,
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
  getCurrentSession: getCurrentSessionImpl,
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
  listPanes: listPanesImpl,
  listClients: listClientsImpl(),
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
