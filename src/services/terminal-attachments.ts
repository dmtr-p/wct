import { Effect } from "effect";
import { SecureRandom } from "effect/crypto";
import { commandError } from "../errors";
import { execProcess } from "./process";
import type { WorkspaceSessionTarget } from "./session-identity";
import type { TmuxSession } from "./tmux";

export type AttachmentKind = "browser" | "observer";

export interface TerminalAttachment {
  id: string;
  generation: string;
  kind: AttachmentKind;
  server: string;
}

export interface TmuxClient {
  tty: string;
  session: string;
  name?: string;
  pid?: string;
  created?: string;
  server?: string;
  sessionId?: string;
  connectionMarker?: string;
  /** Present only after the live client and its server record agree. */
  attachment?: TerminalAttachment;
}

interface ObservedClient extends TmuxClient {
  marker?: string;
}

export interface AttachmentLaunch {
  attachment: TerminalAttachment;
  command: "tmux";
  args: string[];
  env: Record<string, string>;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MARKER_PATTERN = new RegExp(
  `^wct1:(browser|observer):(${UUID}):(${UUID})$`,
);
const MARKER_ENV = "WCT_TERMINAL_ATTACHMENT";
export const SERVER_FORMAT = "#{socket_path}|#{pid}|#{start_time}";
const IDENTITY_FORMAT = `${SERVER_FORMAT}\t#{client_name}\t#{client_tty}\t#{client_pid}\t#{client_created}`;

// Unlike I/e, V/c also works for control-mode clients without a terminal.
export function clientEnvironmentFormat(key: string): string {
  return `#{V/c:#{?#{==:#{environ_name},${key}},#{environ_value},}}`;
}
const SESSION_ID_FORMAT =
  "#{S:#{?#{==:#{session_name},#{client_session}},#{session_id},}}";
const MARKER_FORMAT = clientEnvironmentFormat(MARKER_ENV);
const CLIENT_FIELDS_FORMAT = `#{client_tty}\t#{client_session}\t${IDENTITY_FORMAT}\t#{session_id}\t`;
export const CLIENTS_FORMAT = `#{L:#{client_tty}\t#{client_session}\t${IDENTITY_FORMAT}\t${SESSION_ID_FORMAT}\t${MARKER_FORMAT}\n}`;

function marker(attachment: TerminalAttachment): string {
  return `wct1:${attachment.kind}:${attachment.id}:${attachment.generation}`;
}
function recordKey(attachment: TerminalAttachment): string {
  return `@wct_attachment_${attachment.id}`;
}
function parseMarker(
  value: string,
  server: string,
): TerminalAttachment | undefined {
  const match = MARKER_PATTERN.exec(value);
  if (!match) return undefined;
  const [, kind, id, generation] = match;
  if ((kind !== "browser" && kind !== "observer") || !id || !generation)
    return undefined;
  return { id, generation, kind, server };
}
function validAttachment(attachment: TerminalAttachment): boolean {
  return (
    !!parseMarker(marker(attachment), attachment.server) && !!attachment.server
  );
}
function identity(client: TmuxClient): string | undefined {
  if (
    !client.server ||
    !client.name ||
    !/^\d+$/.test(client.pid ?? "") ||
    !/^\d+$/.test(client.created ?? "")
  )
    return undefined;
  return [
    client.server,
    client.name,
    client.tty,
    client.pid,
    client.created,
  ].join("\t");
}
function record(attachment: TerminalAttachment, client: TmuxClient): string {
  return `${marker(attachment)}\t${identity(client)}`;
}

function recordedClient(
  value: string,
  attachment: TerminalAttachment,
): TmuxClient | undefined {
  const [token, server, name, tty, pid, created, ...extra] = value.split("\t");
  if (
    extra.length ||
    token !== marker(attachment) ||
    server !== attachment.server ||
    tty === undefined
  )
    return undefined;
  const client = { server, name, tty, pid, created, session: "", attachment };
  return identity(client) ? client : undefined;
}

// L omits suspended/exiting clients. A live PID is a reason to retain a
// bound record, never evidence authorizing client classification or mutation.
function processMayExist(pid: string) {
  return Effect.sync(() => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch (error) {
      return !(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      );
    }
  });
}

export function parseAttachmentClients(output: string): ObservedClient[] {
  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [
        tty,
        session,
        server,
        name,
        actualTty,
        pid,
        created,
        sessionId,
        token,
      ] = line.split("\t");
      if (
        !session ||
        !server ||
        !name ||
        tty === undefined ||
        actualTty !== tty ||
        !/^\d+$/.test(pid ?? "") ||
        !/^\d+$/.test(created ?? "") ||
        !/^\$\d+$/.test(sessionId ?? "")
      )
        return [];
      return [
        {
          tty,
          session,
          server,
          name,
          pid,
          created,
          sessionId,
          marker: token ?? "",
        },
      ];
    });
}

function tmux(args: string[], env?: Record<string, string>) {
  return execProcess("tmux", args, {
    maxOutputBytes: 1024 * 1024,
    ...(env ? { env } : {}),
  }).pipe(
    Effect.mapError((error) =>
      commandError(
        "tmux_error",
        "Terminal attachment tmux command failed",
        error,
      ),
    ),
  );
}

// These strings are tmux commands/formats, never shell programs. Quoting and
// literal format escaping are separate because tmux parses and expands both.
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function literal(value: string): string {
  return value
    .replaceAll("#", "##")
    .replaceAll(",", "#,")
    .replaceAll("}", "#}");
}
function equals(format: string, value: string): string {
  return `#{==:${format},${literal(value)}}`;
}
function and(...conditions: string[]): string {
  return conditions.reduce((left, right) => `#{&&:${left},${right}}`, "1");
}
function command(args: string[]): string {
  return args.map(quote).join(" ");
}
function guarded(condition: string, args: string[], after: string[][] = []) {
  const body = [args, ...after, ["display-message", "-p", "wct-ok"]]
    .map(command)
    .join(" ; ");
  return tmux([
    "if-shell",
    "-F",
    condition,
    body,
    command(["display-message", "-p", "wct-stale"]),
  ]).pipe(
    Effect.flatMap(({ stdout }) =>
      stdout.trim() === "wct-ok"
        ? Effect.void
        : Effect.fail(
            commandError(
              "tmux_error",
              "Tmux client or attachment changed; rediscover before retrying",
            ),
          ),
    ),
  );
}

function clientCondition(
  client: TmuxClient,
  token: string,
  expectedRecord?: string,
): string {
  const attached = client.attachment;
  return `#{L:#{?${and(
    equals(IDENTITY_FORMAT, identity(client) ?? ""),
    equals(MARKER_FORMAT, token),
    ...(attached && expectedRecord
      ? [equals(`#{${recordKey(attached)}}`, expectedRecord)]
      : []),
  )},1,}}`;
}

function probeClientFormats() {
  return Effect.gen(function* () {
    const nonce = yield* Effect.sync(() => SecureRandom.uuidV4Unsafe());
    const result = yield* tmux(
      [
        "display-message",
        "-p",
        `${SERVER_FORMAT}\t${clientEnvironmentFormat("WCT_ATTACHMENT_PROBE")}`,
      ],
      { WCT_ATTACHMENT_PROBE: nonce },
    );
    const [server, returned] = result.stdout.replace(/\n$/, "").split("\t");
    return { server, supported: returned === nonce };
  });
}

function readRecord(attachment: TerminalAttachment) {
  return tmux(["show-options", "-s", "-qv", recordKey(attachment)]).pipe(
    Effect.map(({ stdout }) => stdout.replace(/\n$/, "")),
  );
}

// Explicit client names can be shadowed by an older suspended client on the
// same tty. Inspect the actual name resolution in every session because tmux
// otherwise substitutes a session's best client for display-message formats.
function preflightClientTarget(client: TmuxClient) {
  return Effect.gen(function* () {
    const sessions = yield* tmux(["list-sessions", "-F", "#{session_id}"]);
    let found = false;
    for (const session of sessions.stdout.trim().split("\n")) {
      if (!/^\$\d+$/.test(session))
        return yield* commandError(
          "tmux_error",
          "Cannot inspect tmux client target sessions",
        );
      const inspection = yield* tmux([
        "display-message",
        "-p",
        "-c",
        client.name ?? client.tty,
        "-t",
        session,
        IDENTITY_FORMAT,
      ]);
      const value = inspection.stdout.replace(/\n$/, "");
      if (value.split("\t")[1] !== client.name) continue;
      if (value !== identity(client))
        return yield* commandError(
          "tmux_error",
          "Tmux client target is shadowed by another connection; detach the other client before retrying",
        );
      found = true;
    }
    if (!found)
      return yield* commandError(
        "tmux_error",
        "Tmux client target disappeared; rediscover before retrying",
      );
  });
}

export const listAttachmentClients = Effect.gen(function* () {
  const capability = yield* probeClientFormats();
  // tmux 3.2 has neither client loops nor client environment formats. Keep
  // its native discovery on list-clients, where each row has its own session.
  const { stdout } = yield* tmux(
    capability.supported
      ? ["display-message", "-p", CLIENTS_FORMAT]
      : ["list-clients", "-F", CLIENT_FIELDS_FORMAT],
  );
  return yield* Effect.forEach(
    parseAttachmentClients(stdout),
    (client) =>
      Effect.gen(function* () {
        const { marker: token, ...plain } = client;
        const attachment = parseMarker(token ?? "", client.server ?? "");
        if (!attachment) return { ...plain, connectionMarker: token ?? "" };
        const stored = yield* tmux([
          "show-options",
          "-s",
          "-qv",
          recordKey(attachment),
        ]);
        return stored.stdout === `${record(attachment, client)}\n`
          ? { ...plain, attachment }
          : { ...plain, connectionMarker: token ?? "" };
      }),
    { concurrency: 4 },
  );
});

/** Native actions revalidate the observed connection in the same tmux queue. */
export function nativeClientAction(client: TmuxClient, target?: string) {
  if (!identity(client) || client.attachment)
    return Effect.fail(
      commandError("tmux_error", "A verified native tmux client is required"),
    );
  const action =
    target === undefined
      ? ["detach-client", "-t", client.name ?? client.tty]
      : ["switch-client", "-c", client.name ?? client.tty, "-t", target];
  return Effect.gen(function* () {
    const capability = yield* probeClientFormats();
    if (capability.server !== client.server)
      return yield* commandError(
        "tmux_error",
        "Native tmux server changed; rediscover before retrying",
      );
    yield* preflightClientTarget(client);
    if (capability.supported) {
      yield* guarded(
        clientCondition(client, client.connectionMarker ?? ""),
        action,
      );
    } else {
      const snapshot = yield* tmux([
        "list-clients",
        "-F",
        CLIENT_FIELDS_FORMAT,
      ]);
      if (
        !parseAttachmentClients(snapshot.stdout).some(
          (current) => identity(current) === identity(client),
        )
      )
        return yield* commandError(
          "tmux_error",
          "Native tmux client disappeared; rediscover before retrying",
        );
      // Older servers cannot create wct attachments. Preserve their existing
      // explicit native target after preflight without unsupported formats.
      yield* tmux(action);
    }
  });
}

type ResolveSession = (
  target: WorkspaceSessionTarget,
) => Effect.Effect<
  TmuxSession | null,
  import("../errors").WctError,
  import("@effect/platform-bun").BunServices.BunServices
>;

export function prepareAttachment(
  target: WorkspaceSessionTarget,
  kind: AttachmentKind,
  resolve: ResolveSession,
) {
  return Effect.gen(function* () {
    const session = yield* resolve(target);
    if (!session?.id || !session.server)
      return yield* commandError(
        "tmux_error",
        "A verified Workspace Session is required for an attachment",
      );
    return yield* prepareSessionAttachment(
      { id: session.id, server: session.server },
      kind,
    );
  });
}

/** Caller verifies ownership; this primitive fences the exact live server/session at launch. */
export function prepareSessionAttachment(
  session: { id: string; server: string },
  kind: AttachmentKind,
) {
  return Effect.gen(function* () {
    if (!/^\$\d+$/.test(session.id) || !session.server)
      return yield* commandError("tmux_error", "Invalid attachment session");
    const capability = yield* probeClientFormats();
    if (!capability.supported || capability.server !== session.server)
      return yield* commandError(
        "tmux_error",
        "Managed terminal attachments require tmux client-environment formats (V/c); this server does not support them or changed during the probe",
      );
    const attachment: TerminalAttachment = {
      id: yield* Effect.sync(() => SecureRandom.uuidV4Unsafe()),
      generation: yield* Effect.sync(() => SecureRandom.uuidV4Unsafe()),
      kind,
      server: session.server ?? "",
    };
    const token = marker(attachment);
    const pending = `${token}\t${attachment.server}\tpending`;
    yield* guarded(equals(SERVER_FORMAT, attachment.server), [
      "set-option",
      "-so",
      recordKey(attachment),
      pending,
    ]);
    const body = [
      [
        "attach-session",
        "-E",
        ...(kind === "observer" ? ["-f", "ignore-size,read-only"] : []),
        "-t",
        session.id,
      ],
      [
        "set-option",
        "-sF",
        recordKey(attachment),
        `${token}\t${IDENTITY_FORMAT}`,
      ],
    ]
      .map(command)
      .join(" ; ");
    // Recheck the actual server and launching client's nonce at execution time.
    // Nothing is attached or recorded on the unsupported/stale branch.
    return {
      attachment,
      command: "tmux" as const,
      args: [
        "if-shell",
        "-F",
        and(
          equals(SERVER_FORMAT, attachment.server),
          equals(`#{S:#{?${equals("#{session_id}", session.id)},1,}}`, "1"),
          equals(MARKER_FORMAT, token),
          equals(`#{${recordKey(attachment)}}`, pending),
        ),
        body,
        command([
          "display-message",
          "-p",
          "wct: attachment server or capability changed; prepare a fresh attachment",
        ]),
      ],
      env: { [MARKER_ENV]: token },
    } satisfies AttachmentLaunch;
  });
}

export function queryAttachment(attachment: TerminalAttachment) {
  if (!validAttachment(attachment))
    return Effect.fail(
      commandError("tmux_error", "Invalid terminal attachment reference"),
    );
  return Effect.gen(function* () {
    const clients = yield* listAttachmentClients;
    const client = clients.find(
      (client) =>
        client.attachment &&
        marker(client.attachment) === marker(attachment) &&
        client.server === attachment.server,
    );
    if (client) return client;
    const stored = yield* readRecord(attachment);
    const bound = recordedClient(stored, attachment);
    if (bound?.pid && (yield* processMayExist(bound.pid)))
      return yield* commandError(
        "tmux_error",
        "Attachment client is unavailable or suspended; resume it or wait for its process to exit before retrying",
      );
    return null;
  });
}

export function switchAttachment(
  attachment: TerminalAttachment,
  target: WorkspaceSessionTarget,
  resolve: ResolveSession,
) {
  return Effect.gen(function* () {
    const client = yield* queryAttachment(attachment);
    const session = yield* resolve(target);
    if (!client || !session?.id || session.server !== attachment.server)
      return yield* commandError(
        "tmux_error",
        "Attachment or Workspace Session is no longer available on the expected tmux server",
      );
    yield* preflightClientTarget(client);
    yield* guarded(
      clientCondition(client, marker(attachment), record(attachment, client)),
      [
        "switch-client",
        "-E",
        "-c",
        client.name ?? client.tty,
        "-t",
        session.id,
      ],
    );
    return yield* queryAttachment(attachment);
  });
}

export function detachAttachment(attachment: TerminalAttachment) {
  return Effect.gen(function* () {
    const client = yield* queryAttachment(attachment);
    if (client) {
      yield* preflightClientTarget(client);
      yield* guarded(
        clientCondition(client, marker(attachment), record(attachment, client)),
        ["detach-client", "-t", client.name ?? client.tty],
        [["set-option", "-su", recordKey(attachment)]],
      );
      return;
    }
    const value = yield* readRecord(attachment);
    if (!value.startsWith(`${marker(attachment)}\t${attachment.server}\t`))
      return;
    const bound = recordedClient(value, attachment);
    if (bound?.pid && (yield* processMayExist(bound.pid)))
      return yield* commandError(
        "tmux_error",
        "Attachment launch or suspension raced cleanup; wait for its process to exit or retry detachment",
      );
    yield* guarded(
      and(
        equals(SERVER_FORMAT, attachment.server),
        equals(`#{${recordKey(attachment)}}`, value),
        // A prepared launch may have bound its live client since the query.
        // Never erase its classification evidence without detaching it.
        equals(`#{L:#{?${equals(MARKER_FORMAT, marker(attachment))},1,}}`, ""),
      ),
      ["set-option", "-su", recordKey(attachment)],
    );
  });
}
