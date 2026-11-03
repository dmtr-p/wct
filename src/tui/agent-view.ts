import { basename } from "node:path";
import type { AgentObservation } from "../services/agent-model";
import type { AgentSnapshot } from "../services/agent-service";
import { formatSessionName, type TmuxPaneInfo } from "../services/tmux";
import type { RepoInfo } from "./hooks/useRegistry";
import { toSingleLine } from "./utils/truncate";

export interface AgentListItem {
  id: string;
  paneId: string;
  branch: string;
  title: string;
  observation: AgentObservation;
}

export type AgentListRow =
  | { kind: "project"; id: string; project: string }
  | { kind: "agent"; itemIndex: number; part: "name" | "status" }
  | { kind: "confirmation"; partIndex: number };

export function insertAgentConfirmationRows(
  rows: AgentListRow[],
  itemIndex: number,
  rowCount: number,
): AgentListRow[] {
  const anchor = rows.findIndex(
    (row) =>
      row.kind === "agent" &&
      row.itemIndex === itemIndex &&
      row.part === "status",
  );
  // Keep an in-flight confirmation visible if its target disappears before
  // tmux acknowledges the kill; App owns closing it when the action settles.
  const insertionIndex = anchor < 0 ? rows.length : anchor + 1;
  const confirmationRows: AgentListRow[] = Array.from(
    { length: rowCount },
    (_, partIndex) => ({ kind: "confirmation", partIndex }),
  );
  return [
    ...rows.slice(0, insertionIndex),
    ...confirmationRows,
    ...rows.slice(insertionIndex),
  ];
}

export function buildAgentList(
  repos: readonly RepoInfo[],
  snapshot: AgentSnapshot,
  panes: ReadonlyMap<string, readonly TmuxPaneInfo[]>,
): { items: AgentListItem[]; rows: AgentListRow[] } {
  const items: AgentListItem[] = [];
  const rows: AgentListRow[] = [];
  for (const repo of repos) {
    const seen = new Set<string>();
    const projectItems: AgentListItem[] = [];
    for (const worktree of repo.worktrees) {
      const session = formatSessionName(basename(worktree.path));
      const sessionPanes = new Map(
        panes.get(session)?.map((pane) => [pane.paneId, pane]),
      );
      for (const paneId of snapshot.memberships.get(session) ?? []) {
        const observation = snapshot.observations.get(paneId);
        if (!observation || seen.has(paneId)) continue;
        seen.add(paneId);
        projectItems.push({
          id: JSON.stringify([repo.repoPath, paneId, observation.generation]),
          paneId,
          branch: worktree.branch,
          title: toSingleLine(sessionPanes.get(paneId)?.title ?? ""),
          observation,
        });
      }
    }
    if (!projectItems.length) continue;
    rows.push({ kind: "project", id: repo.repoPath, project: repo.project });
    for (const item of projectItems) {
      const itemIndex = items.length;
      items.push(item);
      rows.push({ kind: "agent", itemIndex, part: "name" });
      rows.push({ kind: "agent", itemIndex, part: "status" });
    }
  }
  return { items, rows };
}
