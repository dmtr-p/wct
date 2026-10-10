import { describe, expect, test } from "vitest";
import {
  foregroundAgent,
  foregroundProcesses,
  inspectForegroundAgent,
  parseProcessSnapshot,
  parsePsArgv,
} from "../../src/services/agent-process";

describe("foreground process identity", () => {
  const snapshot = parseProcessSnapshot(
    " 10 1 10 20 ttys001 Ss Thu Oct 9 12:00:00 2026 /bin/fish\n 20 10 20 20 ttys001 S+ Thu Oct 9 12:00:01 2026 /usr/bin/codex\n 30 10 30 20 ttys001 S Thu Oct 9 12:00:02 2026 claude\n",
  );
  const agentProcess = snapshot[1];
  if (!agentProcess) throw new Error("Missing foreground process fixture");
  test("uses the TTY foreground group rather than the initial shell or background descendants", () => {
    expect(snapshot).toHaveLength(3);
    expect(
      foregroundProcesses(snapshot, "/dev/ttys001").map(
        (process) => process.pid,
      ),
    ).toEqual([20]);
    expect(foregroundAgent(snapshot, "/dev/ttys001")?.agent).toBe("codex");
    expect(foregroundAgent(snapshot, "/dev/ttys002")).toBeUndefined();
    expect(
      foregroundAgent(
        snapshot.map((process) => ({ ...process, stat: "T" })),
        "/dev/ttys001",
      ),
    ).toBeUndefined();
  });
  test("supports Linux TTY names and official runtime entrypoints", () => {
    const process = {
      ...agentProcess,
      tty: "pts/4",
      command: "node",
      argv: ["node", "/app/node_modules/@openai/codex/bin/codex.js"],
    };
    expect(foregroundAgent([process], "/dev/pts/4")?.agent).toBe("codex");
    expect(
      foregroundAgent(
        [{ ...process, argv: ["node", "server.js", "codex"] }],
        "/dev/pts/4",
      ),
    ).toBeUndefined();
  });
  test("runtime/native children count once, independent competing agents remain unresolved", () => {
    const parent = {
      ...agentProcess,
      command: "node",
      argv: ["node", "/app/node_modules/@openai/codex/bin/codex.js"],
    };
    const child = { ...agentProcess, pid: 21, ppid: 20 };
    expect(
      foregroundAgent([parent, child], "/dev/ttys001")?.generation,
    ).toContain("20:");
    expect(
      foregroundAgent([parent, { ...child, ppid: 10 }], "/dev/ttys001"),
    ).toBeUndefined();
    expect(
      inspectForegroundAgent([parent, { ...child, ppid: 10 }], "/dev/ttys001"),
    ).toEqual({ kind: "ambiguous" });
    expect(
      inspectForegroundAgent([{ ...parent, argv: [] }], "/dev/ttys001"),
    ).toEqual({ kind: "unrecognized" });
  });
  test("rejects ambiguous macOS ps quoting and keeps argv-only identification strict", () => {
    const args = parsePsArgv(
      '20 node /app/node_modules/@openai/codex/bin/codex.js\n21 node "path with spaces"\n',
    );
    expect(args.get(20)?.[1]).toContain("@openai/codex");
    expect(args.has(21)).toBe(false);
  });
});
