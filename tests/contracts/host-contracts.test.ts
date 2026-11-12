import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import {
  acceptsTerminalFrame,
  AttachmentControl,
  AttachmentRef,
  AttachmentState,
  CreateAttachment,
  TerminalFrameHeader,
} from "../../src/contracts/attachments";
import { ConnectorConfig, ConnectorHello } from "../../src/contracts/connector";
import {
  COMMAND_PARSE_OPTIONS,
  hostWorkspaceKey,
  PaneRef,
  RuntimeRef,
  sameSession,
  SessionRef,
  StoredIdentity,
  WorkspaceRef,
  WorkspaceSessionRef,
} from "../../src/contracts/identity";
import {
  compareReceipt,
  ExecutorMessage,
  OperationRecord,
  OperationRequest,
  ReconcileOperation,
  sameOperationFence,
  WorkspaceOperationFence,
} from "../../src/contracts/operations";
import {
  HandshakeRequest,
  HostDescriptor,
  negotiateProtocol,
} from "../../src/contracts/protocol";
import { HandshakeRpcs, HostRpcs } from "../../src/contracts/rpc";
import {
  acceptsDelta,
  SidebarCursor,
  SidebarDelta,
  SidebarSnapshot,
} from "../../src/contracts/sidebar";
import { workspaceIdentityKey } from "../../src/services/identities";

const runtime = Schema.decodeSync(RuntimeRef)({
  hostId: "host-a",
  runtimeGeneration: "boot-a",
  daemonEpoch: "daemon-a",
});
const workspace = Schema.decodeSync(WorkspaceRef)({
  hostId: runtime.hostId,
  mainRepoPath: "/repo",
  branch: "feature/a",
});
const session = Schema.decodeSync(SessionRef)({
  server: {
    hostId: runtime.hostId,
    runtimeGeneration: runtime.runtimeGeneration,
    serverId: "/tmp/tmux/default",
    serverGeneration: "/tmp/tmux/default\0" + "123\0" + "1000",
  },
  sessionId: "$1",
});
const target = Schema.decodeSync(WorkspaceSessionRef)({
  workspace,
  worktreePath: "/worktrees/a",
  session,
});
const ownership = Schema.decodeSync(WorkspaceOperationFence)({
  target: workspace,
  operationId: "op-a",
  generation: "owner-a",
});
const attachment = Schema.decodeSync(AttachmentRef)({
  runtime,
  attachmentId: "attachment-a",
  generation: "generation-a",
});
const host = Schema.decodeSync(HostDescriptor)({
  ...runtime,
  executionUser: "alice",
  protocol: { major: 1, minor: 2 },
  capabilities: [
    "workspace-operations-v1",
    "caller-shell-v1",
    "sidebar-v1",
    "terminal-attachments-v1",
    "future-capability",
  ],
  policy: {
    stateFrameBytes: 65536,
    stateSubscriberBytes: 524288,
    stateReplayRevisions: 100,
    receiptRetentionMs: 86400000,
    statusRetentionMs: 86400000,
    diagnosticRetentionMs: 3600000,
    diagnosticBytes: 65536,
    terminalFrameBytes: 65536,
    terminalQueueBytes: 524288,
    terminalMaxCols: 1000,
    terminalMaxRows: 1000,
    attachmentGraceMs: 0,
  },
});
const handshake = Schema.decodeSync(HandshakeRequest)({
  expectedHostId: runtime.hostId,
  protocol: { major: 1, minor: 0 },
  requiredCapabilities: ["sidebar-v1"],
  executionUser: "alice",
});
const request = Schema.decodeSync(OperationRequest)({
  requestId: "request-a",
  target: workspace,
  command: { _tag: "OpenWorkspace", base: "main", existing: false, pr: null },
  execution: {
    mode: "caller-shell",
    executionUser: "alice",
    cwd: "/repo",
    environment: { PATH: "/bin", SSH_AUTH_SOCK: "/tmp/ssh" },
    configuration: {
      profile: null,
      resolved: {
        worktree_dir: "/worktrees",
        project_name: "app",
        work_dir: ".",
      },
    },
  },
});

describe("host protocol negotiation", () => {
  test("accepts additive minor versions and ignores unknown advertised capabilities", () => {
    const result = negotiateProtocol(handshake, host);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.protocol).toEqual({ major: 1, minor: 0 });
    expect(result.value.capabilities).toContain("sidebar-v1");
    expect(result.value.capabilities).not.toContain("future-capability");
    expect(
      negotiateProtocol(
        { ...handshake, protocol: { major: 1, minor: 9 } },
        host,
      ),
    ).toMatchObject({ ok: true, value: { protocol: { minor: 2 } } });
  });

  test("identity mismatch takes precedence over compatibility before credentials or actions", () => {
    expect(
      negotiateProtocol(handshake, {
        ...host,
        hostId: Schema.decodeSync(WorkspaceRef)({
          ...workspace,
          hostId: "replacement",
        }).hostId,
        protocol: { major: 2, minor: 0 },
      }),
    ).toMatchObject({ ok: false, error: { _tag: "IdentityMismatch" } });
  });

  test("rejects incompatible major, missing capability and wrong execution user", () => {
    expect(
      negotiateProtocol(
        { ...handshake, protocol: { major: 2, minor: 0 } },
        host,
      ),
    ).toMatchObject({ ok: false, error: { _tag: "IncompatibleProtocol" } });
    expect(
      negotiateProtocol(handshake, { ...host, capabilities: [] }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "MissingCapabilities", capabilities: ["sidebar-v1"] },
    });
    expect(
      negotiateProtocol({ ...handshake, executionUser: "root" }, host),
    ).toMatchObject({ ok: false, error: { _tag: "PermissionDenied" } });
  });

  test.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity])(
    "rejects malformed version %s",
    (major) => {
      expect(() =>
        Schema.decodeSync(HandshakeRequest)({
          ...handshake,
          protocol: { major, minor: 0 },
        }),
      ).toThrow();
    },
  );

  test("requires concrete finite policy values", () => {
    expect(() =>
      Schema.decodeUnknownSync(HostDescriptor)({ ...host, policy: {} }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(HostDescriptor)({
        ...host,
        policy: { ...host.policy, terminalFrameBytes: 0 },
      }),
    ).toThrow();
  });
});

describe("identity and generation fixtures", () => {
  test("qualifies the existing Workspace key without changing its encoding", () => {
    expect(hostWorkspaceKey(workspace)).toBe(
      JSON.stringify([
        runtime.hostId,
        workspaceIdentityKey("/repo", "feature/a"),
      ]),
    );
    expect(hostWorkspaceKey(workspace)).not.toBe(
      hostWorkspaceKey(
        Schema.decodeSync(WorkspaceRef)({
          ...workspace,
          hostId: "host-b",
        }),
      ),
    );
    expect(() =>
      Schema.decodeSync(WorkspaceRef)({
        ...workspace,
        mainRepoPath: "relative",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(WorkspaceRef)({ ...workspace, branch: "a\0b" }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(WorkspaceSessionRef)({
        ...target,
        workspace: { ...workspace, hostId: "host-b" },
      }),
    ).toThrow();
  });

  test("tmux IDs survive daemon restart but cannot alias another server/boot/host", () => {
    expect(sameSession(session, session)).toBe(true);
    for (const server of [
      { ...session.server, hostId: "host-b" },
      { ...session.server, runtimeGeneration: "boot-b" },
      {
        ...session.server,
        serverGeneration: "/tmp/tmux/default\0" + "456\0" + "2000",
      },
      { ...session.server, serverId: "/tmp/tmux/other" },
    ])
      expect(
        sameSession(
          session,
          Schema.decodeSync(SessionRef)({ ...session, server }),
        ),
      ).toBe(false);
    expect(() =>
      Schema.decodeSync(PaneRef)({ session, paneId: "$1" }),
    ).toThrow();
    expect(
      Schema.decodeSync(PaneRef)({ session, paneId: "%1" }).session,
    ).toEqual(session);
  });

  test("stored identity v1 is strict about identity and version, tolerant of added metadata", () => {
    expect(
      Schema.decodeUnknownSync(StoredIdentity)({
        schemaVersion: 1,
        hostId: "host-a",
        createdAt: 0,
        future: true,
      }),
    ).toEqual({ schemaVersion: 1, hostId: runtime.hostId, createdAt: 0 });
    for (const hostId of ["", null, "has spaces"])
      expect(() =>
        Schema.decodeUnknownSync(StoredIdentity)({
          schemaVersion: 1,
          hostId,
          createdAt: 0,
        }),
      ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(StoredIdentity)({
        schemaVersion: 2,
        hostId: "host-a",
        createdAt: 0,
      }),
    ).toThrow();
  });
});

describe("operation receipt and executor fixtures", () => {
  test("identical retry ignores map order, preserves command and environment semantics", () => {
    const reordered = {
      ...request,
      execution: {
        ...request.execution,
        environment: { SSH_AUTH_SOCK: "/tmp/ssh", PATH: "/bin" },
      },
    };
    expect(compareReceipt(request, reordered)).toBe("duplicate");
    expect(
      compareReceipt(request, {
        ...request,
        command: { _tag: "CloseWorkspace", force: true },
      }),
    ).toBe("conflict");
    expect(
      compareReceipt(request, {
        ...request,
        execution: { ...request.execution, environment: { PATH: "/other" } },
      }),
    ).toBe("conflict");
    expect(
      compareReceipt(
        request,
        Schema.decodeSync(OperationRequest)({
          ...request,
          requestId: "another-request",
        }),
      ),
    ).toBe("different-request");
    expect(
      compareReceipt(
        request,
        Schema.decodeSync(OperationRequest)({
          ...request,
          target: { ...workspace, hostId: "host-b" },
        }),
      ),
    ).toBe("different-request");
  });

  test("rejects arbitrary or partially specified commands, extra fields and invalid environments", () => {
    for (const command of [
      { _tag: "Exec", command: "echo hello" },
      { _tag: "CloseWorkspace" },
      { _tag: "StartWorkspace", command: "echo hello" },
    ])
      expect(() =>
        Schema.decodeUnknownSync(
          OperationRequest,
          COMMAND_PARSE_OPTIONS,
        )({ ...request, command }),
      ).toThrow();
    expect(() =>
      Schema.decodeSync(
        OperationRequest,
        COMMAND_PARSE_OPTIONS,
      )({
        ...request,
        execution: {
          ...request.execution,
          environment: { "BAD=KEY": "value" },
        },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(OperationRequest)({
        ...request,
        execution: { mode: "host" },
      }),
    ).toThrow();
  });

  test("old v1 operation records omit newer optional progress/diagnostic fields", () => {
    const record = {
      schemaVersion: 1,
      hostId: runtime.hostId,
      operationId: "op-a",
      request,
      acceptedAt: 0,
      updatedAt: 1,
      acceptedRuntime: runtime,
      ownership,
      status: "interrupted",
    };
    expect(Schema.decodeUnknownSync(OperationRecord)(record)).toEqual(record);
    expect(() =>
      Schema.decodeUnknownSync(OperationRecord)({
        ...record,
        status: "finished-maybe",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(OperationRecord)({
        ...record,
        schemaVersion: 2,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(OperationRecord)({
        ...record,
        hostId: "other-host",
      }),
    ).toThrow();
  });

  test("caller-shell messages require process identity and an execution fence", () => {
    const fence = { runtime, ownership, executionId: "executor-a" };
    expect(
      Schema.decodeSync(ExecutorMessage)({
        _tag: "ScriptStarted",
        fence,
        step: 0,
        pid: 123,
        processStart: "boot-relative-start",
      }),
    ).toMatchObject({ fence });
    expect(() =>
      Schema.decodeUnknownSync(ExecutorMessage)({
        _tag: "ScriptStarted",
        fence,
        step: 0,
        pid: 123,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ExecutorMessage)({
        _tag: "ScriptCompleted",
        step: 0,
        results: [],
      }),
    ).toThrow();
  });

  test("explicit reconciliation identifies the uncertain operation and ownership generation", () => {
    const reconciliation = {
      runtime,
      requestId: "reconcile-a",
      expectedOwnership: ownership,
      resolution: "release-after-inspection",
      acknowledgeUncertainSideEffects: true,
      reason: "Inspected uncertain command and relevant work",
    };
    expect(
      Schema.decodeUnknownSync(ReconcileOperation)(reconciliation)
        .expectedOwnership,
    ).toEqual(ownership);
    expect(() =>
      Schema.decodeUnknownSync(ReconcileOperation)({
        ...reconciliation,
        acknowledgeUncertainSideEffects: false,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ReconcileOperation)({
        ...reconciliation,
        expectedOwnership: { operationId: "op-a" },
      }),
    ).toThrow();
    expect(sameOperationFence(ownership, ownership)).toBe(true);
    for (const replacement of [
      { ...ownership, operationId: "op-b" },
      { ...ownership, generation: "owner-b" },
      { ...ownership, target: { ...workspace, hostId: "host-b" } },
    ])
      expect(
        sameOperationFence(
          ownership,
          Schema.decodeSync(WorkspaceOperationFence)(replacement),
        ),
      ).toBe(false);
  });
});

describe("sidebar stream fixtures", () => {
  const cursor = Schema.decodeSync(SidebarCursor)({
    runtime,
    revision: 10,
  });
  const delta = Schema.decodeSync(SidebarDelta)({
    _tag: "Delta",
    cursor: { runtime, revision: 11 },
    previousRevision: 10,
    changes: [{ _tag: "RemoveWorkspace", ref: workspace }],
  });

  test("accepts contiguous revisions and rejects missing/out-of-order/duplicate revisions", () => {
    expect(acceptsDelta(cursor, delta)).toBe(true);
    for (const revision of [9, 11, 12])
      expect(acceptsDelta({ ...cursor, revision }, delta)).toBe(false);
    expect(() =>
      Schema.decodeSync(SidebarDelta)({ ...delta, previousRevision: 8 }),
    ).toThrow();
    expect(
      Schema.decodeSync(SidebarSnapshot)({
        _tag: "Snapshot",
        cursor,
        repositories: [],
        workspaces: [],
      }).cursor,
    ).toEqual(cursor);
  });

  test.each(["hostId", "runtimeGeneration", "daemonEpoch"] as const)(
    "resynchronizes after a changed %s",
    (key) => {
      const replacement = Schema.decodeSync(SidebarCursor)({
        ...cursor,
        runtime: { ...runtime, [key]: "replacement" },
      });
      expect(acceptsDelta(replacement, delta)).toBe(false);
    },
  );
});

describe("attachment and stdio fixtures", () => {
  const frame = Schema.decodeSync(TerminalFrameHeader)({
    ref: attachment,
    session,
    sequence: 1,
    kind: "output",
    byteLength: 4,
  });

  test("fences terminal frames by attachment, daemon, host runtime and tmux server", () => {
    const current = { ref: attachment, session, nextSequence: 1 };
    expect(acceptsTerminalFrame(current, frame)).toBe(true);
    expect(acceptsTerminalFrame({ ...current, nextSequence: 2 }, frame)).toBe(
      false,
    );
    for (const ref of [
      { ...attachment, generation: "generation-b" },
      { ...attachment, attachmentId: "attachment-b" },
      { ...attachment, runtime: { ...runtime, daemonEpoch: "daemon-b" } },
      { ...attachment, runtime: { ...runtime, runtimeGeneration: "boot-b" } },
    ])
      expect(
        acceptsTerminalFrame(
          { ...current, ref: Schema.decodeSync(AttachmentRef)(ref) },
          frame,
        ),
      ).toBe(false);
    const replacement = Schema.decodeSync(SessionRef)({
      ...session,
      server: {
        ...session.server,
        serverGeneration: "/tmp/tmux/default\0" + "456\0" + "2000",
      },
    });
    expect(
      acceptsTerminalFrame({ ...current, session: replacement }, frame),
    ).toBe(false);
  });

  test("requires positive dimensions and same-host attachment targets", () => {
    const create = {
      runtime,
      requestId: "create-a",
      target,
      dimensions: { cols: 80, rows: 24 },
    };
    expect(Schema.decodeSync(CreateAttachment)(create)).toMatchObject({
      target,
    });
    expect(() =>
      Schema.decodeSync(CreateAttachment)({
        ...create,
        dimensions: { cols: 0, rows: 24 },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(CreateAttachment)({
        ...create,
        runtime: { ...runtime, hostId: "host-b" },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(AttachmentState)({
        ref: attachment,
        target,
        dimensions: { cols: 80, rows: 24 },
        status: "attached",
      }),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AttachmentControl)({
        _tag: "Write",
        ref: attachment,
        bytes: "raw terminal output",
      }),
    ).toThrow();
  });

  test("separates framed state/terminal channels and forbids outer PTY", () => {
    const config = {
      host: {
        label: "laptop",
        expectedHostId: runtime.hostId,
        executionUser: "alice",
      },
      argv: ["ssh", "-T", "alice@host", "wct", "connect", "--stdio"],
      outerPty: false,
      stdout: "framed-only",
      stderr: "diagnostics",
    };
    expect(Schema.decodeUnknownSync(ConnectorConfig)(config)).toEqual(config);
    expect(() =>
      Schema.decodeUnknownSync(ConnectorConfig)({ ...config, outerPty: true }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ConnectorConfig)({
        ...config,
        host: { label: "laptop" },
      }),
    ).toThrow();
    expect(
      Schema.decodeSync(ConnectorHello)({
        handshake,
        channel: {
          _tag: "Terminal",
          attachment: { ref: attachment, ticket: "short-lived-ticket" },
        },
      }),
    ).toMatchObject({ channel: { _tag: "Terminal" } });
  });

  test("RPC groups declare semantic state/control only", () => {
    expect([...HandshakeRpcs.requests.keys()]).toEqual([
      "DescribeHost",
      "Negotiate",
    ]);
    expect([...HostRpcs.requests.keys()]).toEqual([
      "SubmitOperation",
      "GetOperation",
      "CancelOperation",
      "ReconcileOperation",
      "SubscribeSidebar",
      "AwaitScriptPlan",
      "ReportExecutor",
      "TransferExecutor",
      "CreateAttachment",
      "ControlAttachment",
    ]);
    expect(
      HostRpcs.requests.get("SubmitOperation")?.payloadSchema,
    ).toBeDefined();
  });
});
