import { Schema } from "effect";
import {
  AttachmentGeneration,
  AttachmentId,
  Counter,
  Positive,
  RequestId,
  RuntimeRef,
  sameRuntime,
  sameSession,
  SessionRef,
  Text,
  WorkspaceSessionRef,
} from "./identity";

export const Dimensions = Schema.Struct({ cols: Positive, rows: Positive });
export const AttachmentRef = Schema.Struct({
  runtime: RuntimeRef,
  attachmentId: AttachmentId,
  generation: AttachmentGeneration,
});
export type AttachmentRef = typeof AttachmentRef.Type;
export const AttachmentState = Schema.Struct({
  ref: AttachmentRef,
  target: WorkspaceSessionRef,
  dimensions: Dimensions,
  status: Schema.Literals(["attached", "suspended", "closed"]),
}).check(
  Schema.makeFilter(
    (state) =>
      state.ref.runtime.hostId === state.target.workspace.hostId &&
      state.ref.runtime.runtimeGeneration ===
        state.target.session.server.runtimeGeneration,
  ),
);
export const CreateAttachment = Schema.Struct({
  runtime: RuntimeRef,
  requestId: RequestId,
  target: WorkspaceSessionRef,
  dimensions: Dimensions,
}).check(
  Schema.makeFilter(
    (request) =>
      request.runtime.hostId === request.target.workspace.hostId &&
      request.runtime.runtimeGeneration ===
        request.target.session.server.runtimeGeneration,
  ),
);
export const AttachmentControl = Schema.Union([
  Schema.TaggedStruct("Resize", {
    ref: AttachmentRef,
    requestId: RequestId,
    dimensions: Dimensions,
  }),
  Schema.TaggedStruct("SwitchWorkspace", {
    ref: AttachmentRef,
    requestId: RequestId,
    target: WorkspaceSessionRef,
  }),
  Schema.TaggedStruct("Suspend", { ref: AttachmentRef, requestId: RequestId }),
  Schema.TaggedStruct("Resume", { ref: AttachmentRef, requestId: RequestId }),
  Schema.TaggedStruct("CloseAttachment", {
    ref: AttachmentRef,
    requestId: RequestId,
  }),
]);
export const AttachmentControlAck = Schema.Struct({
  requestId: RequestId,
  state: AttachmentState,
});

export function sameAttachment(a: AttachmentRef, b: AttachmentRef): boolean {
  return (
    sameRuntime(a.runtime, b.runtime) &&
    a.attachmentId === b.attachmentId &&
    a.generation === b.generation
  );
}

// The separate terminal connector carries a header followed by raw payload bytes.
// This is metadata only: there is deliberately no bytes field or RPC byte event.
export const TerminalFrameHeader = Schema.Struct({
  ref: AttachmentRef,
  session: SessionRef,
  sequence: Counter,
  kind: Schema.Literals(["input", "output", "ack"]),
  byteLength: Counter,
}).check(
  Schema.makeFilter((frame) => frame.kind !== "ack" || frame.byteLength === 0),
);
export type TerminalFrameHeader = typeof TerminalFrameHeader.Type;
export function acceptsTerminalFrame(
  current: {
    ref: AttachmentRef;
    session: SessionRef;
    nextSequence: number;
  },
  frame: TerminalFrameHeader,
): boolean {
  return (
    sameAttachment(current.ref, frame.ref) &&
    sameSession(current.session, frame.session) &&
    current.nextSequence === frame.sequence
  );
}
export const TerminalConnectorHello = Schema.Struct({
  ref: AttachmentRef,
  ticket: Text,
});
