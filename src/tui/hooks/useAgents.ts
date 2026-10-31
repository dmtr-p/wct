import { basename } from "node:path";
import { Clock, Effect, Queue } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_FRESHNESS_MS,
  agentSummary,
  expireAgentObservation,
  reconcileAgent,
  sameAgentPresentation,
} from "../../services/agent-model";
import {
  AgentService,
  type AgentSnapshot,
  emptyAgentSnapshot,
} from "../../services/agent-service";
import type { WorkspaceIdentityKey } from "../../services/identities";
import { formatSessionName } from "../../services/tmux";
import { workspaceIdentityKey } from "../lifecycle";
import { tuiRuntime } from "../runtime";
import type { RepoInfo } from "./useRegistry";

export function sameAgentSnapshot(a: AgentSnapshot, b: AgentSnapshot): boolean {
  return (
    a.observations.size === b.observations.size &&
    [...a.observations].every(([id, value]) =>
      sameAgentPresentation(value, b.observations.get(id)),
    ) &&
    a.memberships.size === b.memberships.size &&
    [...a.memberships].every(([session, ids]) => {
      const next = b.memberships.get(session);
      return next?.size === ids.size && [...ids].every((id) => next.has(id));
    })
  );
}

export interface WorkspaceAgentSnapshot extends AgentSnapshot {
  summaries: Map<WorkspaceIdentityKey, string>;
}

export function workspaceAgentSummaries(
  repos: readonly RepoInfo[],
  snapshot: AgentSnapshot,
): Map<WorkspaceIdentityKey, string> {
  const summaries = new Map<WorkspaceIdentityKey, string>();
  for (const repo of repos)
    for (const worktree of repo.worktrees) {
      const ids = snapshot.memberships.get(
        formatSessionName(basename(worktree.path)),
      );
      const observations = [...(ids ?? [])].flatMap((id) => {
        const observation = snapshot.observations.get(id);
        return observation ? [observation] : [];
      });
      summaries.set(
        workspaceIdentityKey(repo.repoPath, worktree.branch),
        agentSummary(observations),
      );
    }
  return summaries;
}

export function useAgents(repos: readonly RepoInfo[]): WorkspaceAgentSnapshot {
  const sessionsKey = JSON.stringify(
    [
      ...new Set(
        repos.flatMap((repo) =>
          repo.worktrees.map((worktree) =>
            formatSessionName(basename(worktree.path)),
          ),
        ),
      ),
    ].sort(),
  );
  const sessions = useMemo(
    () => new Set<string>(JSON.parse(sessionsKey)),
    [sessionsKey],
  );
  const targetSessions = useRef(sessions);
  targetSessions.current = sessions;
  const [snapshot, setSnapshot] = useState(emptyAgentSnapshot);
  const latest = useRef(snapshot);
  const presentation = useRef(snapshot);
  const request = useRef<(() => void) | undefined>(undefined);
  const requestedTargets = useRef(sessions);
  useEffect(() => {
    const controller = new AbortController();
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const present = (raw: AgentSnapshot) => {
      const next = {
        ...raw,
        observations: new Map(
          [...raw.observations].map(([id, observation]) => [
            id,
            expireAgentObservation(observation, Date.now()),
          ]),
        ),
      };
      if (!sameAgentSnapshot(presentation.current, next)) {
        presentation.current = next;
        setSnapshot(next);
      }
    };
    const armExpiry = () => {
      if (expiryTimer !== undefined) clearTimeout(expiryTimer);
      const now = Date.now();
      let deadline = Infinity;
      for (const observation of latest.current.observations.values()) {
        if (observation.freshness === "unavailable") continue;
        const at =
          observation.freshness === "stale"
            ? (observation.lastValid?.at ?? observation.observedAt)
            : observation.observedAt;
        const expires = at + AGENT_FRESHNESS_MS;
        if (expires > now) deadline = Math.min(deadline, expires);
      }
      if (Number.isFinite(deadline))
        expiryTimer = setTimeout(() => {
          present(latest.current);
          armExpiry();
        }, deadline - now);
    };
    const publish = (next: AgentSnapshot) => {
      latest.current = next;
      present(next);
      armExpiry();
    };
    const worker = Effect.gen(function* () {
      const signals = yield* Effect.acquireRelease(
        Queue.dropping<void>(1),
        (queue) => Queue.shutdown(queue),
      );
      yield* Effect.sync(() => {
        request.current = () => {
          if (!controller.signal.aborted) Queue.offerUnsafe(signals, undefined);
        };
      });
      yield* Queue.offer(signals, undefined);
      yield* Queue.take(signals);
      return yield* Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const targets = targetSessions.current;
        const next = yield* AgentService.use((service) =>
          service.observe(targets, latest.current),
        ).pipe(
          Effect.catchDefect(() =>
            Effect.sync(() => ({
              memberships: latest.current.memberships,
              observations: new Map(
                [...latest.current.observations].map(([id, prior]) => [
                  id,
                  reconcileAgent(
                    prior,
                    prior.agent,
                    prior.generation,
                    undefined,
                    Date.now(),
                    "runtime_unavailable",
                  ),
                ]),
              ),
            })),
          ),
        );
        yield* Effect.sync(() => {
          if (!controller.signal.aborted && targets === targetSessions.current)
            publish(next);
        });
        const now = yield* Clock.currentTimeMillis;
        // An early request consumes the pending signal and cancels this cycle's
        // cadence timer, so it cannot trigger an extra observation later.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.sleep(Math.max(0, 1000 - (now - started))).pipe(
              Effect.andThen(Queue.offer(signals, undefined)),
              Effect.forkScoped,
            );
            yield* Queue.take(signals);
          }),
        );
      }).pipe(Effect.forever);
    }).pipe(Effect.scoped);
    void tuiRuntime
      .runPromise(worker, { signal: controller.signal })
      .catch(() => {});
    return () => {
      request.current = undefined;
      controller.abort();
      if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    };
  }, []);
  useEffect(() => {
    if (requestedTargets.current === sessions) return;
    requestedTargets.current = sessions;
    request.current?.();
  }, [sessions]);
  const summaries = useMemo(
    () => workspaceAgentSummaries(repos, snapshot),
    [repos, snapshot],
  );
  return useMemo(() => ({ ...snapshot, summaries }), [snapshot, summaries]);
}
