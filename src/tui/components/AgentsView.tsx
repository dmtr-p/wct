import { Box, Text } from "ink";
import { useMemo } from "react";
import type { AgentState } from "../../services/agent-model";
import type { AgentSnapshot } from "../../services/agent-service";
import type { TmuxPaneInfo } from "../../services/tmux";
import {
  type AgentListItem,
  buildAgentList,
  insertAgentConfirmationRows,
} from "../agent-view";
import { useAgentNavigation } from "../hooks/useAgentNavigation";
import type { RepoInfo } from "../hooks/useRegistry";
import type { Mode } from "../types";
import { toSingleLine, truncateBranch } from "../utils/truncate";
import { ConfirmModal, confirmModalRowCount } from "./ConfirmModal";
import {
  SELECTED_ROW_BACKGROUND,
  SELECTED_ROW_FOREGROUND,
  selectedRowFill,
} from "./tree-row";

interface Props {
  repos: readonly RepoInfo[];
  agents: AgentSnapshot;
  panes: ReadonlyMap<string, readonly TmuxPaneInfo[]>;
  maxWidth: number;
  viewportRows: number;
  isActive: boolean;
  onJump: (paneId: string) => void;
  onKill: (item: AgentListItem) => void;
  confirmation?: {
    mode: Extract<Mode, { type: "ConfirmAgentKill" }>;
    width: number;
    onConfirm: () => void;
    onCancel: () => void;
  };
}

const STATE_COLORS: Record<AgentState, string> = {
  working: "yellow",
  blocked: "red",
  idle: "green",
  unknown: "gray",
};
const STATE_MARKERS: Record<AgentState, string> = {
  working: "●",
  blocked: "◉",
  idle: "○",
  unknown: "?",
};

export function AgentsView({
  repos,
  agents,
  panes,
  maxWidth,
  viewportRows,
  isActive,
  onJump,
  onKill,
  confirmation,
}: Props) {
  const { items, rows: baseRows } = useMemo(
    () => buildAgentList(repos, agents, panes),
    [repos, agents, panes],
  );
  // Reserve the modal's borders, spacer, and action row before wrapping copy.
  const maxQuestionRows = Math.max(1, viewportRows - 4);
  const rows = useMemo(() => {
    if (!confirmation) return baseRows;
    const targetIndex = items.findIndex(
      (item) => item.id === confirmation.mode.itemId,
    );
    return insertAgentConfirmationRows(
      baseRows,
      targetIndex,
      confirmModalRowCount(
        confirmation.mode,
        confirmation.width,
        maxQuestionRows,
      ),
    );
  }, [baseRows, items, confirmation, maxQuestionRows]);
  const { selectedIndex, offset, hoveredItemIndex } = useAgentNavigation(
    items,
    rows,
    viewportRows,
    isActive,
    onJump,
    onKill,
  );

  if (!rows.length) {
    return (
      <Text dimColor wrap="truncate">
        {" "}
        No running agents in registered projects
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      {rows.slice(offset, offset + viewportRows).map((row) => {
        if (row.kind === "confirmation") {
          if (row.partIndex !== 0 || !confirmation) return null;
          return (
            <ConfirmModal
              key="confirmation"
              {...confirmation}
              maxQuestionRows={maxQuestionRows}
            />
          );
        }
        if (row.kind === "project") {
          return (
            <Text key={row.id} bold wrap="truncate">
              {truncateBranch(` ${toSingleLine(row.project)}`, maxWidth)}
            </Text>
          );
        }
        const item = items[row.itemIndex];
        if (!item) return null;
        const { observation } = item;
        const selected = row.itemIndex === selectedIndex;
        const highlighted =
          selected || (isActive && hoveredItemIndex === row.itemIndex);
        const state =
          observation.freshness === "unavailable"
            ? "unknown"
            : observation.state;
        const freshness =
          observation.freshness === "fresh"
            ? ""
            : ` (${observation.freshness})`;
        const content = truncateBranch(
          row.part === "name"
            ? `  ${STATE_MARKERS[state]} ${toSingleLine(item.branch)}${item.title ? ` · ${item.title}` : ""}`
            : `    ${state} · ${observation.agent}${freshness}`,
          maxWidth,
        );
        return (
          <Text
            key={`${item.id}:${row.part}`}
            color={
              selected
                ? SELECTED_ROW_FOREGROUND
                : row.part === "status"
                  ? STATE_COLORS[state]
                  : undefined
            }
            backgroundColor={selected ? SELECTED_ROW_BACKGROUND : undefined}
            bold={row.part === "name" && highlighted}
            wrap="truncate"
          >
            {content}
            {selectedRowFill(selected, maxWidth, content)}
          </Text>
        );
      })}
    </Box>
  );
}
