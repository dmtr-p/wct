import { Schema } from "effect";
import { ResolvedConfigSchema, SetupCommandSchema } from "../config/schema";
import {
  Counter,
  ExecutionId,
  HostPath,
  OperationGeneration,
  OperationId,
  Positive,
  RequestId,
  RuntimeRef,
  Text,
  WorkspaceRef,
} from "./identity";

export const LifecycleCommand = Schema.Union([
  Schema.TaggedStruct("OpenWorkspace", {
    base: Schema.NullOr(Text),
    existing: Schema.Boolean,
    pr: Schema.NullOr(Text),
  }),
  Schema.TaggedStruct("StartWorkspace", {}),
  Schema.TaggedStruct("StopWorkspace", {}),
  Schema.TaggedStruct("CloseWorkspace", { force: Schema.Boolean }),
]);
const EnvironmentName = Text.check(Schema.isPattern(/^[^=\0]+$/));
export const Environment = Schema.Record(
  EnvironmentName,
  Schema.String.check(Schema.isPattern(/^[^\0]*$/)),
);
export const ExecutionContext = Schema.Struct({
  mode: Schema.Literals(["caller-shell", "host"]),
  executionUser: Text,
  cwd: HostPath,
  environment: Environment,
  configuration: Schema.Struct({
    profile: Schema.NullOr(Text),
    resolved: ResolvedConfigSchema,
  }),
});
export const OperationRequest = Schema.Struct({
  requestId: RequestId,
  target: WorkspaceRef,
  command: LifecycleCommand,
  execution: ExecutionContext,
});
export type OperationRequest = typeof OperationRequest.Type;

export const OperationStatus = Schema.Literals([
  "waiting",
  "running",
  "cancel-requested",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "outcome-unknown",
]);
export const LifecyclePhase = Schema.Union([
  Schema.TaggedStruct("Waiting", {
    blockingOperationId: Schema.NullOr(OperationId),
  }),
  Schema.TaggedStruct("Preparing", {}),
  Schema.TaggedStruct("CreatingWorktree", {}),
  Schema.TaggedStruct("CopyingFiles", {}),
  Schema.TaggedStruct("RunningSetup", { name: SetupCommandSchema.fields.name }),
  Schema.TaggedStruct("RunningDown", { name: SetupCommandSchema.fields.name }),
  Schema.TaggedStruct("StartingTmuxSession", {}),
  Schema.TaggedStruct("StoppingTmuxSession", {}),
  Schema.TaggedStruct("RemovingWorktree", {}),
  Schema.TaggedStruct("Validating", {}),
]);
export const OperationRef = Schema.Struct({
  hostId: WorkspaceRef.fields.hostId,
  operationId: OperationId,
});
export const WorkspaceOperationFence = Schema.Struct({
  target: WorkspaceRef,
  operationId: OperationId,
  generation: OperationGeneration,
});
export type WorkspaceOperationFence = typeof WorkspaceOperationFence.Type;
export function sameOperationFence(
  a: WorkspaceOperationFence,
  b: WorkspaceOperationFence,
): boolean {
  return (
    a.operationId === b.operationId &&
    a.generation === b.generation &&
    a.target.hostId === b.target.hostId &&
    a.target.mainRepoPath === b.target.mainRepoPath &&
    a.target.branch === b.target.branch
  );
}
export const OperationRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  ...OperationRef.fields,
  request: OperationRequest,
  acceptedAt: Counter,
  updatedAt: Counter,
  acceptedRuntime: RuntimeRef,
  ownership: WorkspaceOperationFence,
  status: OperationStatus,
  // Optional additions keep the initial durable v1 record decodable.
  phase: Schema.optional(LifecyclePhase),
  diagnostic: Schema.optional(
    Schema.Struct({
      id: Text,
      bytes: Counter,
      truncated: Schema.Boolean,
      expiresAt: Counter,
    }),
  ),
  failure: Schema.optional(Schema.Struct({ code: Text, message: Text })),
}).check(
  Schema.makeFilter(
    (record) =>
      record.hostId === record.request.target.hostId &&
      record.hostId === record.acceptedRuntime.hostId &&
      record.ownership.operationId === record.operationId &&
      record.ownership.target.hostId === record.hostId &&
      record.ownership.target.mainRepoPath ===
        record.request.target.mainRepoPath &&
      record.ownership.target.branch === record.request.target.branch,
  ),
);
export const OperationReceipt = Schema.Struct({
  ...OperationRef.fields,
  requestId: RequestId,
  acceptedAt: Counter,
  deduplicateUntil: Counter,
});
export const CancelOperation = Schema.Struct({
  ...OperationRef.fields,
  requestId: RequestId,
  scope: Schema.Literals(["wait", "operation"]),
});
export const CancelResult = Schema.Struct({ status: OperationStatus });
export const ReconcileOperation = Schema.Struct({
  runtime: RuntimeRef,
  requestId: RequestId,
  expectedOwnership: WorkspaceOperationFence,
  resolution: Schema.Literal("release-after-inspection"),
  acknowledgeUncertainSideEffects: Schema.Literal(true),
  reason: Text,
});

export const ExecutorFence = Schema.Struct({
  runtime: RuntimeRef,
  ownership: WorkspaceOperationFence,
  executionId: ExecutionId,
});
export const ScriptPlan = Schema.Struct({
  fence: ExecutorFence,
  step: Counter,
  kind: Schema.Literals(["setup", "down"]),
  cwd: HostPath,
  environment: Environment,
  command: SetupCommandSchema,
});
export const ExecutorMessage = Schema.Union([
  Schema.TaggedStruct("ScriptStarted", {
    fence: ExecutorFence,
    step: Counter,
    pid: Positive,
    processStart: Text,
  }),
  Schema.TaggedStruct("ScriptCompleted", {
    fence: ExecutorFence,
    step: Counter,
    exitCode: Schema.Int,
    diagnosticId: Schema.NullOr(Text),
  }),
  Schema.TaggedStruct("ScriptAbandoned", {
    fence: ExecutorFence,
    step: Counter,
    reason: Text,
  }),
]);

// Compare decoded requests. Record key order is immaterial; array/script order is material.
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  return value;
}

export function compareReceipt(
  stored: OperationRequest,
  incoming: OperationRequest,
): "different-request" | "duplicate" | "conflict" {
  if (
    stored.target.hostId !== incoming.target.hostId ||
    stored.requestId !== incoming.requestId
  )
    return "different-request";
  return JSON.stringify(canonicalValue(stored)) ===
    JSON.stringify(canonicalValue(incoming))
    ? "duplicate"
    : "conflict";
}
