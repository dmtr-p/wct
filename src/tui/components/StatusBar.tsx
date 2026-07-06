// src/tui/components/StatusBar.tsx
import { Box, Text, useWindowSize } from "ink";
import type { Mode } from "../types";
import { toSingleLine } from "../utils/truncate";

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

/**
 * The number of terminal rows StatusBar renders for a mode — the single
 * source App.tsx's viewport budget consumes, co-located with the render
 * branches below so the two cannot drift. The count is a pure function of the
 * mode branch and repoError presence: every line renders with wrap="truncate"
 * (and the divider is width-repeated), so width never changes the row count,
 * and searchQuery/selectedPaneRow/hasClient only change text, never lines.
 *
 * True-modal modes (OpenModal/UpModal/AddProjectModal) do not render
 * StatusBar at all — the modal replaces the bottom chrome — but they return
 * the default-branch count anyway: App budgets the tree viewport with this
 * VIRTUAL count so opening a modal does not change viewportRows (which would
 * clamp/re-anchor the scroll state); the modal's extra height is absorbed by
 * the tree box's overflow clipping instead.
 */
export function statusBarRowCount(mode: Mode, hasRepoError: boolean): number {
  switch (mode.type) {
    // divider + confirm question + hint line
    case "ConfirmKill":
    case "ConfirmDown":
    case "ConfirmClose":
    case "ConfirmCloseForce":
    // divider + query line + hint line
    case "Search":
      return 3;
    // divider + optional repoError + two hint lines
    default:
      return 3 + (hasRepoError ? 1 : 0);
  }
}

export function StatusBar({
  mode,
  searchQuery,
  selectedPaneRow,
  hasClient,
  repoError,
}: Props) {
  const { columns: cols } = useWindowSize();
  const divider = "─".repeat(Math.max(1, cols));

  // Every line below renders with wrap="truncate": App.tsx budgets
  // bottomChromeRows assuming each chrome line occupies exactly one terminal
  // row, so a hint/error line wrapping in a narrow terminal would overflow
  // the viewport and misalign mouse hit-testing.

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
        <Text color="red" bold wrap="truncate">
          {line1}
        </Text>
        <Text dimColor wrap="truncate">
          {line2}
        </Text>
      </Box>
    );
  }

  if (mode.type === "Search") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{divider}</Text>
        <Text color="cyan" wrap="truncate">
          /{searchQuery}
        </Text>
        <Text dimColor wrap="truncate">
          {getHints(mode, undefined, hasClient)[1]}
        </Text>
      </Box>
    );
  }

  const [line1, line2] = getHints(mode, selectedPaneRow, hasClient);
  return (
    <Box flexDirection="column">
      <Text dimColor>{divider}</Text>
      {repoError ? (
        <Text color="yellow" wrap="truncate">
          ⚠ {toSingleLine(repoError)}
        </Text>
      ) : null}
      <Text dimColor wrap="truncate">
        {line1}
      </Text>
      <Text dimColor wrap="truncate">
        {line2}
      </Text>
    </Box>
  );
}
