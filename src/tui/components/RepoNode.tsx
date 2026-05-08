import { Box, Text } from "ink";
import { truncateBranch } from "../utils/truncate";

interface Props {
  project: string;
  expanded: boolean;
  isSelected: boolean;
  isChildSelected: boolean;
  worktreeCount: number;
  maxWidth: number;
  isRefreshing?: boolean;
  hasError?: boolean;
}

export function RepoNode({
  project,
  expanded,
  isSelected,
  isChildSelected,
  worktreeCount,
  maxWidth,
  isRefreshing,
  hasError,
}: Props) {
  const arrow = expanded ? "▼" : "▶";
  const active = isSelected || isChildSelected;
  const prefix = isSelected ? "❯ " : "  ";
  // overhead: prefix (2) + arrow (1) + space (1) = 4
  // plus " ↻" (2) when refreshing, plus " ⚠" (2) when errored
  const refreshSuffix = isRefreshing ? " ↻" : "";
  const errorSuffix = hasError ? " ⚠" : "";
  const displayProject = truncateBranch(
    project,
    maxWidth - 4 - refreshSuffix.length - errorSuffix.length,
  );

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isSelected ? "cyan" : undefined}>{prefix}</Text>
        <Text color={isSelected ? "cyan" : "yellow"} bold={active}>
          {arrow} {displayProject}
        </Text>
        {isRefreshing ? <Text dimColor> ↻</Text> : null}
        {hasError ? <Text color="yellow"> ⚠</Text> : null}
      </Box>
      {expanded && worktreeCount === 0 ? (
        <Box>
          <Text>{"    "}</Text>
          <Text dimColor>(no worktrees)</Text>
        </Box>
      ) : null}
    </Box>
  );
}
