import type { BunServices } from "@effect/platform-bun";
import { Context, Effect } from "effect";
import {
  type AgentObservation,
  classifyAgent,
  identifyAgent,
  reconcileAgent,
} from "./agent-model";
import {
  discoverForegroundProcesses,
  type ForegroundAgentRecognition,
  type ForegroundProcess,
  foregroundProcesses,
  inspectForegroundAgent,
  readRuntimeArguments,
} from "./agent-process";
import { ProcessExitError, ProcessOutputLimitError } from "./process";
import {
  type AgentPaneMetadata,
  captureAgentPane,
  discoverAgentPanes,
} from "./tmux";

export interface AgentSnapshot {
  observations: Map<string, AgentObservation>;
  /** Session -> pane IDs, including linked-window memberships. */
  memberships: Map<string, Set<string>>;
}
type ObservationEffect<A> = Effect.Effect<A, unknown, BunServices.BunServices>;
export interface AgentObservationPorts {
  discover: () => ObservationEffect<AgentPaneMetadata[]>;
  processes: () => ObservationEffect<ForegroundProcess[]>;
  arguments: (
    processes: readonly ForegroundProcess[],
  ) => ObservationEffect<Map<number, readonly string[]>>;
  capture: (paneId: string) => ObservationEffect<string>;
  now: () => number;
}
export interface AgentServiceApi {
  observe: (
    sessions: ReadonlySet<string>,
    previous: AgentSnapshot,
  ) => Effect.Effect<AgentSnapshot, never, BunServices.BunServices>;
}
export const AgentService =
  Context.Service<AgentServiceApi>("wct/AgentService");
export const emptyAgentSnapshot = (): AgentSnapshot => ({
  observations: new Map(),
  memberships: new Map(),
});

const unavailable = <A>(effect: ObservationEffect<A>) =>
  effect.pipe(
    Effect.match({ onSuccess: (value) => value, onFailure: () => undefined }),
  );

export function observationFailureReason(error: unknown): string {
  if (error instanceof ProcessOutputLimitError) return "output_limit";
  if (error instanceof ProcessExitError)
    return observationFailureReason(error.cause);
  if (
    error &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "TimeoutError"
  )
    return "timeout";
  return "unavailable";
}

function paneAgent(
  pane: AgentPaneMetadata,
  processes: readonly ForegroundProcess[],
): ForegroundAgentRecognition | { kind: "arguments_unavailable" } {
  const direct = identifyAgent(pane.command);
  const identified = inspectForegroundAgent(processes, pane.tty);
  if (identified.kind === "ambiguous") return identified;
  const foreground = foregroundProcesses(processes, pane.tty);
  // Missing runtime arguments can hide an agent wrapper or a competing agent.
  // Do not choose a native child as a new generation on partial inspection.
  if (
    foreground.some(
      (process) =>
        ["node", "bun"].includes(process.command.split("/").at(-1) ?? "") &&
        !process.argv?.length,
    )
  )
    return { kind: "arguments_unavailable" };
  if (!direct) return identified;
  if (identified.kind === "identified")
    return identified.agent === direct ? identified : { kind: "unrecognized" };
  // tmux's normalized foreground name is the primary identity source. Native
  // installations may use a versioned executable basename in ps. Process
  // inspection here establishes generation/foreground ownership, not a second
  // requirement that the executable have an unversioned basename.
  const root = foreground.find((process) => process.pid === process.pgid);
  if (
    !root ||
    ["sh", "bash", "zsh", "fish", "ssh", "tmux", "node", "bun"].includes(
      root.command.split("/").at(-1) ?? "",
    )
  )
    return { kind: "unrecognized" };
  return {
    kind: "identified",
    agent: direct,
    generation: `${root.pid}:${root.started}:${root.pgid}`,
  };
}

export function makeAgentService(
  ports: AgentObservationPorts,
): AgentServiceApi {
  // Cache only argument inspection. Foreground ownership and process generation
  // are re-read every observation and again before publishing captures.
  const argvCache = new Map<string, { argv: readonly string[]; at: number }>();
  // Fingerprints only: do not retain terminal/title payloads. After a restart,
  // unchanged evidence belongs to the old process until it visibly changes.
  const evidence = new Map<
    string,
    {
      generation: string;
      screen: ReturnType<typeof Bun.hash>;
      title: ReturnType<typeof Bun.hash>;
      screenInvalid: boolean;
      titleInvalid: boolean;
    }
  >();
  return {
    observe: (sessions, previous) =>
      Effect.gen(function* () {
        const now = ports.now();
        const discovered = yield* unavailable(ports.discover());
        if (!discovered) {
          const observations = new Map<string, AgentObservation>();
          for (const [id, prior] of previous.observations)
            observations.set(
              id,
              reconcileAgent(
                prior,
                prior.agent,
                prior.generation,
                undefined,
                now,
                "discovery_unavailable",
              ),
            );
          return { observations, memberships: previous.memberships };
        }
        const panes = new Map<string, AgentPaneMetadata>();
        const memberships = new Map<string, Set<string>>();
        for (const pane of discovered) {
          if (!sessions.has(pane.session)) continue;
          const members = memberships.get(pane.session) ?? new Set();
          members.add(pane.paneId);
          memberships.set(pane.session, members);
          panes.set(pane.paneId, pane);
        }
        const evidenceKey = (pane: AgentPaneMetadata) =>
          `${pane.server}\0${pane.paneId}`;
        const discoveredKeys = new Set([...panes.values()].map(evidenceKey));
        for (const key of evidence.keys())
          if (!discoveredKeys.has(key)) evidence.delete(key);
        if (!panes.size) {
          argvCache.clear();
          return { observations: new Map(), memberships };
        }
        const processes = yield* unavailable(ports.processes());
        const relevant = processes?.filter((process) =>
          [...panes.values()].some(
            (pane) => foregroundProcesses([process], pane.tty).length,
          ),
        );
        const cacheKey = (process: ForegroundProcess) =>
          `${[...panes.values()][0]?.server}:${process.pid}:${process.started}`;
        const liveKeys = new Set(relevant?.map(cacheKey));
        for (const [key, value] of argvCache)
          if (!liveKeys.has(key) || now - value.at >= 1000)
            argvCache.delete(key);
        if (relevant) {
          const missing = relevant.filter(
            (process) => !argvCache.has(cacheKey(process)),
          );
          const args = yield* unavailable(ports.arguments(missing));
          for (const process of relevant) {
            const cached = argvCache.get(cacheKey(process));
            const argv = cached?.argv ?? args?.get(process.pid);
            if (argv?.length) {
              if (!cached) argvCache.set(cacheKey(process), { argv, at: now });
              process.argv = argv;
            }
          }
        }
        const observations = new Map<string, AgentObservation>();
        const captures = yield* Effect.all(
          [...panes.values()].map((pane) =>
            Effect.gen(function* () {
              if (pane.dead) return undefined;
              const recognition = relevant
                ? paneAgent(pane, relevant)
                : undefined;
              const identity =
                recognition?.kind === "identified" ? recognition : undefined;
              const direct = identifyAgent(pane.command);
              const prefix = `${pane.server}:${pane.paneId}:${pane.initialPid}:${pane.command}:`;
              const prior = previous.observations.get(pane.paneId);
              if (!identity) {
                // Verified shell/background transition clears state. Failed process
                // inspection keeps direct identity but cannot claim a live state.
                if (
                  !processes &&
                  (direct || prior?.generation.startsWith(prefix))
                ) {
                  const samePane = prior?.generation.startsWith(prefix);
                  const agent = direct ?? prior?.agent;
                  if (!agent) return undefined;
                  observations.set(
                    pane.paneId,
                    reconcileAgent(
                      samePane ? prior : undefined,
                      agent,
                      samePane && prior ? prior.generation : prefix,
                      undefined,
                      now,
                      "process_inspection_unavailable",
                    ),
                  );
                } else if (
                  prior &&
                  relevant &&
                  recognition?.kind === "arguments_unavailable" &&
                  foregroundProcesses(relevant, pane.tty).some(
                    (process) =>
                      prior.generation ===
                      `${prefix}${process.pid}:${process.started}:${process.pgid}`,
                  )
                ) {
                  observations.set(
                    pane.paneId,
                    reconcileAgent(
                      prior,
                      prior.agent,
                      prior.generation,
                      undefined,
                      now,
                      "arguments_unavailable",
                    ),
                  );
                }
                return undefined;
              }
              if (direct && direct !== identity.agent) return undefined;
              const generation = `${prefix}${identity.generation}`;
              const result = yield* ports.capture(pane.paneId).pipe(
                Effect.match({
                  onSuccess: (screen) => ({
                    screen,
                    error: undefined as string | undefined,
                  }),
                  onFailure: (error) => ({
                    screen: undefined,
                    error: observationFailureReason(error),
                  }),
                }),
              );
              return {
                pane,
                identity,
                generation,
                observedAt: ports.now(),
                ...result,
              };
            }),
          ),
          { concurrency: 4 },
        );
        const active = captures.filter((capture) => capture !== undefined);
        if (!active.length && !observations.size)
          return { observations, memberships };
        // The title and capture are not atomic; reject obsolete foreground jobs
        // and refreshed titles that disagree with the captured metadata.
        const [after, afterProcesses] = yield* Effect.all(
          [unavailable(ports.discover()), unavailable(ports.processes())],
          { concurrency: 2 },
        );
        const afterMap = new Map(after?.map((pane) => [pane.paneId, pane]));
        // Confirmed tmux invalidations do not depend on process inspection.
        // Also clear retained observations for panes that skipped capture.
        const invalidatedPanes = new Set<string>();
        if (after) {
          for (const pane of panes.values()) {
            const latest = afterMap.get(pane.paneId);
            if (
              !latest ||
              latest.dead ||
              latest.server !== pane.server ||
              latest.initialPid !== pane.initialPid ||
              latest.command !== pane.command ||
              latest.tty !== pane.tty
            ) {
              invalidatedPanes.add(pane.paneId);
              observations.delete(pane.paneId);
            }
          }
        }
        if (afterProcesses) {
          const args = yield* unavailable(
            ports.arguments(
              afterProcesses.filter((process) =>
                [...panes.values()].some(
                  (pane) => foregroundProcesses([process], pane.tty).length,
                ),
              ),
            ),
          );
          for (const process of afterProcesses)
            process.argv = args?.get(process.pid);
        }
        const validate = (
          pane: AgentPaneMetadata,
          expected: Pick<AgentObservation, "agent" | "generation">,
        ) => {
          const recognition = afterProcesses
            ? paneAgent(pane, afterProcesses)
            : undefined;
          const identity =
            recognition?.kind === "identified" ? recognition : undefined;
          const prefix = `${pane.server}:${pane.paneId}:${pane.initialPid}:${pane.command}:`;
          const sameJob =
            afterProcesses &&
            foregroundProcesses(afterProcesses, pane.tty).some(
              (process) =>
                `${prefix}${process.pid}:${process.started}:${process.pgid}` ===
                expected.generation,
            );
          const invalid =
            !!afterProcesses &&
            (!sameJob ||
              (identity &&
                (`${prefix}${identity.generation}` !== expected.generation ||
                  identity.agent !== expected.agent)) ||
              recognition?.kind === "ambiguous" ||
              recognition?.kind === "unrecognized");
          return { recognition, identity, invalid };
        };
        // These observations skipped capture because initial inspection failed.
        // A successful recheck still invalidates verified exits/replacements;
        // surviving observations stay stale without renewing their evidence.
        for (const [id, retained] of observations) {
          const pane = afterMap.get(id) ?? panes.get(id);
          if (pane && validate(pane, retained).invalid) observations.delete(id);
        }
        for (const capture of active) {
          if (invalidatedPanes.has(capture.pane.paneId)) continue;
          const latest = afterMap.get(capture.pane.paneId);
          const { recognition, identity, invalid } = validate(
            latest ?? capture.pane,
            {
              agent: capture.identity.agent,
              generation: capture.generation,
            },
          );
          if (invalid) continue;
          const previousEvidence = evidence.get(evidenceKey(capture.pane));
          const screenHash =
            capture.screen === undefined ? undefined : Bun.hash(capture.screen);
          const titleHash = latest ? Bun.hash(latest.title) : undefined;
          const changedGeneration =
            previousEvidence &&
            previousEvidence.generation !== capture.generation;
          const screenInvalid = !!(
            previousEvidence &&
            previousEvidence.screen === screenHash &&
            (changedGeneration || previousEvidence.screenInvalid)
          );
          const titleInvalid = !!(
            previousEvidence &&
            previousEvidence.title === titleHash &&
            (changedGeneration || previousEvidence.titleInvalid)
          );
          const classify = (title: string) =>
            capture.screen === undefined
              ? undefined
              : classifyAgent(
                  capture.identity.agent,
                  screenInvalid ? "" : capture.screen,
                  titleInvalid ? "" : title,
                );
          const before = classify(capture.pane.title);
          const next = latest ? classify(latest.title) : undefined;
          const coherent =
            latest &&
            identity &&
            before?.state === next?.state &&
            before?.skip === next?.skip &&
            latest.width === capture.pane.width &&
            latest.height === capture.pane.height;
          if (coherent && screenHash !== undefined && titleHash !== undefined)
            evidence.set(evidenceKey(capture.pane), {
              generation: capture.generation,
              screen: screenHash,
              title: titleHash,
              screenInvalid,
              titleInvalid,
            });
          if (next?.state === "unknown" && (screenInvalid || titleInvalid))
            next.rule = "generation_changed";
          const unavailableReason =
            !after || !afterProcesses
              ? "validation_unavailable"
              : recognition?.kind === "arguments_unavailable"
                ? "arguments_unavailable"
                : "sample_changed";
          observations.set(
            capture.pane.paneId,
            reconcileAgent(
              previous.observations.get(capture.pane.paneId),
              capture.identity.agent,
              capture.generation,
              coherent ? next : undefined,
              capture.observedAt,
              capture.screen === undefined
                ? `capture_${capture.error}`
                : unavailableReason,
            ),
          );
        }
        return { observations, memberships };
      }),
  };
}

export const liveAgentService = makeAgentService({
  discover: discoverAgentPanes,
  processes: discoverForegroundProcesses,
  arguments: readRuntimeArguments,
  capture: captureAgentPane,
  now: Date.now,
});
