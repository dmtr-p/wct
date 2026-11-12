import { Schema } from "effect";
import { Counter, Positive, RuntimeRef, StateStoreId, Text } from "./identity";

export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;
export const ProtocolVersion = Schema.Struct({
  major: Positive,
  minor: Counter,
});
export const CAPABILITIES = [
  "workspace-operations-v1",
  "caller-shell-v1",
  "sidebar-v1",
  "terminal-attachments-v1",
] as const;
export const Capability = Schema.Literals(CAPABILITIES);

export const ContractError = Schema.Union([
  Schema.TaggedStruct("IdentityMismatch", {
    expected: StateStoreId,
    actual: StateStoreId,
  }),
  Schema.TaggedStruct("IncompatibleProtocol", {
    client: ProtocolVersion,
    server: ProtocolVersion,
  }),
  Schema.TaggedStruct("MissingCapabilities", {
    capabilities: Schema.Array(Text),
  }),
  Schema.TaggedStruct("HandshakeRequired", {}),
  Schema.TaggedStruct("StaleGeneration", { resource: Text }),
  Schema.TaggedStruct("RequestIdConflict", {}),
  Schema.TaggedStruct("NotFound", { resource: Text }),
  Schema.TaggedStruct("InvalidRequest", { message: Text }),
  Schema.TaggedStruct("PreconditionFailed", { message: Text }),
  Schema.TaggedStruct("CancellationUnavailable", { message: Text }),
  Schema.TaggedStruct("HostOffline", {}),
  Schema.TaggedStruct("ResourceLimit", { resource: Text }),
  Schema.TaggedStruct("PermissionDenied", {}),
  Schema.TaggedStruct("InternalError", { diagnosticId: Text }),
]);
export type ContractError = typeof ContractError.Type;

// Implementations must publish concrete limits; no implicit unlimited/default policy.
export const HostPolicy = Schema.Struct({
  stateFrameBytes: Positive,
  stateSubscriberBytes: Positive,
  stateReplayRevisions: Counter,
  receiptRetentionMs: Positive,
  statusRetentionMs: Positive,
  diagnosticRetentionMs: Positive,
  diagnosticBytes: Positive,
  terminalFrameBytes: Positive,
  terminalQueueBytes: Positive,
  terminalMaxCols: Positive,
  terminalMaxRows: Positive,
  attachmentGraceMs: Counter,
});
export const HostDescriptor = Schema.Struct({
  ...RuntimeRef.fields,
  protocol: ProtocolVersion,
  // Unknown advertisements are ignored, so newer hosts can add capabilities.
  capabilities: Schema.Array(Text),
  executionUser: Text,
  policy: HostPolicy,
});
export type HostDescriptor = typeof HostDescriptor.Type;
export const HandshakeRequest = Schema.Struct({
  expectedHostId: StateStoreId,
  protocol: ProtocolVersion,
  requiredCapabilities: Schema.Array(Capability),
  executionUser: Text,
});
export type HandshakeRequest = typeof HandshakeRequest.Type;
export const NegotiatedProtocol = Schema.Struct({
  runtime: RuntimeRef,
  protocol: ProtocolVersion,
  capabilities: Schema.Array(Capability),
});

export function negotiateProtocol(
  request: HandshakeRequest,
  host: HostDescriptor,
):
  | { ok: true; value: typeof NegotiatedProtocol.Type }
  | { ok: false; error: ContractError } {
  if (request.expectedHostId !== host.hostId)
    return {
      ok: false,
      error: {
        _tag: "IdentityMismatch",
        expected: request.expectedHostId,
        actual: host.hostId,
      },
    };
  if (request.executionUser !== host.executionUser)
    return { ok: false, error: { _tag: "PermissionDenied" } };
  if (request.protocol.major !== host.protocol.major)
    return {
      ok: false,
      error: {
        _tag: "IncompatibleProtocol",
        client: request.protocol,
        server: host.protocol,
      },
    };
  const missing = request.requiredCapabilities.filter(
    (value) => !host.capabilities.includes(value),
  );
  if (missing.length)
    return {
      ok: false,
      error: { _tag: "MissingCapabilities", capabilities: missing },
    };
  return {
    ok: true,
    value: {
      runtime: {
        hostId: host.hostId,
        runtimeGeneration: host.runtimeGeneration,
        daemonEpoch: host.daemonEpoch,
      },
      protocol: {
        major: host.protocol.major,
        minor: Math.min(request.protocol.minor, host.protocol.minor),
      },
      capabilities: CAPABILITIES.filter((value) =>
        host.capabilities.includes(value),
      ),
    },
  };
}
