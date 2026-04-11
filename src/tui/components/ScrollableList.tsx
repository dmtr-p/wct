import { Box, Text } from "ink";
import { useBlink } from "../hooks/useBlink";

export interface ListItem {
  label: string;
  value: string;
  /** Optional secondary text (e.g., PR title) */
  description?: string;
}

/** Filter items by case-insensitive substring match on label */
export function filterItems(items: ListItem[], query: string): ListItem[] {
  if (!query) return items;
  const lower = query.toLowerCase();
  return items.filter((item) => item.label.toLowerCase().includes(lower));
}

/** Compute visible window for scrolling */
export function getVisibleWindow(
  totalItems: number,
  selectedIndex: number,
  maxVisible: number,
): { start: number; end: number; hasAbove: boolean; hasBelow: boolean } {
  if (totalItems <= maxVisible) {
    return { start: 0, end: totalItems, hasAbove: false, hasBelow: false };
  }

  // Center the window around selectedIndex
  let start = Math.max(0, selectedIndex - Math.floor(maxVisible / 2));
  let end = start + maxVisible;

  if (end > totalItems) {
    end = totalItems;
    start = end - maxVisible;
  }

  return {
    start,
    end,
    hasAbove: start > 0,
    hasBelow: end < totalItems,
  };
}

interface Props {
  items: ListItem[];
  selectedIndex: number;
  filterQuery: string;
  maxVisible?: number;
  isFocused: boolean;
}

export function ScrollableList({
  items,
  selectedIndex,
  filterQuery,
  maxVisible = 10,
  isFocused,
}: Props) {
  const cursorVisible = useBlink();
  const filtered = filterItems(items, filterQuery);
  const { start, end, hasAbove, hasBelow } = getVisibleWindow(
    filtered.length,
    selectedIndex,
    maxVisible,
  );
  const visible = filtered.slice(start, end);

  return (
    <Box flexDirection="column">
      {hasAbove && <Text dimColor> ▲</Text>}
      {visible.map((item, i) => {
        const actualIndex = start + i;
        const isSelected = actualIndex === selectedIndex;
        return (
          <Box key={item.value}>
            <Text color={isSelected && isFocused ? "cyan" : undefined}>
              {isSelected ? "▸ " : "  "}
            </Text>
            <Text bold={isSelected} dimColor={!isSelected} wrap="truncate">
              {item.label}
            </Text>
            {item.description && (
              <Text dimColor wrap="truncate">
                {" "}
                {item.description}
              </Text>
            )}
          </Box>
        );
      })}
      {hasBelow && <Text dimColor> ▼</Text>}
      {filtered.length === 0 && <Text dimColor> No matches</Text>}
      {isFocused && filterQuery && (
        <Text dimColor>
          {" "}
          filter: {filterQuery}
          {cursorVisible ? "▎" : " "}
        </Text>
      )}
    </Box>
  );
}
