import { Box, Text } from "ink";

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
