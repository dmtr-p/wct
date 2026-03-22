import { useCallback, useEffect, useState } from "react";
import type { PaneInfo } from "../types";

interface TmuxClient {
  tty: string;
  session: string;
}

export interface TmuxSessionInfo {
  name: string;
  attached: boolean;
}

async function runTmux(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`tmux ${args[0]} failed`);
  }
  return text.trim();
}

export function useTmux() {
  const [client, setClient] = useState<TmuxClient | null>(null);
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [panes, setPanes] = useState<Map<string, PaneInfo[]>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const refreshPanes = useCallback(async (sessionList: TmuxSessionInfo[]) => {
    const paneMap = new Map<string, PaneInfo[]>();
    await Promise.all(
      sessionList.map(async (session) => {
        try {
          const result = await runTmux([
            "list-panes",
            "-s",
            "-t",
            session.name,
            "-F",
            "#{pane_index}:#{pane_current_command}:#{window_name}",
          ]);
          const lines = result.split("\n").filter(Boolean);
          paneMap.set(
            session.name,
            lines.map((line) => {
              const [idx, cmd, win] = line.split(":");
              return {
                index: Number(idx),
                command: cmd || "",
                window: win || "",
              };
            }),
          );
        } catch {
          // Ignore pane fetch errors
        }
      }),
    );
    setPanes(paneMap);
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const output = await runTmux([
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_attached}",
      ]);
      const parsed = output
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          const [name, attached] = line.split("\t");
          return name ? [{ name, attached: attached === "1" }] : [];
        });
      setSessions(parsed);
      refreshPanes(parsed);
    } catch {
      setSessions([]);
    }
  }, [refreshPanes]);

  const discoverClient = useCallback(async () => {
    try {
      const output = await runTmux([
        "list-clients",
        "-F",
        "#{client_tty}\t#{client_session}",
      ]);
      const clients = output
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          const [tty, session] = line.split("\t");
          return tty && session ? [{ tty, session }] : [];
        });

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
        await runTmux(["switch-client", "-c", client.tty, "-t", sessionName]);
        return true;
      } catch {
        return false;
      }
    },
    [client],
  );

  const jumpToPane = useCallback(
    async (sessionName: string, pane: string) => {
      if (!client) return false;
      try {
        await runTmux(["switch-client", "-c", client.tty, "-t", sessionName]);
        await runTmux(["select-pane", "-t", pane]);
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
