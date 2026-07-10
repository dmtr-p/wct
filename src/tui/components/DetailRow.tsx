import { Box, Text } from "ink";
import { PR_INDENT, prLabelStart, wrapPrLabel } from "../pr-layout";
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
  pieceIndex?: number;
  prLine?: string;
}

function rollupIcon(
  rollupState: "success" | "failure" | "pending" | null,
): string {
  switch (rollupState) {
    case "success": return "✓";
    case "failure": return "✗";
    case "pending": return "◌";
    default: return "";
  }
}

function rollupColor(
  rollupState: "success" | "failure" | "pending" | null,
): "green" | "red" | "yellow" | undefined {
  switch (rollupState) {
    case "success": return "green";
    case "failure": return "red";
    case "pending": return "yellow";
    default: return undefined;
  }
}

export function DetailRow({
  item,
  isSelected,
  maxWidth,
  pieceIndex = 0,
  prLine,
}: Props) {
  const selectedProps = {
    color: isSelected ? SELECTED_ROW_FOREGROUND : undefined,
    backgroundColor: isSelected ? SELECTED_ROW_BACKGROUND : undefined,
  };

  switch (item.detailKind) {
    case "pane-header": {
      const indent = "     ";
      const displayLabel = truncateBranch(item.label, maxWidth - indent.length);
      const content = indent + displayLabel;
      return (
        <Box>
          <Text {...selectedProps} bold={isSelected} dimColor={!isSelected} wrap="truncate">
            {content}{selectedRowFill(isSelected, maxWidth, content)}
          </Text>
        </Box>
      );
    }

    case "pr": {
      const { rollupState } = item.meta;
      const icon = rollupIcon(rollupState);
      const iconText = icon ? `${icon} ` : "";
      const line =
        prLine ?? wrapPrLabel(item.label, maxWidth, icon !== "")[pieceIndex] ?? "";
      const indent = " ".repeat(prLabelStart(icon !== ""));

      if (pieceIndex > 0) {
        const content = indent + line;
        return (
          <Box>
            <Text {...selectedProps} bold={isSelected} wrap="truncate-end">
              {content}{selectedRowFill(isSelected, maxWidth, content)}
            </Text>
          </Box>
        );
      }

      const leading = " ".repeat(PR_INDENT);
      const content = leading + iconText + line;
      return (
        <Box>
          <Text {...selectedProps} bold={isSelected} wrap="truncate-end">
            {leading}
            {icon ? (
              <Text color={isSelected ? undefined : rollupColor(rollupState)}>
                {iconText}
              </Text>
            ) : null}
            {line}{selectedRowFill(isSelected, maxWidth, content)}
          </Text>
        </Box>
      );
    }

    case "pane": {
      const indent = "       ";
      const { window, paneIndex, command, zoomed, active } = item.meta;
      const zoomedEmoji = zoomed && active ? "🔍 " : "";
      const panePrefix = `${window}:${paneIndex} `;
      const displayLabel = truncateWithPrefix(
        panePrefix,
        command,
        maxWidth - indent.length - (zoomedEmoji ? 3 : 0),
      );
      const content = indent + zoomedEmoji + displayLabel;
      return (
        <Box>
          <Text {...selectedProps} dimColor={!isSelected} bold={isSelected} wrap="truncate">
            {content}{selectedRowFill(isSelected, maxWidth, content)}
          </Text>
        </Box>
      );
    }
  }
}
