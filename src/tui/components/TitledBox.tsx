import { Box, Text, type TextProps } from "ink";
import { Children, type ReactNode } from "react";
import { graphemeWidths } from "../utils/display-width";
import { EditableText } from "./EditableText";

interface TitleInput {
  value: string;
  cursor: number;
  cursorVisible: boolean;
}

interface Props {
  title: string;
  titleInput?: TitleInput;
  footer?: string;
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

function truncateText(value: string, width: number) {
  if (width <= 0) return "";

  const graphemes = getGraphemes(value);
  if (graphemes.length <= width) return value;

  if (width === 1) return "…";

  return `${graphemes.slice(0, width - 1).join("")}…`;
}

function topBorder(width: number, title: string) {
  if (width <= 0) return "";
  if (width === 1) return "╭";
  if (width === 2) return "╭╮";
  if (width === 3) return "╭─╮";

  const titleWidth = width - 4;
  const visibleTitle = truncateText(title, titleWidth);
  const dashCount = Math.max(titleWidth - visibleLength(visibleTitle), 0);

  return `╭ ${visibleTitle} ${"─".repeat(dashCount)}╮`;
}

function editableTopBorder(
  width: number,
  input: TitleInput,
  isFocused: boolean,
  lineProps: Pick<TextProps, "color" | "bold" | "dimColor">,
) {
  const border = <Text {...lineProps}>{topBorder(width, "")}</Text>;
  if (width <= 4) return border;

  const available = width - 4;
  const characters = graphemeWidths(input.value);
  const cursor = Math.max(0, Math.min(input.cursor, characters.length));
  let start = cursor;
  let used = characters[cursor]?.[1] ?? (isFocused || !input.value ? 1 : 0);
  if (used > available) return border;

  // Keep the cursor in view without letting a long query wrap the border.
  while (start > 0 && used + (characters[start - 1]?.[1] ?? 0) <= available) {
    start -= 1;
    used += characters[start]?.[1] ?? 0;
  }
  let end = Math.min(cursor + 1, characters.length);
  while (
    end < characters.length &&
    used + (characters[end]?.[1] ?? 0) <= available
  ) {
    used += characters[end]?.[1] ?? 0;
    end += 1;
  }

  return (
    <Box width={width} height={1} position="relative">
      {border}
      {/* Overlay the input so width estimates cannot move the border corner. */}
      <Box
        position="absolute"
        left={2}
        top={0}
        width={available + 1}
        height={1}
        overflow="hidden"
      >
        <Text {...lineProps} wrap="truncate">
          <EditableText
            value={characters
              .slice(start, end)
              .map(([char]) => char)
              .join("")}
            cursor={cursor - start}
            isFocused={isFocused}
            cursorVisible={input.cursorVisible}
          />{" "}
        </Text>
      </Box>
    </Box>
  );
}

function bottomBorder(width: number, footer?: string) {
  if (width <= 0) return "";
  if (width === 1) return "╰";
  if (width === 2) return "╰╯";
  if (width === 3) return "╰─╯";

  if (!footer) return `╰${"─".repeat(width - 2)}╯`;

  const footerWidth = width - 4;
  const visibleFooter = truncateText(footer, footerWidth);
  const dashCount = Math.max(footerWidth - visibleLength(visibleFooter), 0);

  return `╰${"─".repeat(dashCount)} ${visibleFooter} ╯`;
}

export function TitledBox({
  title,
  titleInput,
  footer,
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
      <Box width={boxWidth}>
        {titleInput ? (
          editableTopBorder(boxWidth, titleInput, isFocused, lineProps)
        ) : (
          <Text {...lineProps} wrap="truncate">
            {topBorder(boxWidth, title)}
          </Text>
        )}
      </Box>
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
      <Text {...lineProps}>{bottomBorder(boxWidth, footer)}</Text>
    </Box>
  );
}
