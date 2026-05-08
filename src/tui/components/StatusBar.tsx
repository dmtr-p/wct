// src/tui/components/StatusBar.tsx
import { Box, Text, useStdout } from "ink";
import type { Mode } from "../types";

interface Props {
  mode: Mode;
  searchQuery?: string;
  selectedPaneRow?: boolean;
  hasClient?: boolean;
  repoError?: string;
}

function join(...parts: (string | false)[]): string {
  return parts.filter(Boolean).join("  ");
}

function getHints(
  mode: Mode,
  selectedPaneRow?: boolean,
  hasClient = true,
): [string, string] {
  switch (mode.type) {
    case "Navigate":
      return [
        join(
          "↑↓:navigate",
          "←→:expand/collapse",
          hasClient && "space:switch",
          "o:open",
          "a:add",
        ),
        join("u:up", hasClient && "d:down", "c:close", "/:search", "q:quit"),
      ];
    case "Search":
      return ["type to filter", "esc:cancel  enter:done"];
    case "OpenModal":
      return ["", ""];
    case "Expanded":
      if (selectedPaneRow) {
        return [
          join(
            "↑↓:navigate",
            "←:collapse",
            hasClient && "space:jump",
            hasClient && "z:zoom",
            hasClient && "x:kill",
          ),
          join("/:search", "q:quit"),
        ];
      }
      return [
        join(
          "↑↓:navigate",
          "←:collapse",
          hasClient && "space:action",
          "o:open",
          "a:add",
        ),
        join("u:up", hasClient && "d:down", "c:close", "/:search", "q:quit"),
      ];
    case "ConfirmKill":
      return [`Kill pane ${mode.label}?`, "enter:confirm  esc:cancel"];
    case "ConfirmDown":
      return [`Kill session for ${mode.branch}?`, "enter:confirm  esc:cancel"];
    case "ConfirmClose":
      return [`Close worktree ${mode.branch}?`, "enter:confirm  esc:cancel"];
    case "ConfirmCloseForce":
      return [
        `${mode.branch} has uncommitted changes`,
        "enter:force close  esc:cancel",
      ];
    case "UpModal":
    case "AddProjectModal":
      return ["", ""];
  }
}

export function StatusBar({
  mode,
  searchQuery,
  selectedPaneRow,
  hasClient,
  repoError,
}: Props) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 50;
  const divider = "─".repeat(Math.max(1, cols));

  if (
    mode.type === "ConfirmKill" ||
    mode.type === "ConfirmDown" ||
    mode.type === "ConfirmClose" ||
    mode.type === "ConfirmCloseForce"
  ) {
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
      {repoError ? <Text color="yellow">⚠ {repoError}</Text> : null}
      <Text dimColor>{line1}</Text>
      <Text dimColor>{line2}</Text>
    </Box>
  );
}
