import { useCallback, useEffect, useState } from "react";
import {
  type TmuxClient,
  type TmuxPaneInfo,
  TmuxService,
} from "../../services/tmux";
import { tuiRuntime } from "../runtime";

const EMPTY_PANES: Map<string, TmuxPaneInfo[]> = new Map();

export interface TmuxSessionInfo {
  name: string;
  attached: boolean;
}

export function useTmux() {
  const [client, setClient] = useState<TmuxClient | null>(null);
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [panes, setPanes] = useState<Map<string, TmuxPaneInfo[]>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const refreshPanes = useCallback(
    async (sessionList: TmuxSessionInfo[], signal?: AbortSignal) => {
      const opts = signal ? { signal } : undefined;
      const paneMap = new Map<string, TmuxPaneInfo[]>();
      await Promise.all(
        sessionList.map(async (session) => {
          try {
            const result = await tuiRuntime.runPromise(
              TmuxService.use((service) => service.listPanes(session.name)),
              opts,
            );
            paneMap.set(session.name, result);
          } catch {
            // Ignore pane fetch errors
          }
        }),
      );
      setPanes(paneMap);
    },
    [],
  );

  const refreshSessions = useCallback(
    async (signal?: AbortSignal) => {
      const opts = signal ? { signal } : undefined;
      try {
        const result = await tuiRuntime.runPromise(
          TmuxService.use((service) => service.listSessions()),
          opts,
        );
        if (!result) {
          setSessions([]);
          setPanes(EMPTY_PANES);
          return;
        }
        const parsed = result.map((session) => ({
          name: session.name,
          attached: session.attached,
        }));
        setSessions(parsed);
        await refreshPanes(parsed, signal);
      } catch {
        setSessions([]);
        setPanes(EMPTY_PANES);
      }
    },
    [refreshPanes],
  );

  const discoverClient = useCallback(async (signal?: AbortSignal) => {
    const opts = signal ? { signal } : undefined;
    try {
      const clients = await tuiRuntime.runPromise(
        TmuxService.use((service) => service.listClients()),
        opts,
      );

      if (clients.length === 0) {
        setError("No tmux client found — start tmux in the other pane");
        setClient(null);
      } else if (clients.length === 1) {
        const [onlyClient] = clients;
        setClient(onlyClient ?? null);
        setError(null);
      } else {
        setError(
          `Multiple tmux clients found (${clients.length}). Multi-client support coming soon.`,
        );
        setClient(null);
      }
    } catch {
      setError("No tmux client found — start tmux in the other pane");
      setClient(null);
    }
  }, []);

  const switchSession = useCallback(
    async (sessionName: string) => {
      if (!client) return false;
      try {
        await tuiRuntime.runPromise(
          TmuxService.use((service) =>
            service.switchClientToPane(client.tty, `=${sessionName}`),
          ),
        );
        return true;
      } catch {
        return false;
      }
    },
    [client],
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
        return true;
      } catch {
        return false;
      }
    },
    [client],
  );

  const zoomPane = useCallback(async (paneId: string) => {
    try {
      await tuiRuntime.runPromise(
        TmuxService.use((service) => service.togglePaneZoom(paneId)),
      );
      return true;
    } catch {
      return false;
    }
  }, []);

  const killPane = useCallback(async (paneId: string) => {
    try {
      await tuiRuntime.runPromise(
        TmuxService.use((service) => service.killPane(paneId)),
      );
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    discoverClient(controller.signal);
    refreshSessions(controller.signal);
    return () => controller.abort();
  }, [discoverClient, refreshSessions]);

  return {
    client,
    sessions,
    panes,
    error,
    switchSession,
    jumpToPane,
    zoomPane,
    killPane,
    refreshSessions,
    discoverClient,
  };
}
