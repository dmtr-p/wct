// src/tui/components/StatusBar.tsx
import { Box, Text, useWindowSize } from "ink";
import type { ComponentProps } from "react";
import type { Mode } from "../types";
import { toSingleLine } from "../utils/truncate";

interface Props {
  mode: Mode;
  searchQuery?: string;
  selectedPaneRow?: boolean;
  hasClient?: boolean;
  repoError?: string;
  canCollapse?: boolean;
}

function join(...parts: (string | false)[]): string {
  return parts.filter(Boolean).join("  ");
}

function getHints(
  mode: Mode,
  selectedPaneRow?: boolean,
  hasClient = true,
  canCollapse = false,
): [string, string] {
  switch (mode.type) {
    case "Navigate":
      return [
        join(
          "↑↓:navigate",
          "→:details",
          hasClient && "space:switch",
          "o:open",
          "a:add",
        ),
        join("u:up", hasClient && "d:down", "c:close", "/:search", "q:quit"),
      ];
    case "Search":
      return ["type to filter", "esc:cancel  enter:done"];
    case "Shortcuts":
    case "OpenModal":
      return ["", ""];
    case "Expanded":
      if (selectedPaneRow) {
        return [
          join(
            "↑↓:navigate",
            canCollapse && "←:collapse",
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
          canCollapse && "←:collapse",
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
 * Normal navigation has no shortcut footer; it only reserves a row when a
 * repository error is visible. Form modals use that same virtual count, so
 * opening one does not clamp or re-anchor the scroll position. Confirmation
 * modals are part of the tree row model and therefore reserve no footer rows.
 */
export function statusBarRowCount(mode: Mode, hasRepoError: boolean): number {
  switch (mode.type) {
    case "ConfirmKill":
    case "ConfirmDown":
    case "ConfirmClose":
    case "ConfirmCloseForce":
      return 0;
    // divider + query line + hint line
    case "Search":
      return 3;
    // Shortcut and form modals replace the footer. Their virtual count matches
    // the normal tree footer so opening one does not disturb scroll position.
    case "Shortcuts":
    case "OpenModal":
    case "UpModal":
    case "AddProjectModal":
      return hasRepoError ? 1 : 0;
    // The normal tree only reserves room for an error; shortcuts live in the
    // on-demand shortcuts modal.
    default:
      return hasRepoError ? 1 : 0;
  }
}

/**
 * A single bottom-chrome line. App.tsx budgets bottomChromeRows assuming each
 * chrome line occupies EXACTLY one terminal row (see statusBarRowCount), so a
 * line wrapping in a narrow terminal would overflow the viewport and misalign
 * mouse hit-testing. Rendering every line through this wrapper — never a raw
 * <Text> — enforces wrap="truncate" structurally: the prop is applied AFTER
 * the spread, so no call site can override it.
 */
function ChromeLine(props: ComponentProps<typeof Text>) {
  return <Text {...props} wrap="truncate" />;
}

export function StatusBar({
  mode,
  searchQuery,
  selectedPaneRow,
  hasClient,
  repoError,
  canCollapse,
}: Props) {
  const { columns: cols } = useWindowSize();
  const divider = "─".repeat(Math.max(1, cols));

  if (
    mode.type === "ConfirmKill" ||
    mode.type === "ConfirmDown" ||
    mode.type === "ConfirmClose" ||
    mode.type === "ConfirmCloseForce"
  ) {
    return null;
  }

  if (mode.type === "Search") {
    return (
      <Box flexDirection="column">
        <ChromeLine dimColor>{divider}</ChromeLine>
        <ChromeLine color="cyan">/{searchQuery}</ChromeLine>
        <ChromeLine dimColor>
          {getHints(mode, undefined, hasClient)[1]}
        </ChromeLine>
      </Box>
    );
  }

  if (mode.type === "Navigate" || mode.type === "Expanded") {
    return repoError ? (
      <ChromeLine color="yellow">⚠ {toSingleLine(repoError)}</ChromeLine>
    ) : null;
  }

  const [line1, line2] = getHints(
    mode,
    selectedPaneRow,
    hasClient,
    canCollapse,
  );
  return (
    <Box flexDirection="column">
      <ChromeLine dimColor>{divider}</ChromeLine>
      {repoError ? (
        <ChromeLine color="yellow">⚠ {toSingleLine(repoError)}</ChromeLine>
      ) : null}
      <ChromeLine dimColor>{line1}</ChromeLine>
      <ChromeLine dimColor>{line2}</ChromeLine>
    </Box>
  );
}
