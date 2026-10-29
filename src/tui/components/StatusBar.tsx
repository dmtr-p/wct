import { Box, Text, useWindowSize } from "ink";
import type { ComponentProps } from "react";
import { useCursorBlink } from "../hooks/useCursorBlink";
import type { Mode } from "../types";
import { graphemeWidths } from "../utils/display-width";
import { toSingleLine } from "../utils/truncate";
import { EditableText } from "./EditableText";

interface Props {
  mode: Mode;
  searchQuery?: string;
  searchCursor?: number;
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
          "p:PR actions",
          "enter:open PR",
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
    case "PrMenu":
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
          "p:PR actions",
          "enter:open PR",
          hasClient && "space:action",
          "o:open",
          "a:add",
        ),
        join("u:up", hasClient && "d:down", "c:close", "/:search", "q:quit"),
      ];
    case "ConfirmKill":
      return [`Kill pane ${mode.label}?`, "enter:confirm  esc:cancel"];
    case "ConfirmDown":
      return [`Stop session for ${mode.branch}?`, "enter:confirm  esc:cancel"];
    case "ConfirmClose":
      return [`Close worktree ${mode.branch}?`, "enter:confirm  esc:cancel"];
    case "ConfirmCloseForce":
      return [
        `${mode.branch} has uncommitted changes`,
        "enter:force close  esc:cancel",
      ];
    case "ConfirmRemoveProject":
      return [`Remove project ${mode.project}?`, "enter:remove  esc:cancel"];
    case "UpModal":
    case "AddProjectModal":
      return ["", ""];
  }
}

/**
 * App uses this count to budget the tree viewport. Truncated lines make it
 * independent of terminal width. Form modals retain navigation's virtual count
 * to preserve scroll position; confirmations are counted in the tree model.
 */
export function statusBarRowCount(mode: Mode, hasRepoError: boolean): number {
  switch (mode.type) {
    case "ConfirmKill":
    case "ConfirmDown":
    case "ConfirmClose":
    case "ConfirmCloseForce":
    case "ConfirmRemoveProject":
      return 0;
    // divider + query line + hint line
    case "Search":
      return 3;
    // Shortcut and form modals replace the footer. Their virtual count matches
    // the normal tree footer so opening one does not disturb scroll position.
    case "Shortcuts":
    case "OpenModal":
    case "PrMenu":
    case "UpModal":
    case "AddProjectModal":
    case "Navigate":
    case "Expanded":
      return hasRepoError ? 1 : 0;
  }
}

/**
 * Force truncation after spreading props: wrapping would invalidate the
 * viewport row count and misalign mouse hit-testing.
 */
function ChromeLine(props: ComponentProps<typeof Text>) {
  return <Text {...props} wrap="truncate" />;
}

export function StatusBar({
  mode,
  searchQuery,
  searchCursor = 0,
  selectedPaneRow,
  hasClient,
  repoError,
  canCollapse,
}: Props) {
  const { columns: cols } = useWindowSize();
  const cursorVisible = useCursorBlink(
    searchQuery ?? "",
    searchCursor,
    mode.type === "Search",
  );
  const divider = "─".repeat(Math.max(1, cols));

  if (
    mode.type === "ConfirmKill" ||
    mode.type === "ConfirmDown" ||
    mode.type === "ConfirmClose" ||
    mode.type === "ConfirmCloseForce" ||
    mode.type === "ConfirmRemoveProject"
  ) {
    return null;
  }

  if (mode.type === "Search") {
    const parts = graphemeWidths(searchQuery ?? "");
    const cursor = Math.min(searchCursor, parts.length);
    const available = Math.max(0, cols - 2); // slash and insertion marker
    let start = cursor;
    let used = 0;
    while (
      start > 0 &&
      used + (parts[start - 1]?.[1] ?? 0) <= Math.floor(available / 2)
    ) {
      used += parts[--start]?.[1] ?? 0;
    }
    let end = cursor;
    while (end < parts.length && used + (parts[end]?.[1] ?? 0) <= available) {
      used += parts[end++]?.[1] ?? 0;
    }
    while (start > 0 && used + (parts[start - 1]?.[1] ?? 0) <= available) {
      used += parts[--start]?.[1] ?? 0;
    }
    const visibleQuery = parts
      .slice(start, end)
      .map(([part]) => part)
      .join("");
    return (
      <Box flexDirection="column">
        <ChromeLine dimColor>{divider}</ChromeLine>
        <ChromeLine color="cyan">
          {"/"}
          <EditableText
            value={visibleQuery}
            cursor={cursor - start}
            isFocused
            cursorVisible={cursorVisible}
          />
        </ChromeLine>
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
