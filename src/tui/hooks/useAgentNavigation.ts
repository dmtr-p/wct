import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentListItem, AgentListRow } from "../agent-view";
import {
  clampListScrollOffset,
  scrollToRevealListItem,
} from "../components/ScrollableList";
import {
  detectDoubleClick,
  HEADER_OFFSET,
  type MouseClickHistory,
} from "../input/mouse";
import { scrollRangeToKeepVisible } from "../tree-helpers";
import { useGuardedInput } from "./useGuardedInput";

export function useAgentNavigation(
  items: readonly AgentListItem[],
  rows: readonly AgentListRow[],
  viewportRows: number,
  isActive: boolean,
  onJump: (paneId: string) => void,
  onKill: (item: AgentListItem) => void,
  onClose: (item: AgentListItem) => void,
  onCancelWait?: (item: AgentListItem | undefined) => void,
) {
  // Undefined allows initial selection once agents arrive; null keeps a lost
  // foreground generation deselected until the user explicitly selects a row.
  const [selection, setSelection] = useState<string | null | undefined>(
    undefined,
  );
  const selectedIndex =
    selection === undefined
      ? items.length
        ? 0
        : -1
      : items.findIndex((item) => item.id === selection);
  const selectedItem = items[selectedIndex];
  const selectedId = selectedItem?.id;
  const selectedRow = rows.findIndex(
    (row) => row.kind === "agent" && row.itemIndex === selectedIndex,
  );
  const [scrollOffset, setScrollOffset] = useState(0);
  const currentScrollOffset = useRef(scrollOffset);
  const confirmationReturnOffset = useRef<number | null>(null);
  const confirmationStart = rows.findIndex(
    (row) => row.kind === "confirmation",
  );
  const confirmationEnd = rows.findLastIndex(
    (row) => row.kind === "confirmation",
  );
  const offset = clampListScrollOffset(scrollOffset, rows.length, viewportRows);
  const [hoverRow, setHoverRow] = useState<number | null>(null);
  const lastClick = useRef<MouseClickHistory | null>(null);

  useEffect(() => {
    if (selectedId !== undefined) setSelection(selectedId);
    else
      setSelection((previous) => (previous === undefined ? undefined : null));
  }, [selectedId]);

  useLayoutEffect(() => {
    currentScrollOffset.current = scrollOffset;
  }, [scrollOffset]);

  useLayoutEffect(() => {
    let restoreOffset: number | undefined;
    if (confirmationStart >= 0) {
      confirmationReturnOffset.current ??= currentScrollOffset.current;
    } else {
      restoreOffset = confirmationReturnOffset.current ?? undefined;
      confirmationReturnOffset.current = null;
    }
    setScrollOffset((previous) => {
      const offset =
        restoreOffset === undefined
          ? selectedRow < 0
            ? clampListScrollOffset(previous, rows.length, viewportRows)
            : scrollToRevealListItem(
                previous,
                selectedRow,
                rows.length,
                viewportRows,
              )
          : clampListScrollOffset(restoreOffset, rows.length, viewportRows);
      return confirmationStart < 0
        ? offset
        : clampListScrollOffset(
            scrollRangeToKeepVisible(
              { start: confirmationStart, end: confirmationEnd },
              offset,
              viewportRows,
            ),
            rows.length,
            viewportRows,
          );
    });
  }, [
    selectedItem?.id,
    selectedRow,
    rows.length,
    viewportRows,
    confirmationStart,
    confirmationEnd,
  ]);

  function select(index: number) {
    const item = items[index];
    if (!item) return;
    setSelection(item.id);
    const start = rows.findIndex(
      (row) => row.kind === "agent" && row.itemIndex === index,
    );
    setScrollOffset((previous) => {
      // Reveal both lines when possible, including a preceding project heading.
      const end = Math.min(rows.length - 1, start + 1);
      const top = rows[start - 1]?.kind === "project" ? start - 1 : start;
      const next = scrollToRevealListItem(
        previous,
        end,
        rows.length,
        viewportRows,
      );
      return scrollToRevealListItem(next, top, rows.length, viewportRows);
    });
  }

  useGuardedInput(
    (input, key) => {
      lastClick.current = null;
      if (key.escape) onCancelWait?.(selectedItem);
      else if (viewportRows <= 0) return;
      else if (key.upArrow || input === "k")
        select(Math.max(0, selectedIndex - 1));
      else if (key.downArrow || input === "j")
        select(Math.min(items.length - 1, selectedIndex + 1));
      else if (key.home) select(0);
      else if (key.end) select(items.length - 1);
      else if (key.pageUp || key.pageDown) {
        const delta = Math.max(1, Math.floor(viewportRows / 2));
        select(
          Math.max(
            0,
            Math.min(
              items.length - 1,
              selectedIndex + (key.pageUp ? -delta : delta),
            ),
          ),
        );
      } else if ((key.return || input === " ") && selectedItem)
        onJump(selectedItem.paneId);
      else if (input === "x" && selectedItem) onKill(selectedItem);
      else if (input === "c" && selectedItem) onClose(selectedItem);
    },
    {
      isActive,
      onMouseEvent: (event) => {
        if (event.kind === "wheel") {
          lastClick.current = null;
          setScrollOffset((previous) =>
            clampListScrollOffset(
              previous + event.dir,
              rows.length,
              viewportRows,
            ),
          );
          return;
        }
        const viewportRow = event.row - 1 - HEADER_OFFSET;
        const rowIndex = offset + viewportRow;
        const row =
          viewportRow >= 0 && viewportRow < viewportRows
            ? rows[rowIndex]
            : undefined;
        setHoverRow(row?.kind === "agent" ? event.row : null);
        if (event.kind !== "press") return;
        if (event.button !== "left" || row?.kind !== "agent") {
          lastClick.current = null;
          return;
        }
        const item = items[row.itemIndex];
        if (!item) return;
        select(row.itemIndex);
        const detection = detectDoubleClick(
          lastClick.current,
          item.id,
          Date.now(),
        );
        lastClick.current = detection.history;
        if (detection.isDoubleClick) onJump(item.paneId);
      },
    },
  );

  const hoveredRow =
    hoverRow === null ? undefined : rows[offset + hoverRow - 1 - HEADER_OFFSET];
  return {
    selectedIndex,
    offset,
    hoveredItemIndex:
      hoveredRow?.kind === "agent" ? hoveredRow.itemIndex : null,
  };
}
