import { Schema } from "effect";
import { workspaceIdentityKey } from "../services/identities";

export const COMMAND_PARSE_OPTIONS = { onExcessProperty: "error" } as const;
export const Text = Schema.String.check(Schema.isBetweenLength(1, 4096));
export const Counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const Positive = Counter.check(Schema.isGreaterThan(0));
const OpaqueId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/),
);
export const StateStoreId = OpaqueId.pipe(Schema.brand("StateStoreId"));
export const HostRuntimeGeneration = OpaqueId.pipe(
  Schema.brand("HostRuntimeGeneration"),
);
export const DaemonEpoch = OpaqueId.pipe(Schema.brand("DaemonEpoch"));
export const RequestId = OpaqueId.pipe(Schema.brand("RequestId"));
export const OperationId = OpaqueId.pipe(Schema.brand("OperationId"));
export const AttachmentId = OpaqueId.pipe(Schema.brand("AttachmentId"));
export const AttachmentGeneration = OpaqueId.pipe(
  Schema.brand("AttachmentGeneration"),
);
export const ExecutionId = OpaqueId.pipe(Schema.brand("ExecutionId"));
export const OperationGeneration = OpaqueId.pipe(
  Schema.brand("OperationGeneration"),
);

// Host paths are POSIX paths, never gateway paths; NUL remains the local key separator.
export const HostPath = Text.check(Schema.isPattern(/^\/[^\0]*$/));
export const Branch = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.isPattern(/^[^\0]*$/),
);
export const WorkspaceRef = Schema.Struct({
  hostId: StateStoreId,
  mainRepoPath: HostPath,
  branch: Branch,
});
export type WorkspaceRef = typeof WorkspaceRef.Type;

export function hostWorkspaceKey(ref: WorkspaceRef): string {
  return JSON.stringify([
    ref.hostId,
    workspaceIdentityKey(ref.mainRepoPath, ref.branch),
  ]);
}

export const RuntimeRef = Schema.Struct({
  hostId: StateStoreId,
  runtimeGeneration: HostRuntimeGeneration,
  daemonEpoch: DaemonEpoch,
});
export type RuntimeRef = typeof RuntimeRef.Type;

export const TmuxServerRef = Schema.Struct({
  hostId: StateStoreId,
  runtimeGeneration: HostRuntimeGeneration,
  serverId: HostPath,
  // Existing tmux adapter encoding: socket path, NUL, server pid, NUL, start time.
  serverGeneration: Text.check(Schema.isPattern(/^\/[^\0]*\0[1-9]\d*\0\d+$/)),
});
export const SessionRef = Schema.Struct({
  server: TmuxServerRef,
  sessionId: Text.check(Schema.isPattern(/^\$\d+$/)),
});
export type SessionRef = typeof SessionRef.Type;
export const WindowRef = Schema.Struct({
  session: SessionRef,
  windowId: Text.check(Schema.isPattern(/^@\d+$/)),
});
export const PaneRef = Schema.Struct({
  session: SessionRef,
  paneId: Text.check(Schema.isPattern(/^%\d+$/)),
});
export const WorkspaceSessionRef = Schema.Struct({
  workspace: WorkspaceRef,
  worktreePath: HostPath,
  session: SessionRef,
}).check(
  Schema.makeFilter(
    (ref) => ref.workspace.hostId === ref.session.server.hostId,
  ),
);

export function sameRuntime(a: RuntimeRef, b: RuntimeRef): boolean {
  return (
    a.hostId === b.hostId &&
    a.runtimeGeneration === b.runtimeGeneration &&
    a.daemonEpoch === b.daemonEpoch
  );
}

export function sameSession(a: SessionRef, b: SessionRef): boolean {
  return (
    a.server.hostId === b.server.hostId &&
    a.server.runtimeGeneration === b.server.runtimeGeneration &&
    a.server.serverId === b.server.serverId &&
    a.server.serverGeneration === b.server.serverGeneration &&
    a.sessionId === b.sessionId
  );
}

export const StoredIdentity = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  hostId: StateStoreId,
  createdAt: Counter,
});
export const ConfiguredHost = Schema.Struct({
  label: Text,
  expectedHostId: StateStoreId,
  executionUser: Text,
});
