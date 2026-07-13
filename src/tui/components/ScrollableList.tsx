import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import { useBlink } from "../hooks/useBlink";
import { useGuardedInput } from "../hooks/useGuardedInput";
import { MouseClickable } from "./MouseClickable";

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

export function clampListScrollOffset(
  offset: number,
  totalItems: number,
  maxVisible: number,
): number {
  return Math.max(0, Math.min(offset, Math.max(0, totalItems - maxVisible)));
}

export function getListPaddingCount(
  renderedRows: number,
  maxVisible: number,
): number {
  return Math.max(0, maxVisible - renderedRows);
}

export function ListPadding({ count }: { count: number }) {
  if (count <= 0) return null;
  return <Box height={count} />;
}

/** Move a viewport only as far as needed to reveal the selected item. */
export function scrollToRevealListItem(
  offset: number,
  selectedIndex: number,
  totalItems: number,
  maxVisible: number,
): number {
  const clamped = clampListScrollOffset(offset, totalItems, maxVisible);
  if (selectedIndex < clamped) return Math.max(0, selectedIndex);
  if (selectedIndex >= clamped + maxVisible) {
    return clampListScrollOffset(
      selectedIndex - maxVisible + 1,
      totalItems,
      maxVisible,
    );
  }
  return clamped;
}

/** Compute the start-inclusive/end-exclusive rows of a proportional thumb. */
export function getScrollbarThumb(
  totalItems: number,
  visibleItems: number,
  windowStart: number,
): { start: number; end: number } | null {
  if (totalItems <= visibleItems || visibleItems <= 0) return null;

  const size = Math.max(
    1,
    Math.round((visibleItems / totalItems) * visibleItems),
  );
  const maxThumbStart = visibleItems - size;
  const maxWindowStart = totalItems - visibleItems;
  const start = Math.round((windowStart / maxWindowStart) * maxThumbStart);
  return { start, end: start + size };
}

export function Scrollbar({
  row,
  totalItems,
  visibleItems,
  windowStart,
}: {
  row: number;
  totalItems: number;
  visibleItems: number;
  windowStart: number;
}) {
  const thumb = getScrollbarThumb(totalItems, visibleItems, windowStart);
  if (!thumb) return null;
  const isThumb = row >= thumb.start && row < thumb.end;
  if (!isThumb) return null;
  return (
    <Box position="absolute" right={-1}>
      <Text color="cyan">█</Text>
    </Box>
  );
}

interface Props {
  items: ListItem[];
  selectedIndex: number;
  filterQuery: string;
  maxVisible?: number;
  isFocused: boolean;
  onSelect?: (index: number) => void;
  onDoubleSelect?: (index: number) => void;
}

export function ScrollableList({
  items,
  selectedIndex,
  filterQuery,
  maxVisible = 5,
  isFocused,
  onSelect,
  onDoubleSelect,
}: Props) {
  const cursorVisible = useBlink();
  const filtered = filterItems(items, filterQuery);
  const filterStateKey = JSON.stringify([
    filterQuery,
    filtered.map((item) => item.value),
  ]);
  const previousFilterStateKeyRef = useRef(filterStateKey);
  const showFilter = isFocused && filterQuery.length > 0;
  const visibleCapacity = Math.max(0, maxVisible - (showFilter ? 1 : 0));
  const [scrollOffset, setScrollOffset] = useState(
    () =>
      getVisibleWindow(filtered.length, selectedIndex, visibleCapacity).start,
  );
  const effectiveScrollOffset = clampListScrollOffset(
    scrollOffset,
    filtered.length,
    visibleCapacity,
  );
  const visible = filtered.slice(
    effectiveScrollOffset,
    effectiveScrollOffset + visibleCapacity,
  );

  useEffect(() => {
    const filterContentsChanged =
      previousFilterStateKeyRef.current !== filterStateKey;
    previousFilterStateKeyRef.current = filterStateKey;
    setScrollOffset((offset) =>
      scrollToRevealListItem(
        filterContentsChanged ? 0 : offset,
        selectedIndex,
        filtered.length,
        visibleCapacity,
      ),
    );
  }, [filtered.length, filterStateKey, selectedIndex, visibleCapacity]);

  useGuardedInput(() => {}, {
    isActive: isFocused && Boolean(onSelect || onDoubleSelect),
    onMouseEvent: (event) => {
      if (event.kind !== "wheel") return;
      setScrollOffset((offset) =>
        clampListScrollOffset(
          offset + event.dir,
          filtered.length,
          visibleCapacity,
        ),
      );
    },
  });

  return (
    <Box flexDirection="column">
      {showFilter && (
        <Text dimColor>
          {" "}
          filter: {filterQuery}
          {cursorVisible ? "▎" : " "}
        </Text>
      )}
      {visible.map((item, i) => {
        const actualIndex = effectiveScrollOffset + i;
        const isSelected = actualIndex === selectedIndex;
        return (
          <MouseClickable
            key={item.value}
            onClick={() => onSelect?.(actualIndex)}
            onDoubleClick={() => onDoubleSelect?.(actualIndex)}
            isActive={Boolean(onSelect || onDoubleSelect)}
          >
            {(isHovered) => (
              <Box position="relative" width="100%">
                <Box flexGrow={1}>
                  <Text
                    color={
                      (isSelected && isFocused) || isHovered
                        ? "cyan"
                        : undefined
                    }
                  >
                    {isSelected ? "▸ " : "  "}
                  </Text>
                  <Text
                    bold={isSelected || isHovered}
                    dimColor={!isSelected && !isHovered}
                    wrap="truncate"
                  >
                    {item.label}
                  </Text>
                  {item.description && (
                    <Text dimColor wrap="truncate">
                      {" "}
                      {item.description}
                    </Text>
                  )}
                </Box>
                <Scrollbar
                  row={i}
                  totalItems={filtered.length}
                  visibleItems={visible.length}
                  windowStart={effectiveScrollOffset}
                />
              </Box>
            )}
          </MouseClickable>
        );
      })}
      {filtered.length === 0 && <Text dimColor> No matches</Text>}
      <ListPadding
        count={getListPaddingCount(
          (showFilter ? 1 : 0) + (filtered.length === 0 ? 1 : visible.length),
          maxVisible,
        )}
      />
    </Box>
  );
}
