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

  const refreshPanes = useCallback(async (sessionList: TmuxSessionInfo[]) => {
    const paneMap = new Map<string, TmuxPaneInfo[]>();
    await Promise.all(
      sessionList.map(async (session) => {
        try {
          const result = await tuiRuntime.runPromise(
            TmuxService.use((s) => s.listPanes(session.name)),
          );
          paneMap.set(session.name, result);
        } catch {
          // Ignore pane fetch errors
        }
      }),
    );
    setPanes(paneMap);
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const result = await tuiRuntime.runPromise(
        TmuxService.use((s) => s.listSessions()),
      );
      if (!result) {
        setSessions([]);
        setPanes(EMPTY_PANES);
        return;
      }
      const parsed = result.map((s) => ({
        name: s.name,
        attached: s.attached,
      }));
      setSessions(parsed);
      await refreshPanes(parsed);
    } catch {
      setSessions([]);
      setPanes(EMPTY_PANES);
    }
  }, [refreshPanes]);

  const discoverClient = useCallback(async () => {
    try {
      const clients = await tuiRuntime.runPromise(
        TmuxService.use((s) => s.listClients()),
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
          TmuxService.use((s) =>
            s.switchClientToPane(client.tty, `=${sessionName}`),
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
          TmuxService.use((s) => s.switchClientToPane(client.tty, paneId)),
        );
        return true;
      } catch {
        return false;
      }
    },
    [client],
  );

  useEffect(() => {
    discoverClient();
    refreshSessions();
  }, [discoverClient, refreshSessions]);

  return {
    client,
    sessions,
    panes,
    error,
    switchSession,
    jumpToPane,
    refreshSessions,
    discoverClient,
  };
}
