import { Box, Text } from "ink";
import React from "react";

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

  return (
    <Box>
      <Text color={isSelected ? "cyan" : "yellow"} bold={isSelected}>
        {arrow} {project}
        <Text dimColor>{suffix}</Text>
      </Text>
    </Box>
  );
}
