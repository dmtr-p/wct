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
  sameTmuxServer,
  SessionRef,
  TerminalStreamId,
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

export const TerminalConnectionRef = Schema.Struct({
  ref: AttachmentRef,
  streamId: TerminalStreamId,
});
export type TerminalConnectionRef = typeof TerminalConnectionRef.Type;
export const IssueTerminalTicket = Schema.Struct({
  ref: AttachmentRef,
  requestId: RequestId,
});
export const TerminalTicket = Schema.Struct({
  connection: TerminalConnectionRef,
  requestId: RequestId,
  ticket: Text,
  expiresAt: Counter,
});

// Terminal metadata/control is framed only on the per-attachment connector.
const TerminalDataHeader = Schema.Struct({
  ...TerminalConnectionRef.fields,
  session: SessionRef,
  sequence: Counter,
  kind: Schema.Literals(["input", "output"]),
  byteLength: Counter,
});
export const TerminalAck = Schema.Struct({
  ...TerminalConnectionRef.fields,
  session: SessionRef,
  sequence: Counter,
  kind: Schema.Literal("ack"),
  byteLength: Schema.Literal(0),
});
export type TerminalAck = typeof TerminalAck.Type;
export const TerminalTargetChanged = Schema.Struct({
  ...TerminalConnectionRef.fields,
  target: WorkspaceSessionRef,
  sequence: Counter,
  kind: Schema.Literal("target"),
  byteLength: Schema.Literal(0),
}).check(
  Schema.makeFilter(
    (frame) =>
      frame.ref.runtime.hostId === frame.target.workspace.hostId &&
      frame.ref.runtime.runtimeGeneration ===
        frame.target.session.server.runtimeGeneration,
  ),
);
export const TerminalFrameHeader = Schema.Union([
  TerminalDataHeader,
  TerminalAck,
  TerminalTargetChanged,
]);
export type TerminalFrameHeader = typeof TerminalFrameHeader.Type;
export function acceptsTerminalFrame(
  current: TerminalConnectionRef & {
    session: SessionRef;
    nextSequence: number;
  },
  frame: TerminalFrameHeader,
): boolean {
  return (
    frame.kind !== "ack" &&
    sameAttachment(current.ref, frame.ref) &&
    current.streamId === frame.streamId &&
    (frame.kind === "target"
      ? sameTmuxServer(current.session.server, frame.target.session.server)
      : sameSession(current.session, frame.session)) &&
    current.nextSequence === frame.sequence
  );
}
export function acceptsTerminalAck(
  current: TerminalConnectionRef & {
    session: SessionRef;
    lastAcknowledgedSequence: number | null;
    lastOutputSequence: number | null;
  },
  ack: TerminalAck,
): boolean {
  return (
    sameAttachment(current.ref, ack.ref) &&
    current.streamId === ack.streamId &&
    sameSession(current.session, ack.session) &&
    current.lastOutputSequence !== null &&
    ack.sequence <= current.lastOutputSequence &&
    (current.lastAcknowledgedSequence === null ||
      ack.sequence > current.lastAcknowledgedSequence)
  );
}
export const TerminalConnectorHello = Schema.Struct({
  connection: TerminalConnectionRef,
  ticket: Text,
});
