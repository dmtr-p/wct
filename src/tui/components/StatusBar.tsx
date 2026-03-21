import { Box, Text } from "ink";
import React from "react";

interface Props {
  mode: "normal" | "search";
  searchQuery?: string;
}

export function StatusBar({ mode, searchQuery }: Props) {
  if (mode === "search") {
    return (
      <Box>
        <Text>/{searchQuery ?? ""}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>{"─".repeat(30)}</Text>
      <Text dimColor>{"↑↓:navigate  enter:switch  o:open"}</Text>
      <Text dimColor>{"c:close  j:jump  /:search  q:quit"}</Text>
    </Box>
  );
}
