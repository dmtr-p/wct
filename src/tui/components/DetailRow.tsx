import { Box, Text } from "ink";
import type { DetailKind, DetailMeta } from "../types";
import { checkColor, checkIcon } from "../types";

interface Props {
  kind: DetailKind;
  label: string;
  isSelected: boolean;
  /** Extra data for rendering (e.g., check state) */
  meta?: DetailMeta;
}

export function DetailRow({ kind, label, isSelected, meta }: Props) {
  const prefix = isSelected ? "▸ " : "  ";
  const indent =
    kind === "pr" || kind === "pane-header"
      ? "      " // section header: 6 spaces
      : "        "; // section item: 8 spaces

  switch (kind) {
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
      const icon = checkIcon(meta?.state ?? "");
      const color = checkColor(meta?.state ?? "");
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
            {meta?.zoomed && meta?.active ? "🔍 " : ""}
            {label}
          </Text>
        </Box>
      );
  }
}
