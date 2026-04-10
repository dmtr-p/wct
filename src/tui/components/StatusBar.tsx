// src/tui/components/StatusBar.tsx
import { Box, Text, useStdout } from "ink";
import type { Mode } from "../types";

interface Props {
  mode: Mode;
  searchQuery?: string;
  selectedPaneRow?: boolean;
}

function getHints(mode: Mode, selectedPaneRow?: boolean): [string, string] {
  switch (mode.type) {
    case "Navigate":
      return [
        "↑↓:navigate  ←→:expand/collapse  space:switch  o:open",
        "c:close  /:search  q:quit",
      ];
    case "Search":
      return ["type to filter", "esc:cancel  enter:done"];
    case "OpenModal":
      return ["", ""];
    case "Expanded":
      if (selectedPaneRow) {
        return [
          "↑↓:navigate  ←:collapse  space:jump  z:zoom  x:kill",
          "/:search  q:quit",
        ];
      }
      return [
        "↑↓:navigate  ←:collapse  space:action  o:open",
        "/:search  q:quit",
      ];
    case "ConfirmKill":
      return ["Kill pane " + mode.label + "?", "enter:confirm  esc:cancel"];
  }
}

export function StatusBar({ mode, searchQuery, selectedPaneRow }: Props) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 50;
  const divider = "─".repeat(Math.max(1, cols));

  if (mode.type === "ConfirmKill") {
    const [line1, line2] = getHints(mode, selectedPaneRow);
    return (
      <Box flexDirection="column">
        <Text dimColor>{divider}</Text>
        <Text color="red" bold>
          {line1}
        </Text>
        <Text dimColor>{line2}</Text>
      </Box>
    );
  }

  if (mode.type === "Search") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{divider}</Text>
        <Text color="cyan">/{searchQuery}</Text>
        <Text dimColor>{getHints(mode)[1]}</Text>
      </Box>
    );
  }

  const [line1, line2] = getHints(mode, selectedPaneRow);
  return (
    <Box flexDirection="column">
      <Text dimColor>{divider}</Text>
      <Text dimColor>{line1}</Text>
      <Text dimColor>{line2}</Text>
    </Box>
  );
}
