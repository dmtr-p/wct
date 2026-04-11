import { Box, Text } from "ink";
import { Children, type ReactNode } from "react";

interface Props {
  title: string;
  isFocused: boolean;
  width?: number;
  children: ReactNode;
}

function visibleLength(value: string) {
  return Array.from(value).length;
}

function truncateTitle(title: string, width: number) {
  if (width <= 0) return "";

  const chars = Array.from(title);
  if (chars.length <= width) return title;

  if (width === 1) return "…";

  return `${chars.slice(0, width - 1).join("")}…`;
}

function topBorder(width: number, title: string) {
  if (width <= 0) return "";
  if (width === 1) return "╭";
  if (width === 2) return "╭╮";
  if (width === 3) return "╭─╮";

  const titleWidth = width - 4;
  const visibleTitle = truncateTitle(title, titleWidth);
  const dashCount = Math.max(titleWidth - visibleLength(visibleTitle), 0);

  return `╭ ${visibleTitle} ${"─".repeat(dashCount)}╮`;
}

function bottomBorder(width: number) {
  if (width <= 0) return "";
  if (width === 1) return "╰";
  if (width === 2) return "╰╯";
  if (width === 3) return "╰─╯";

  return `╰${"─".repeat(width - 2)}╯`;
}

export function TitledBox({ title, isFocused, width, children }: Props) {
  const boxWidth = Math.max(width ?? 40, 0);
  const normalizedChildren = Children.map(children, (child) =>
    typeof child === "string" || typeof child === "number" ? (
      <Text dimColor={!isFocused}>{child}</Text>
    ) : (
      child
    ),
  );
  const lineProps = {
    color: isFocused ? "cyan" : undefined,
    bold: isFocused,
    dimColor: !isFocused,
  } as const;

  return (
    <Box flexDirection="column">
      <Text {...lineProps}>{topBorder(boxWidth, title)}</Text>
      <Box
        width={boxWidth}
        flexDirection="column"
        borderStyle="round"
        borderTop={false}
        borderBottom={false}
        borderColor={isFocused ? "cyan" : undefined}
        borderLeftColor={isFocused ? "cyan" : undefined}
        borderRightColor={isFocused ? "cyan" : undefined}
        borderLeftDimColor={!isFocused}
        borderRightDimColor={!isFocused}
      >
        {normalizedChildren}
      </Box>
      <Text {...lineProps}>{bottomBorder(boxWidth)}</Text>
    </Box>
  );
}
