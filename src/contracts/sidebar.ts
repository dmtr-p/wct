import { Schema } from "effect";
import {
  Counter,
  HostPath,
  OperationId,
  RuntimeRef,
  sameRuntime,
  Text,
  WorkspaceRef,
  WorkspaceSessionRef,
} from "./identity";
import { LifecyclePhase, OperationStatus } from "./operations";

export const RepositorySummary = Schema.Struct({
  mainRepoPath: HostPath,
  displayName: Text,
});
export const WorkspaceSummary = Schema.Struct({
  ref: WorkspaceRef,
  worktreePath: Schema.NullOr(HostPath),
  session: Schema.NullOr(WorkspaceSessionRef),
  operation: Schema.NullOr(
    Schema.Struct({
      operationId: OperationId,
      status: OperationStatus,
      phase: Schema.NullOr(LifecyclePhase),
    }),
  ),
  pr: Schema.NullOr(
    Schema.Struct({
      baseRepository: Text,
      number: Counter.check(Schema.isGreaterThan(0)),
      state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
      checks: Schema.Literals(["passed", "failed", "pending", "unknown"]),
    }),
  ),
  agents: Schema.Struct({
    blocked: Counter,
    working: Counter,
    idle: Counter,
    unknown: Counter,
  }),
  freshness: Schema.Literals(["fresh", "stale", "unavailable"]),
});
export const SidebarCursor = Schema.Struct({
  runtime: RuntimeRef,
  revision: Counter,
});
export type SidebarCursor = typeof SidebarCursor.Type;
export const SidebarSnapshot = Schema.TaggedStruct("Snapshot", {
  cursor: SidebarCursor,
  repositories: Schema.Array(RepositorySummary),
  workspaces: Schema.Array(WorkspaceSummary),
});
export const SidebarDelta = Schema.TaggedStruct("Delta", {
  cursor: SidebarCursor,
  previousRevision: Counter,
  changes: Schema.Array(
    Schema.Union([
      Schema.TaggedStruct("UpsertRepository", { value: RepositorySummary }),
      Schema.TaggedStruct("RemoveRepository", { mainRepoPath: HostPath }),
      Schema.TaggedStruct("UpsertWorkspace", { value: WorkspaceSummary }),
      Schema.TaggedStruct("RemoveWorkspace", { ref: WorkspaceRef }),
    ]),
  ),
}).check(
  Schema.makeFilter(
    (delta) => delta.cursor.revision === delta.previousRevision + 1,
  ),
);
export type SidebarDelta = typeof SidebarDelta.Type;
export const SidebarEvent = Schema.Union([
  SidebarSnapshot,
  SidebarDelta,
  Schema.TaggedStruct("ResyncRequired", {
    runtime: RuntimeRef,
    reason: Schema.Literals([
      "gap",
      "epoch-changed",
      "slow-consumer",
      "retention",
    ]),
  }),
]);
export const SidebarSubscription = Schema.Struct({
  runtime: RuntimeRef,
  after: Schema.NullOr(SidebarCursor),
});

export function acceptsDelta(
  cursor: SidebarCursor,
  delta: SidebarDelta,
): boolean {
  return (
    sameRuntime(cursor.runtime, delta.cursor.runtime) &&
    cursor.revision === delta.previousRevision &&
    delta.cursor.revision === cursor.revision + 1
  );
}
