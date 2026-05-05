import { Box, Text } from "ink";
import { truncateBranch } from "../utils/truncate";

interface Props {
  project: string;
  expanded: boolean;
  isSelected: boolean;
  isChildSelected: boolean;
  worktreeCount: number;
  maxWidth: number;
}

export function RepoNode({
  project,
  expanded,
  isSelected,
  isChildSelected,
  worktreeCount,
  maxWidth,
}: Props) {
  const arrow = expanded ? "▼" : "▶";
  const active = isSelected || isChildSelected;
  const prefix = isSelected ? "❯ " : "  ";
  // overhead: prefix (2) + arrow (1) + space (1) = 4
  const displayProject = truncateBranch(project, maxWidth - 4);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isSelected ? "cyan" : undefined}>{prefix}</Text>
        <Text color={isSelected ? "cyan" : "yellow"} bold={active}>
          {arrow} {displayProject}
        </Text>
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
