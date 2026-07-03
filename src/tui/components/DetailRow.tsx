import { Box, Text } from "ink";
import { PR_INDENT, prLabelStart, wrapPrLabel } from "../pr-layout";
import type { TreeItem } from "../types";
import { truncateBranch, truncateWithPrefix } from "../utils/truncate";

interface Props {
  item: Extract<TreeItem, { type: "detail" }>;
  isSelected: boolean;
  maxWidth: number;
  /**
   * Which wrapped terminal line of the label to render. 0 is the primary line
   * (indent + selector + icon + first label piece); values > 0 render a PR
   * continuation line — the label piece indented to align under the first.
   */
  pieceIndex?: number;
}

function rollupIcon(
  rollupState: "success" | "failure" | "pending" | null,
): string {
  switch (rollupState) {
    case "success":
      return "✓";
    case "failure":
      return "✗";
    case "pending":
      return "◌";
    default:
      return "";
  }
}

function rollupColor(
  rollupState: "success" | "failure" | "pending" | null,
): "green" | "red" | "yellow" | undefined {
  switch (rollupState) {
    case "success":
      return "green";
    case "failure":
      return "red";
    case "pending":
      return "yellow";
    default:
      return undefined;
  }
}

export function DetailRow({
  item,
  isSelected,
  maxWidth,
  pieceIndex = 0,
}: Props) {
  const { detailKind, label } = item;
  const prefix = isSelected ? "▸ " : "  ";
  const indent =
    detailKind === "pr" || detailKind === "pane-header"
      ? "      " // 6 spaces
      : "        "; // 8 spaces

  switch (item.detailKind) {
    case "pane-header":
      // overhead: indent(6) + selectorPrefix(2) = 8
      return (
        <Box>
          <Text>{indent}</Text>
          <Text
            color={isSelected ? "cyan" : undefined}
            bold={isSelected}
            dimColor={!isSelected}
          >
            {prefix}
            {truncateBranch(label, maxWidth - 8)}
          </Text>
        </Box>
      );

    case "pr": {
      const { rollupState } = item.meta;
      const icon = rollupIcon(rollupState);
      const iconColor = rollupColor(rollupState);
      const hasIcon = rollupState !== null;
      // The full title is shown, wrapping onto extra lines rather than being
      // truncated. `buildTreeRows` emits one continuation row per wrapped line
      // via this same helper, so counted rows == rendered lines and mouse
      // hit-testing stays aligned.
      const lines = wrapPrLabel(label, maxWidth, hasIcon);

      if (pieceIndex > 0) {
        return (
          <Box>
            <Text>{" ".repeat(prLabelStart(hasIcon))}</Text>
            <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
              {lines[pieceIndex] ?? ""}
            </Text>
          </Box>
        );
      }

      // The rendered leading chrome MUST equal prLabelStart(hasIcon): the
      // indent is PR_INDENT columns, `prefix` is PR_SELECTOR (2) wide, and the
      // icon element `{icon} ` is PR_ICON (2) wide when shown. If these drift,
      // the label budget stops matching the render and the terminal soft-wraps,
      // desyncing the row count — hence the indent derives from the constant.
      return (
        <Box>
          <Text>{" ".repeat(PR_INDENT)}</Text>
          <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
            {prefix}
          </Text>
          {icon ? <Text color={iconColor}>{icon} </Text> : null}
          <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
            {lines[0] ?? ""}
          </Text>
        </Box>
      );
    }

    case "pane": {
      const { window, paneIndex, command, zoomed, active } = item.meta;
      const zoomedEmoji = zoomed && active ? "🔍 " : "";
      // overhead: indent(8) + selectorPrefix(2) + zoomedEmoji(3 if shown, else 0)
      const overhead = 8 + 2 + (zoomedEmoji ? 3 : 0);
      const panePrefix = `${window}:${paneIndex} `;
      const displayLabel = truncateWithPrefix(
        panePrefix,
        command,
        maxWidth - overhead,
      );
      return (
        <Box>
          <Text>{indent}</Text>
          <Text
            color={isSelected ? "cyan" : undefined}
            dimColor={!isSelected}
            bold={isSelected}
          >
            {prefix}
            {zoomedEmoji}
            {displayLabel}
          </Text>
        </Box>
      );
    }
  }
}
