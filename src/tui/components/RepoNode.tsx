import { Box, Text } from "ink";

interface Props {
  project: string;
  expanded: boolean;
  isSelected: boolean;
  worktreeCount: number;
}

export function RepoNode({
  project,
  expanded,
  isSelected,
  worktreeCount,
}: Props) {
  const arrow = expanded ? "\u25BC" : "\u25B6";
  const suffix = worktreeCount === 0 ? " (no worktrees)" : "";

  const prefix = isSelected ? "❯ " : "  ";

  return (
    <Box>
      <Text color={isSelected ? "cyan" : undefined}>{prefix}</Text>
      <Text
        color={isSelected ? "cyan" : "yellow"}
        bold={isSelected}
        inverse={isSelected}
      >
        {arrow} {project}
      </Text>
      <Text dimColor>{suffix}</Text>
    </Box>
  );
}
