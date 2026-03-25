// src/tui/components/StatusBar.tsx
import { Box, Text, useStdout } from "ink";
import type { Mode } from "../types";

interface Props {
  mode: Mode;
  searchQuery?: string;
}

function getHints(mode: Mode): [string, string] {
  switch (mode.type) {
    case "Navigate":
      return [
        "↑↓:navigate  ←→:expand/collapse  space:switch  o:open",
        "c:close  j:jump  /:search  q:quit",
      ];
    case "Search":
      return ["type to filter", "esc:cancel  enter:done"];
    case "OpenModal":
      return ["", ""];
    case "Expanded":
      return [
        "↑↓:navigate  enter:action  ←:collapse  space:switch",
        "o:open  q:quit",
      ];
  }
}

export function StatusBar({ mode, searchQuery }: Props) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 50;
  const divider = "─".repeat(Math.max(1, cols));

  if (mode.type === "Search") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{divider}</Text>
        <Text color="cyan">/{searchQuery}</Text>
        <Text dimColor>{getHints(mode)[1]}</Text>
      </Box>
    );
  }

  const [line1, line2] = getHints(mode);
  return (
    <Box flexDirection="column">
      <Text dimColor>{divider}</Text>
      <Text dimColor>{line1}</Text>
      <Text dimColor>{line2}</Text>
    </Box>
  );
}
