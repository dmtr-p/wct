// src/tui/components/StatusBar.tsx
import { Box, Text, useStdout } from "ink";
import type { Mode } from "../types";

interface Props {
  mode: Mode;
  searchQuery?: string;
  selectedPaneRow?: boolean;
  hasClient?: boolean;
}

function getHints(
  mode: Mode,
  selectedPaneRow?: boolean,
  hasClient = true,
): [string, string] {
  switch (mode.type) {
    case "Navigate":
      return hasClient
        ? [
            "↑↓:navigate  ←→:expand/collapse  space:switch  o:open",
            "u:up  d:down  c:close  /:search  q:quit",
          ]
        : ["↑↓:navigate  ←→:expand/collapse  o:open", "/:search  q:quit"];
    case "Search":
      return ["type to filter", "esc:cancel  enter:done"];
    case "OpenModal":
      return ["", ""];
    case "Expanded":
      if (selectedPaneRow) {
        return hasClient
          ? [
              "↑↓:navigate  ←:collapse  space:jump  z:zoom  x:kill",
              "/:search  q:quit",
            ]
          : ["↑↓:navigate  ←:collapse", "/:search  q:quit"];
      }
      return hasClient
        ? [
            "↑↓:navigate  ←:collapse  space:action  o:open",
            "u:up  d:down  c:close  /:search  q:quit",
          ]
        : ["↑↓:navigate  ←:collapse  o:open", "/:search  q:quit"];
    case "ConfirmKill":
      return [`Kill pane ${mode.label}?`, "enter:confirm  esc:cancel"];
    case "ConfirmDown":
      return [`Kill session for ${mode.branch}?`, "enter:confirm  esc:cancel"];
    case "UpModal":
      return ["", ""];
  }
}

export function StatusBar({
  mode,
  searchQuery,
  selectedPaneRow,
  hasClient,
}: Props) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 50;
  const divider = "─".repeat(Math.max(1, cols));

  if (mode.type === "ConfirmKill" || mode.type === "ConfirmDown") {
    const [line1, line2] = getHints(mode, selectedPaneRow, hasClient);
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
        <Text dimColor>{getHints(mode, undefined, hasClient)[1]}</Text>
      </Box>
    );
  }

  const [line1, line2] = getHints(mode, selectedPaneRow, hasClient);
  return (
    <Box flexDirection="column">
      <Text dimColor>{divider}</Text>
      <Text dimColor>{line1}</Text>
      <Text dimColor>{line2}</Text>
    </Box>
  );
}
