import { Box, Text } from "ink";
import type { TreeItem } from "../types";
import { checkColor, checkIcon } from "../types";

interface Props {
  item: Extract<TreeItem, { type: "detail" }>;
  isSelected: boolean;
}

export function DetailRow({ item, isSelected }: Props) {
  const { detailKind, label } = item;
  const prefix = isSelected ? "▸ " : "  ";
  const indent =
    detailKind === "pr" || detailKind === "pane-header"
      ? "      " // section header: 6 spaces
      : "        "; // section item: 8 spaces

  switch (item.detailKind) {
    case "pane-header":
      return (
        <Box>
          <Text>{indent}</Text>
          <Text
            color={isSelected ? "cyan" : undefined}
            bold={isSelected}
            dimColor={!isSelected}
          >
            {prefix}
            {label}
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
      const icon = checkIcon(item.meta?.state ?? "");
      const color = checkColor(item.meta?.state ?? "");
      return (
        <Box>
          <Text>{indent}</Text>
          <Text color={isSelected ? "cyan" : "dim"} bold={isSelected}>
            {prefix}
          </Text>
          <Text color={color}>{icon}</Text>
          <Text color={isSelected ? "cyan" : "dim"} bold={isSelected}>
            {" "}
            {label}
          </Text>
        </Box>
      );
    }

    case "pane":
      return (
        <Box>
          <Text>{indent}</Text>
          <Text color={isSelected ? "cyan" : "dim"} bold={isSelected}>
            {prefix}
            {item.meta?.zoomed && item.meta?.active ? "🔍 " : ""}
            {label}
          </Text>
        </Box>
      );
  }
}
