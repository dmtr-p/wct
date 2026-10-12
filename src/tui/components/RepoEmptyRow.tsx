import { Box, Text } from "ink";

/** Keep one terminal row so tree windowing and mouse hit-testing agree. */
export function RepoEmptyRow() {
  return (
    <Box>
      <Text wrap="truncate">
        {"   "}
        <Text dimColor>(no worktrees)</Text>
      </Text>
    </Box>
  );
}
