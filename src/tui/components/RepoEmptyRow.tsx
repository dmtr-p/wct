import { Box, Text } from "ink";

/**
 * The `(no worktrees)` line rendered beneath an expanded repo with zero
 * worktrees. Split out of `RepoNode` so the visual-row model is terminal-row
 * accurate: one React element per terminal row.
 */
export function RepoEmptyRow() {
  return (
    <Box>
      <Text>{"    "}</Text>
      <Text dimColor>(no worktrees)</Text>
    </Box>
  );
}
