import { Schema } from "effect";
import { Dimensions } from "../contracts/attachments";
import {
  AttachmentGeneration,
  AttachmentId,
  Branch,
  COMMAND_PARSE_OPTIONS,
  Counter,
  HostPath,
  TerminalStreamId,
  Text,
} from "../contracts/identity";

export const policy = {
  bootstrapMs: 5 * 60_000,
  sessionMs: 8 * 60 * 60_000,
  ticketMs: 30_000,
  maxSessions: 32,
  maxTickets: 64,
  maxAttachments: 8,
  dataBytes: 64 * 1024,
  controlBytes: 16 * 1024,
  inputBytes: 256 * 1024,
  outputBytes: 1024 * 1024,
  handshakeMs: 10_000,
  pingMs: 30_000,
  heartbeatMs: 60_000,
  drainMs: 2_000,
  termMs: 2_000,
} as const;

export const LocalDimensions = Dimensions.check(
  Schema.makeFilter(({ cols, rows }) => cols <= 500 && rows <= 200),
);
export const LocalRef = Schema.Struct({
  endpoint: Text,
  attachmentId: AttachmentId,
  generation: AttachmentGeneration,
  server: Text,
});
export type LocalRef = typeof LocalRef.Type;
export const LocalTarget = Schema.Struct({
  mainRepoPath: HostPath,
  worktreePath: HostPath,
  branch: Branch,
  server: Text,
  sessionId: Schema.String.check(Schema.isPattern(/^\$\d+$/)),
});
export type LocalTarget = typeof LocalTarget.Type;
const connection = { ref: LocalRef, streamId: TerminalStreamId };
const data = {
  ...connection,
  target: LocalTarget,
  sequence: Counter,
  byteLength: Counter.check(Schema.isLessThanOrEqualTo(policy.dataBytes)),
};
export const LocalHeader = Schema.Union([
  Schema.Struct({ ...data, kind: Schema.Literals(["input", "output"]) }),
  Schema.Struct({
    ...data,
    kind: Schema.Literal("target"),
    byteLength: Schema.Literal(0),
  }),
]);
export type LocalHeader = typeof LocalHeader.Type;
export const LocalControl = Schema.Struct({
  ...connection,
  target: LocalTarget,
  controlSequence: Counter,
  kind: Schema.Literal("close"),
});
export type LocalControl = typeof LocalControl.Type;
export const CreateLocalAttachment = Schema.Struct({
  dimensions: LocalDimensions,
});
export const Bootstrap = Schema.Struct({
  secret: Schema.String.check(Schema.isMaxLength(128)),
});
export const TicketRequest = Schema.Struct({ ref: LocalRef });
export function decode<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] {
  return Schema.decodeUnknownSync(schema)(value, COMMAND_PARSE_OPTIONS);
}
export function same(a: unknown, b: unknown): boolean {
  // All compared values have first passed the same schema decoder.
  return JSON.stringify(a) === JSON.stringify(b);
}
export function encodeFrame(
  header: LocalHeader,
  bytes: Uint8Array = new Uint8Array(),
): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(header));
  if (json.length > policy.controlBytes || bytes.length !== header.byteLength)
    throw new Error("Invalid terminal frame");
  const frame = new Uint8Array(4 + json.length + bytes.length);
  new DataView(frame.buffer).setUint32(0, json.length);
  frame.set(json, 4);
  frame.set(bytes, 4 + json.length);
  return frame;
}
export function decodeFrame(frame: Uint8Array) {
  if (
    frame.length < 4 ||
    frame.length > 4 + policy.controlBytes + policy.dataBytes
  )
    throw new Error("Terminal frame exceeds bounds");
  const length = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0);
  if (length > policy.controlBytes || frame.length < 4 + length)
    throw new Error("Invalid terminal header length");
  const header = decode(
    LocalHeader,
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        frame.subarray(4, 4 + length),
      ),
    ),
  );
  if (frame.length !== 4 + length + header.byteLength)
    throw new Error("Invalid terminal payload length");
  return { header, bytes: frame.subarray(4 + length) };
}
