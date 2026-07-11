import { Box, Text, type TextProps } from "ink";
import { Children, type ReactNode } from "react";

interface Props {
  title: string;
  isFocused: boolean;
  width?: number;
  children: ReactNode;
  isHovered?: boolean;
  accentColor?: TextProps["color"];
  dimAccent?: boolean;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function getGraphemes(value: string) {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

function visibleLength(value: string) {
  return getGraphemes(value).length;
}

function truncateTitle(title: string, width: number) {
  if (width <= 0) return "";

  const graphemes = getGraphemes(title);
  if (graphemes.length <= width) return title;

  if (width === 1) return "…";

  return `${graphemes.slice(0, width - 1).join("")}…`;
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

export function TitledBox({
  title,
  isFocused,
  width,
  children,
  isHovered = false,
  accentColor = "cyan",
  dimAccent = false,
}: Props) {
  const boxWidth = Math.max(width ?? 40, 0);
  const isHighlighted = isFocused || isHovered;
  const normalizedChildren = Children.map(children, (child) =>
    typeof child === "string" || typeof child === "number" ? (
      <Text dimColor={!isHighlighted}>{child}</Text>
    ) : (
      child
    ),
  );
  const lineProps = {
    color: isHighlighted ? accentColor : undefined,
    bold: isHighlighted && !dimAccent,
    dimColor: !isHighlighted || dimAccent,
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
        borderColor={isHighlighted ? accentColor : undefined}
        borderLeftColor={isHighlighted ? accentColor : undefined}
        borderRightColor={isHighlighted ? accentColor : undefined}
        borderLeftDimColor={!isHighlighted || dimAccent}
        borderRightDimColor={!isHighlighted || dimAccent}
      >
        {normalizedChildren}
      </Box>
      <Text {...lineProps}>{bottomBorder(boxWidth)}</Text>
    </Box>
  );
}
