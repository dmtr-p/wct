import { Box, Text } from "ink";
import type { TreeItem } from "../types";
import { checkColor, checkIcon } from "../types";
import { truncateBranch, truncateWithPrefix } from "../utils/truncate";

interface Props {
  item: Extract<TreeItem, { type: "detail" }>;
  isSelected: boolean;
  maxWidth: number;
}

export function DetailRow({ item, isSelected, maxWidth }: Props) {
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

    case "pr":
      return (
        <Box>
          <Text>{indent}</Text>
          <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
            {prefix}
            {label}
          </Text>
        </Box>
      );

    case "check": {
      const icon = checkIcon(item.meta.state ?? "");
      const color = checkColor(item.meta.state ?? "");
      // overhead: indent(8) + selectorPrefix(2) + icon(1) + space(1) = 12
      return (
        <Box>
          <Text>{indent}</Text>
          <Text color={isSelected ? "cyan" : "dim"} bold={isSelected}>
            {prefix}
          </Text>
          <Text color={color}>{icon}</Text>
          <Text color={isSelected ? "cyan" : "dim"} bold={isSelected}>
            {" "}
            {truncateBranch(label, maxWidth - 12)}
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
          <Text color={isSelected ? "cyan" : "dim"} bold={isSelected}>
            {prefix}
            {zoomedEmoji}
            {displayLabel}
          </Text>
        </Box>
      );
    }
  }
}
