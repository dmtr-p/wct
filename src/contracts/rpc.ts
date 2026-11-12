import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  AttachmentControl,
  AttachmentControlAck,
  AttachmentState,
  CreateAttachment,
} from "./attachments";
import {
  COMMAND_PARSE_OPTIONS,
  Counter,
  OperationId,
  RuntimeRef,
  Text,
} from "./identity";
import {
  CancelOperation,
  CancelResult,
  ExecutorFence,
  ExecutorMessage,
  OperationReceipt,
  OperationRecord,
  OperationRef,
  OperationRequest,
  ReconcileOperation,
  ScriptPlan,
} from "./operations";
import {
  ContractError,
  HandshakeRequest,
  HostDescriptor,
  NegotiatedProtocol,
} from "./protocol";
import { SidebarEvent, SidebarSubscription } from "./sidebar";

// Transport authorization must permit only these procedures before negotiation.
export const HandshakeRpcs = RpcGroup.make(
  Rpc.make("DescribeHost", { success: HostDescriptor, error: ContractError }),
  Rpc.make("Negotiate", {
    payload: HandshakeRequest,
    success: NegotiatedProtocol,
    error: ContractError,
  }),
);

export const HostRpcs = RpcGroup.make(
  Rpc.make("SubmitOperation", {
    payload: { runtime: RuntimeRef, request: OperationRequest },
    success: OperationReceipt,
    error: ContractError,
  }).annotate(Rpc.ParseOptions, COMMAND_PARSE_OPTIONS),
  Rpc.make("GetOperation", {
    payload: OperationRef,
    success: OperationRecord,
    error: ContractError,
  }),
  Rpc.make("CancelOperation", {
    payload: { runtime: RuntimeRef, cancellation: CancelOperation },
    success: CancelResult,
    error: ContractError,
  }).annotate(Rpc.ParseOptions, COMMAND_PARSE_OPTIONS),
  Rpc.make("ReconcileOperation", {
    payload: ReconcileOperation,
    success: OperationRecord,
    error: ContractError,
  }).annotate(Rpc.ParseOptions, COMMAND_PARSE_OPTIONS),
  Rpc.make("SubscribeSidebar", {
    payload: SidebarSubscription,
    success: SidebarEvent,
    error: ContractError,
    stream: true,
  }),
  Rpc.make("AwaitScriptPlan", {
    payload: {
      runtime: RuntimeRef,
      operationId: OperationId,
      afterStep: Schema.NullOr(Counter),
    },
    success: ScriptPlan,
    error: ContractError,
  }),
  Rpc.make("ReportExecutor", {
    payload: ExecutorMessage,
    success: Schema.Void,
    error: ContractError,
  }).annotate(Rpc.ParseOptions, COMMAND_PARSE_OPTIONS),
  Rpc.make("TransferExecutor", {
    payload: {
      fence: ExecutorFence,
      workerPid: Counter.check(Schema.isGreaterThan(0)),
      processStart: Text,
    },
    success: ExecutorFence,
    error: ContractError,
  }).annotate(Rpc.ParseOptions, COMMAND_PARSE_OPTIONS),
  Rpc.make("CreateAttachment", {
    payload: CreateAttachment,
    success: AttachmentState,
    error: ContractError,
  }).annotate(Rpc.ParseOptions, COMMAND_PARSE_OPTIONS),
  Rpc.make("ControlAttachment", {
    payload: AttachmentControl,
    success: AttachmentControlAck,
    error: ContractError,
  }).annotate(Rpc.ParseOptions, COMMAND_PARSE_OPTIONS),
);
