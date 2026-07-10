import { Box, Text } from "ink";
import type { TreeItem } from "../types";
import { truncateBranch, truncateWithPrefix } from "../utils/truncate";
import {
  SELECTED_ROW_BACKGROUND,
  SELECTED_ROW_FOREGROUND,
  selectedRowFill,
} from "./tree-row";

interface Props {
  item: Extract<TreeItem, { type: "detail" }>;
  isSelected: boolean;
  maxWidth: number;
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

export function DetailRow({ item, isSelected, maxWidth }: Props) {
  const { detailKind, label } = item;
  const indent =
    detailKind === "pr" || detailKind === "pane-header"
      ? "     " // 5 spaces
      : "       "; // 7 spaces

  switch (item.detailKind) {
    case "pane-header": {
      // overhead: indent(5)
      const displayLabel = truncateBranch(label, maxWidth - indent.length);
      return (
        <Box>
          <Text
            color={isSelected ? SELECTED_ROW_FOREGROUND : undefined}
            backgroundColor={isSelected ? SELECTED_ROW_BACKGROUND : undefined}
            bold={isSelected}
            dimColor={!isSelected}
            wrap="truncate"
          >
            {indent}
            {displayLabel}
            {selectedRowFill(isSelected, maxWidth, indent + displayLabel)}
          </Text>
        </Box>
      );
    }

    case "pr": {
      const { rollupState } = item.meta;
      const icon = rollupIcon(rollupState);
      const iconColor = rollupColor(rollupState);
      const iconText = icon ? `${icon} ` : "";
      const displayLabel = truncateBranch(
        label,
        maxWidth - indent.length - iconText.length,
      );
      return (
        <Box>
          <Text
            color={isSelected ? SELECTED_ROW_FOREGROUND : undefined}
            backgroundColor={isSelected ? SELECTED_ROW_BACKGROUND : undefined}
            bold={isSelected}
            wrap="truncate"
          >
            {indent}
            {icon ? (
              <Text color={isSelected ? undefined : iconColor}>{iconText}</Text>
            ) : null}
            {displayLabel}
            {selectedRowFill(
              isSelected,
              maxWidth,
              indent + iconText + displayLabel,
            )}
          </Text>
        </Box>
      );
    }

    case "pane": {
      const { window, paneIndex, command, zoomed, active } = item.meta;
      const zoomedEmoji = zoomed && active ? "🔍 " : "";
      // overhead: indent(7) + zoomedEmoji(3 if shown, else 0)
      const overhead = indent.length + (zoomedEmoji ? 3 : 0);
      const panePrefix = `${window}:${paneIndex} `;
      const displayLabel = truncateWithPrefix(
        panePrefix,
        command,
        maxWidth - overhead,
      );
      return (
        <Box>
          <Text
            color={isSelected ? SELECTED_ROW_FOREGROUND : undefined}
            backgroundColor={isSelected ? SELECTED_ROW_BACKGROUND : undefined}
            dimColor={!isSelected}
            bold={isSelected}
            wrap="truncate"
          >
            {indent}
            {zoomedEmoji}
            {displayLabel}
            {selectedRowFill(
              isSelected,
              maxWidth,
              indent + zoomedEmoji + displayLabel,
            )}
          </Text>
        </Box>
      );
    }
  }
}
