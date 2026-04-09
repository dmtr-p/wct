import { Box, Text } from "ink";

interface Props {
  project: string;
  expanded: boolean;
  isSelected: boolean;
  isChildSelected: boolean;
  worktreeCount: number;
}

export function RepoNode({
  project,
  expanded,
  isSelected,
  isChildSelected,
  worktreeCount,
}: Props) {
  const arrow = expanded ? "\u25BC" : "\u25B6";
  const active = isSelected || isChildSelected;

  const prefix = isSelected ? "❯ " : "  ";

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isSelected ? "cyan" : undefined}>{prefix}</Text>
        <Text color={isSelected ? "cyan" : "yellow"} bold={active}>
          {arrow} {project}
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
