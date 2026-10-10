import { Effect } from "effect";
import {
  type AgentName,
  identifyAgent,
  identifyAgentArgv,
} from "./agent-model";
import { execProcess } from "./process";

export interface ForegroundProcess {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  tty: string;
  stat: string;
  started: string;
  command: string;
  argv?: readonly string[];
}
export const normalizeTty = (tty: string) => tty.replace(/^\/dev\//, "");

export function parseProcessSnapshot(output: string): ForegroundProcess[] {
  return output.split("\n").flatMap((line) => {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/.exec(
        line,
      );
    if (!match) return [];
    const [, pid, ppid, pgid, tpgid, tty, stat, started, command] = match;
    return [
      {
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        tpgid: Number(tpgid),
        tty: normalizeTty(tty ?? ""),
        stat: stat ?? "",
        started: started?.replace(/\s+/g, " ") ?? "",
        command: command ?? "",
      },
    ];
  });
}

export function foregroundProcesses(
  processes: readonly ForegroundProcess[],
  tty: string,
) {
  return processes.filter(
    (process) =>
      process.tty === normalizeTty(tty) &&
      process.pgid > 0 &&
      process.pgid === process.tpgid &&
      !/[TtZ]/.test(process.stat),
  );
}

export type ForegroundAgentRecognition =
  | { kind: "identified"; agent: AgentName; generation: string }
  | { kind: "ambiguous" }
  | { kind: "unrecognized" };

export function inspectForegroundAgent(
  processes: readonly ForegroundProcess[],
  tty: string,
): ForegroundAgentRecognition {
  const candidates = foregroundProcesses(processes, tty).flatMap((process) => {
    const agent =
      identifyAgent(process.command) ?? identifyAgentArgv(process.argv ?? []);
    return agent ? [{ process, agent }] : [];
  });
  // A runtime entrypoint and its native child are one agent. Two independent
  // recognized jobs in the same foreground group remain ambiguous.
  const roots = candidates.filter(
    ({ process }) =>
      !candidates.some((candidate) => candidate.process.pid === process.ppid),
  );
  if (roots.length > 1) return { kind: "ambiguous" };
  const root = roots[0];
  if (!root) return { kind: "unrecognized" };
  return {
    kind: "identified",
    agent: root.agent,
    generation: `${root.process.pid}:${root.process.started}:${root.process.pgid}`,
  };
}

export function foregroundAgent(
  processes: readonly ForegroundProcess[],
  tty: string,
): { agent: AgentName; generation: string } | undefined {
  const result = inspectForegroundAgent(processes, tty);
  return result.kind === "identified"
    ? { agent: result.agent, generation: result.generation }
    : undefined;
}

export function discoverForegroundProcesses() {
  return execProcess(
    "ps",
    ["-ww", "-axo", "pid=,ppid=,pgid=,tpgid=,tty=,stat=,lstart=,comm="],
    { maxOutputBytes: 4 * 1024 * 1024 },
  ).pipe(
    Effect.map(({ stdout }) => parseProcessSnapshot(stdout)),
    Effect.timeout("1 second"),
  );
}

/** macOS ps does not preserve argv boundaries. Reject quotes/escapes rather
 * than pretending to decode them; entrypoints containing spaces are unresolved. */
export function parsePsArgv(output: string): Map<number, readonly string[]> {
  const result = new Map<number, readonly string[]>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (
      !match ||
      (match[2]?.length ?? 0) > 64 * 1024 ||
      /["'\\]/.test(match[2] ?? "")
    )
      continue;
    result.set(Number(match[1]), (match[2] ?? "").trim().split(/\s+/));
  }
  return result;
}

export function readRuntimeArguments(processes: readonly ForegroundProcess[]) {
  const runtimes = processes.filter((process) =>
    ["node", "bun"].includes(process.command.split("/").at(-1) ?? ""),
  );
  if (!runtimes.length)
    return Effect.succeed(new Map<number, readonly string[]>());
  if (process.platform === "linux") {
    return Effect.all(
      runtimes.map((item) =>
        Effect.tryPromise({
          try: async (signal) => {
            const reader = Bun.file(`/proc/${item.pid}/cmdline`)
              .stream()
              .getReader();
            const decoder = new TextDecoder();
            let bytes = 0;
            let text = "";
            const abort = () => {
              void reader.cancel().catch(() => {});
            };
            signal.addEventListener("abort", abort, { once: true });
            try {
              while (true) {
                if (signal.aborted) throw new Error("Arguments interrupted");
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > 64 * 1024)
                  throw new Error("Argument limit exceeded");
                text += decoder.decode(chunk.value, { stream: true });
              }
              return [
                item.pid,
                (text + decoder.decode()).split("\0").filter(Boolean),
              ] as const;
            } finally {
              signal.removeEventListener("abort", abort);
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          },
          catch: () => new Error("Arguments unavailable"),
        }).pipe(Effect.catch(() => Effect.succeed([item.pid, []] as const))),
      ),
      { concurrency: 4 },
    ).pipe(
      Effect.map((entries) => new Map<number, readonly string[]>(entries)),
      Effect.timeout("1 second"),
    );
  }
  if (process.platform === "darwin") {
    return execProcess(
      "ps",
      [
        "-ww",
        "-p",
        runtimes.map((item) => item.pid).join(","),
        "-o",
        "pid=,args=",
      ],
      { maxOutputBytes: 1024 * 1024 },
    ).pipe(
      Effect.map(({ stdout }) => parsePsArgv(stdout)),
      Effect.timeout("1 second"),
    );
  }
  return Effect.succeed(new Map<number, readonly string[]>());
}
