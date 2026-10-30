import type { Effect } from "effect";
import { useCallback, useEffect, useState } from "react";
import {
  type TmuxClient,
  type TmuxPaneInfo,
  TmuxService,
} from "../../services/tmux";
import { tuiRuntime } from "../runtime";
import { useRefreshGeneration } from "./useRefreshGeneration";

const EMPTY_PANES: Map<string, TmuxPaneInfo[]> = new Map();

export interface TmuxSessionInfo {
  name: string;
  attached: boolean;
}

export type TmuxClientDiscovery =
  | { type: "none" }
  | { type: "single"; client: TmuxClient }
  | { type: "multiple" }
  | { type: "error" };

async function runPaneAction<A, E>(effect: Effect.Effect<A, E, TmuxService>) {
  try {
    await tuiRuntime.runPromise(effect);
    return true;
  } catch {
    return false;
  }
}

export function useTmux() {
  const [client, setClient] = useState<TmuxClient | null>(null);
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [panes, setPanes] = useState<Map<string, TmuxPaneInfo[]>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const { begin: beginSessions } = useRefreshGeneration();
  const { begin: beginClient, invalidate: invalidateClient } =
    useRefreshGeneration();

  const refreshSessions = useCallback(
    async (signal?: AbortSignal): Promise<TmuxSessionInfo[]> => {
      const request = beginSessions(signal);
      if (!request.isActive()) return [];
      const opts = signal ? { signal } : undefined;
      try {
        const result = await tuiRuntime.runPromise(
          TmuxService.use((service) => service.listSessions),
          opts,
        );
        if (!request.isActive()) return [];
        const parsed = (result ?? []).map((session) => ({
          name: session.name,
          attached: session.attached,
        }));
        const paneMap = new Map<string, TmuxPaneInfo[]>();
        await Promise.all(
          parsed.map(async (session) => {
            try {
              const result = await tuiRuntime.runPromise(
                TmuxService.use((service) => service.listPanes(session.name)),
                opts,
              );
              paneMap.set(session.name, result);
            } catch {
              // A failed session must not prevent refreshing other sessions' panes.
            }
          }),
        );
        if (!request.isActive()) return [];
        // Publish sessions and their panes together, under the same generation.
        if (request.accept()) {
          setSessions(parsed);
          setPanes(paneMap);
        }
        return parsed;
      } catch {
        if (request.accept()) {
          setSessions([]);
          setPanes(EMPTY_PANES);
        }
        return [];
      }
    },
    [beginSessions],
  );

  const discoverClient = useCallback(
    async (signal?: AbortSignal): Promise<TmuxClientDiscovery> => {
      const request = beginClient(signal);
      if (!request.isActive()) return { type: "error" };
      const opts = signal ? { signal } : undefined;
      try {
        const clients = await tuiRuntime.runPromise(
          TmuxService.use((service) => service.listClients),
          opts,
        );
        if (!request.isActive()) return { type: "error" };

        if (clients.length === 0) {
          if (request.accept()) {
            setError("No tmux client found — start tmux in the other pane");
            setClient(null);
          }
          return { type: "none" };
        }

        if (clients.length === 1) {
          const [onlyClient] = clients;
          const client = onlyClient ?? null;
          if (request.accept()) {
            setClient(client);
            setError(null);
          }
          return client ? { type: "single", client } : { type: "none" };
        }

        if (request.accept()) {
          setClient(null);
          setError(null);
        }
        return { type: "multiple" };
      } catch {
        if (request.accept()) {
          setError("No tmux client found — start tmux in the other pane");
          setClient(null);
        }
        return { type: "error" };
      }
    },
    [beginClient],
  );

  const switchSession = useCallback(
    async (sessionName: string, activeClient: TmuxClient | null = client) => {
      if (!activeClient) return false;
      const request = beginClient();
      if (!request.isActive()) return false;
      try {
        await tuiRuntime.runPromise(
          TmuxService.use((service) =>
            service.switchClientToPane(activeClient.tty, `=${sessionName}`),
          ),
        );
        if (request.isActive() && invalidateClient()) {
          setClient({ ...activeClient, session: sessionName });
          setError(null);
        }
        return true;
      } catch {
        return false;
      }
    },
    [client, beginClient, invalidateClient],
  );

  const detachClient = useCallback(
    async (activeClient: TmuxClient | null = client) => {
      if (!activeClient) return false;
      const request = beginClient();
      if (!request.isActive()) return false;
      try {
        await tuiRuntime.runPromise(
          TmuxService.use((service) => service.detachClient(activeClient.tty)),
        );
        if (request.isActive() && invalidateClient()) {
          setClient(null);
          setError(null);
        }
        return true;
      } catch {
        return false;
      }
    },
    [client, beginClient, invalidateClient],
  );

  const jumpToPane = useCallback(
    async (paneId: string) => {
      if (!client) return false;
      try {
        await tuiRuntime.runPromise(
          TmuxService.use((service) =>
            service.switchClientToPane(client.tty, paneId),
          ),
        );
        await discoverClient();
        return true;
      } catch {
        return false;
      }
    },
    [client, discoverClient],
  );

  const zoomPane = useCallback(
    async (paneId: string) =>
      runPaneAction(
        TmuxService.use((service) => service.togglePaneZoom(paneId)),
      ),
    [],
  );

  const killPane = useCallback(
    async (paneId: string) =>
      runPaneAction(TmuxService.use((service) => service.killPane(paneId))),
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void discoverClient(controller.signal);
    void refreshSessions(controller.signal);
    return () => controller.abort();
  }, [discoverClient, refreshSessions]);

  return {
    client,
    sessions,
    panes,
    error,
    switchSession,
    detachClient,
    jumpToPane,
    zoomPane,
    killPane,
    refreshSessions,
    discoverClient,
  };
}
