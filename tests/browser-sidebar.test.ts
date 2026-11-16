import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { projectLocalCatalog } from "../src/browser/catalog";
import {
  decodeFrame,
  encodeFrame,
  type LocalHeader,
  type LocalTarget,
  policy,
  type WorkspaceTarget,
} from "../src/browser/protocol";
import { sessionIdentity } from "../src/services/session-identity";
import type { TerminalAttachment } from "../src/services/terminal-attachments";
import { browserEndpoint } from "./helpers/browser-endpoint";
import { test } from "./helpers/temp-dir";

const closed = (ws: WebSocket) =>
  vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
function watch(ws: WebSocket, acknowledge = true) {
  const frames: LocalHeader[] = [];
  const ack = (header: LocalHeader) => {
    if (!("target" in header) || header.kind === "ack")
      throw new Error("Expected server header");
    ws.send(
      encodeFrame({
        ref: header.ref,
        streamId: header.streamId,
        target: header.target,
        kind: "ack",
        sequence: header.sequence,
        byteLength: 0,
      }),
    );
  };
  ws.onmessage = (event) => {
    const { header } = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
    frames.push(header);
    if (acknowledge) ack(header);
  };
  return { frames, ack };
}

async function navigable(
  tempDir: string,
  options: {
    now?: () => number;
    catalog?: () => Promise<void>;
    select?: () => Promise<void>;
  } = {},
) {
  const initial = {
    server: "/tmp/fixture|1|2",
    sessionId: "$1",
    mainRepoPath: tempDir,
    worktreePath: tempDir,
    branch: "main",
  };
  const other = {
    ...initial,
    sessionId: "$2",
    worktreePath: `${tempDir}/other`,
    branch: "other",
  };
  const targets = new Map<string, LocalTarget>();
  let present = true;
  const selection = vi.fn(
    async (ref: TerminalAttachment, target: WorkspaceTarget) => {
      await options.select?.();
      if (!present) throw new Error("Session replaced");
      targets.set(ref.id, target);
    },
  );
  const catalog = vi.fn(async () => {
    await options.catalog?.();
    return [
      {
        mainRepoPath: tempDir,
        displayName: "fixture",
        workspaces: [initial, other].map((target) => ({
          branch: target.branch,
          worktreePath: target.worktreePath,
          target,
        })),
      },
    ];
  });
  const e = await browserEndpoint(tempDir, {
    now: options.now,
    catalog,
    select: selection,
    client: (ref) => {
      const selected = targets.get(ref.id);
      return selected ? { sessionId: selected.sessionId } : {};
    },
    verify: async (client) => {
      if (!present && client.sessionId === other.sessionId)
        throw new Error("Session replaced");
      return client.sessionId === other.sessionId ? other : initial;
    },
  });
  const connect = async () => {
    const a = await e.create();
    const ticket = await e.ticket(a.ref);
    const ws = await e.open(ticket.ticket);
    const observed = watch(ws);
    const body = { ref: a.ref, streamId: ticket.streamId };
    const response = await e.post("/api/sidebar", body);
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as { revision: number };
    const select = (selection = other, extra = {}) =>
      ws.send(
        JSON.stringify({
          ...body,
          target: initial,
          kind: "select",
          selection,
          catalogRevision: snapshot.revision,
          controlSequence: 0,
          throughInput: null,
          ...extra,
        }),
      );
    return { a, ticket, ws, observed, body, snapshot, select };
  };
  return {
    ...e,
    initial,
    other,
    targets,
    selection,
    catalog,
    connect,
    disappear: () => {
      present = false;
    },
  };
}

test("catalog uses registry labels and shared ownership selection; native lookalikes remain unavailable", () => {
  const target = {
    mainRepoPath: "/repo",
    worktreePath: "/repo/tree",
    branch: "main",
  };
  const repo = {
    id: "registry" as import("../src/services/identities").RegistrationId,
    project: "Display name",
    repoPath: "/repo",
    profileNames: [],
    worktrees: [
      {
        path: target.worktreePath,
        branch: "main",
        isMainWorktree: false,
        changedFiles: 0,
        sync: null,
      },
    ],
  };
  const native = {
    name: "tree",
    server: "server",
    id: "$1",
    attached: false,
    windows: 1,
  };
  expect(
    projectLocalCatalog([repo], [native])[0]?.workspaces[0]?.target,
  ).toBeNull();
  const projects = projectLocalCatalog(
    [repo],
    [{ ...native, ownership: { identity: sessionIdentity(target) } }],
  );
  expect(projects[0]?.displayName).toBe("Display name");
  expect(projects[0]?.workspaces[0]?.target).toEqual({
    ...target,
    server: "server",
    sessionId: "$1",
  });
});

test("two owned tabs select separately; selected reply is ordered and lost reply recovery uses actual target", async ({
  tempDir,
}) => {
  const e = await navigable(tempDir);
  try {
    const one = await e.connect();
    const two = await e.connect();
    expect(e.catalog).toHaveBeenCalledTimes(1);
    one.select();
    await vi.waitFor(() =>
      expect(
        one.observed.frames.some(
          (f) => f.kind === "selected" && f.target.sessionId === "$2",
        ),
      ).toBe(true),
    );
    expect(e.targets.get(one.a.ref.attachmentId)).toEqual(e.other);
    expect(e.targets.has(two.a.ref.attachmentId)).toBe(false);
    expect(two.ws.readyState).toBe(WebSocket.OPEN);
    // A transport loss after acceptance never retries the control. Fresh attach follows the observed client.
    one.ws.close();
    await closed(one.ws);
    let recovered: Response | undefined;
    await vi.waitFor(async () => {
      recovered = await e.post("/api/attachments", {
        reconnect: one.a.ref,
        dimensions: { cols: 80, rows: 24 },
      });
      expect(recovered.status).toBe(201);
    });
    if (!recovered) throw new Error("Missing recovery response");
    expect((await recovered.json()).target).toEqual(e.other);
    expect(e.selection).toHaveBeenCalledTimes(1);
  } finally {
    await e.dispose();
  }
});

test("selection waits for actual cumulative renderer ACK and does not spend another tab's credit", async ({
  tempDir,
}) => {
  const e = await navigable(tempDir);
  try {
    const c = await e.connect();
    const seen = watch(c.ws, false);
    const pid = e.pids.get(c.a.ref.attachmentId);
    if (!pid) throw new Error("Missing fixture PID");
    process.kill(pid, "SIGUSR2");
    await vi.waitFor(() =>
      expect(seen.frames.some((f) => f.kind === "output")).toBe(true),
    );
    c.select();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(e.selection).not.toHaveBeenCalled();
    for (const frame of seen.frames.splice(0)) seen.ack(frame);
    // Consume any remaining flood frames without inventing input drain credit.
    c.ws.onmessage = (event) => {
      const { header } = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
      seen.frames.push(header);
      seen.ack(header);
    };
    await vi.waitFor(() => expect(e.selection).toHaveBeenCalledTimes(1));
  } finally {
    await e.dispose();
  }
});

test.for(["revision", "watermark", "stream", "server", "replacement"] as const)(
  "stale %s selection closes only its attachment",
  async (fault, { tempDir }) => {
    const e = await navigable(tempDir);
    try {
      const one = await e.connect();
      const two = await e.connect();
      if (fault === "replacement") e.disappear();
      one.select(
        fault === "server" ? { ...e.other, server: "replacement" } : e.other,
        {
          ...(fault === "revision"
            ? { catalogRevision: one.snapshot.revision + 1 }
            : {}),
          ...(fault === "watermark" ? { throughInput: 0 } : {}),
          ...(fault === "stream" ? { streamId: randomUUID() } : {}),
        },
      );
      await closed(one.ws);
      expect(two.ws.readyState).toBe(WebSocket.OPEN);
      expect(e.targets.has(one.a.ref.attachmentId)).toBe(false);
    } finally {
      await e.dispose();
    }
  },
);

test("catalog authority and connection references are checked before and after an in-flight observation", async ({
  tempDir,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const e = await navigable(tempDir, { catalog: () => gate });
  let pending: Promise<Response> | undefined;
  try {
    const a = await e.create();
    const ticket = await e.ticket(a.ref);
    const ws = await e.open(ticket.ticket);
    const body = { ref: a.ref, streamId: ticket.streamId };
    expect((await e.post("/api/sidebar", body, "")).status).toBe(401);
    expect(
      (await e.post("/api/sidebar", { ...body, streamId: randomUUID() }))
        .status,
    ).toBe(409);
    expect(
      (
        await fetch(new URL("/api/sidebar", e.url), {
          method: "POST",
          headers: {
            origin: "http://foreign.example",
            cookie: e.cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(403);
    pending = e.post("/api/sidebar", body);
    await vi.waitFor(() => expect(e.catalog).toHaveBeenCalledTimes(1));
    ws.close();
    await closed(ws);
    release();
    expect((await pending).status).toBe(409);
  } finally {
    release();
    await pending;
    await e.dispose();
  }
});

test("initial creation retry returns the same bounded pending attachment and original dimensions", async ({
  tempDir,
}) => {
  const e = await browserEndpoint(tempDir);
  try {
    const creationId = randomUUID();
    const post = (cols: number) =>
      e.post("/api/attachments", {
        creationId,
        dimensions: { cols, rows: 24 },
      });
    const [a, b] = await Promise.all([post(80), post(100)]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await a.json()).toEqual(await b.json());
    expect(e.ids).toHaveLength(1);
  } finally {
    await e.dispose();
  }
});

test("shared catalog query is single flight and rejects excess retained rows", async ({
  tempDir,
}) => {
  const e = await browserEndpoint(tempDir, {
    catalog: async () =>
      Array.from({ length: policy.catalogRows + 1 }, (_, index) => ({
        mainRepoPath: `/repo${index}`,
        displayName: "repo",
        workspaces: [],
      })),
  });
  try {
    const a = await e.create();
    const ticket = await e.ticket(a.ref);
    const ws = await e.open(ticket.ticket);
    expect(
      (await e.post("/api/sidebar", { ref: a.ref, streamId: ticket.streamId }))
        .status,
    ).toBe(400);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  } finally {
    await e.dispose();
  }
});

test("disconnect during a pending switch captures its settled actual destination before recovery", async ({
  tempDir,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let switching = false;
  const e = await navigable(tempDir, {
    select: async () => {
      switching = true;
      await gate;
    },
  });
  try {
    const c = await e.connect();
    c.select();
    await vi.waitFor(() => expect(switching).toBe(true));
    c.ws.close();
    await closed(c.ws);
    expect(
      (
        await e.post("/api/attachments", {
          reconnect: c.a.ref,
          dimensions: { cols: 80, rows: 24 },
        })
      ).status,
    ).toBe(409);
    release();
    let response: Response | undefined;
    await vi.waitFor(async () => {
      response = await e.post("/api/attachments", {
        reconnect: c.a.ref,
        dimensions: { cols: 80, rows: 24 },
      });
      expect(response.status).toBe(201);
    });
    if (!response) throw new Error("Missing recovery response");
    expect((await response.json()).target).toEqual(e.other);
  } finally {
    release();
    await e.dispose();
  }
});
