import { Schema } from "effect";
import { TerminalConnectorHello } from "./attachments";
import { ConfiguredHost, Positive } from "./identity";
import { HandshakeRequest } from "./protocol";

export const ConnectorConfig = Schema.Struct({
  host: ConfiguredHost,
  // An argv vector executed directly: never a gateway-expanded shell string.
  argv: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  outerPty: Schema.Literal(false),
  stdout: Schema.Literal("framed-only"),
  stderr: Schema.Literal("diagnostics"),
});
export const ConnectorHello = Schema.Struct({
  handshake: HandshakeRequest,
  channel: Schema.Union([
    Schema.TaggedStruct("State", {}),
    Schema.TaggedStruct("Terminal", { attachment: TerminalConnectorHello }),
  ]),
});
export const ConnectorFrameLimits = Schema.Struct({
  maxHeaderBytes: Positive,
  maxPayloadBytes: Positive,
});
