import { Effect, FileSystem } from "effect";
import { Box, Text } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBlink } from "../hooks/useBlink";
import { useGuardedInput } from "../hooks/useGuardedInput";
import { runTuiSilentPromise } from "../runtime";
import { MouseClickable } from "./MouseClickable";
import {
  clampListScrollOffset,
  getListPaddingCount,
  type ListItem,
  ListPadding,
  Scrollbar,
  scrollToRevealListItem,
} from "./ScrollableList";
import { TitledBox } from "./TitledBox";

/** Expand leading ~/ or bare ~ to $HOME. Does not expand ~user syntax. */
export function expandTilde(path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    const home = Bun.env.HOME ?? "/tmp";
    return home + path.slice(1);
  }
  return path;
}

/** Split input into parent directory and prefix for filtering */
export function getParentAndPrefix(input: string): {
  parent: string;
  prefix: string;
} {
  if (!input || input === "/") return { parent: "/", prefix: "" };
  if (input.endsWith("/")) return { parent: input, prefix: "" };
  const lastSlash = input.lastIndexOf("/");
  if (lastSlash === -1) return { parent: "/", prefix: input };
  return {
    parent: input.slice(0, lastSlash + 1),
    prefix: input.slice(lastSlash + 1),
  };
}

/** Apply a selected directory completion while preserving a leading tilde. */
export function completePathValue(
  value: string,
  selectedValue: string,
): string {
  const expanded = expandTilde(value);
  const { parent } = getParentAndPrefix(expanded);
  const newExpanded = `${parent + selectedValue}/`;
  const home = Bun.env.HOME ?? "/tmp";
  return value.startsWith("~") &&
    (newExpanded === home || newExpanded.startsWith(`${home}/`))
    ? `~${newExpanded.slice(home.length)}`
    : newExpanded;
}

interface PathInputProps {
  value: string;
  onChange: (value: string) => void;
  isFocused: boolean;
  isGitRepo: boolean;
  width?: number;
  onFocus?: () => void;
}

export function PathInput({
  value,
  onChange,
  isFocused,
  isGitRepo,
  width,
  onFocus,
}: PathInputProps) {
  const cursorVisible = useBlink();
  const [completions, setCompletions] = useState<ListItem[]>([]);
  const [selectedCompletionIndex, setSelectedCompletionIndex] = useState(0);
  const [completionScrollOffset, setCompletionScrollOffset] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef<{ cancelled: boolean } | null>(null);
  const maxVisible = 5;

  // Debounced directory listing
  const loadCompletions = useCallback((inputValue: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (cancelledRef.current) cancelledRef.current.cancelled = true;
    const token = { cancelled: false };
    cancelledRef.current = token;
    debounceRef.current = setTimeout(async () => {
      const expanded = expandTilde(inputValue);
      const { parent } = getParentAndPrefix(expanded);
      try {
        const entries = await runTuiSilentPromise(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const items = yield* fs.readDirectory(parent);
            const checked = yield* Effect.all(
              items.map((item) =>
                Effect.gen(function* () {
                  const stat = yield* fs.stat(parent + item);
                  return stat.type === "Directory" ? item : null;
                }).pipe(Effect.catch(() => Effect.succeed(null))),
              ),
              { concurrency: 16 },
            );
            return checked.filter((d): d is string => d !== null).sort();
          }),
        );
        if (token.cancelled) return;
        setCompletions(entries.map((d) => ({ label: d, value: d })));
        setSelectedCompletionIndex(0);
        setCompletionScrollOffset(0);
      } catch {
        if (token.cancelled) return;
        setCompletions([]);
        setSelectedCompletionIndex(0);
        setCompletionScrollOffset(0);
      }
    }, 100);
  }, []);

  useEffect(() => {
    if (isFocused) loadCompletions(value);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (cancelledRef.current) cancelledRef.current.cancelled = true;
    };
  }, [value, isFocused, loadCompletions]);

  // Filter completions by prefix
  const expanded = expandTilde(value);
  const { prefix } = getParentAndPrefix(expanded);
  const filtered = prefix
    ? completions.filter((c) =>
        c.label.toLowerCase().startsWith(prefix.toLowerCase()),
      )
    : completions;

  const completePath = useCallback(
    (selected: ListItem | undefined) => {
      if (!selected) return;
      onChange(completePathValue(value, selected.value));
      setSelectedCompletionIndex(0);
    },
    [onChange, value],
  );

  // Clamp selection when filtered list shrinks
  useEffect(() => {
    if (selectedCompletionIndex >= filtered.length && filtered.length > 0) {
      setSelectedCompletionIndex(filtered.length - 1);
    } else if (filtered.length === 0 && selectedCompletionIndex !== 0) {
      setSelectedCompletionIndex(0);
    }
  }, [filtered.length, selectedCompletionIndex]);

  const effectiveCompletionScrollOffset = clampListScrollOffset(
    completionScrollOffset,
    filtered.length,
    maxVisible,
  );

  useEffect(() => {
    setCompletionScrollOffset((offset) =>
      scrollToRevealListItem(
        offset,
        selectedCompletionIndex,
        filtered.length,
        maxVisible,
      ),
    );
  }, [filtered.length, selectedCompletionIndex]);

  useGuardedInput(
    (input, key) => {
      if (key.downArrow) {
        if (filtered.length === 0) return;
        setSelectedCompletionIndex((prev) =>
          Math.min(prev + 1, filtered.length - 1),
        );
        return;
      }
      if (key.upArrow) {
        if (filtered.length === 0) return;
        setSelectedCompletionIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (key.rightArrow && filtered.length > 0) {
        completePath(filtered[selectedCompletionIndex]);
        return;
      }
      if (key.backspace) {
        onChange(value.slice(0, -1));
        return;
      }
      // Regular character input
      if (
        input &&
        !key.ctrl &&
        !key.meta &&
        !key.escape &&
        !key.return &&
        !key.tab
      ) {
        onChange(value + input);
      }
    },
    {
      isActive: isFocused,
      onMouseEvent: (event) => {
        if (event.kind !== "wheel") return;
        setCompletionScrollOffset((offset) =>
          clampListScrollOffset(
            offset + event.dir,
            filtered.length,
            maxVisible,
          ),
        );
      },
    },
  );

  const title = isGitRepo ? "Path ✓" : "Path";
  const displayValue = value || (!isFocused || !cursorVisible ? " " : "");
  const showCompletions = isFocused && filtered.length > 0;
  const visible = showCompletions
    ? filtered.slice(
        effectiveCompletionScrollOffset,
        effectiveCompletionScrollOffset + maxVisible,
      )
    : [];

  return (
    <MouseClickable onClick={() => onFocus?.()}>
      {(isHovered) => (
        <TitledBox
          title={title}
          footer={
            showCompletions
              ? `${selectedCompletionIndex + 1} of ${filtered.length}`
              : undefined
          }
          isFocused={isFocused}
          isHovered={isHovered}
          width={width}
        >
          <Text dimColor={!isFocused}>
            {displayValue}
            {isFocused ? (cursorVisible ? "▎" : " ") : ""}
          </Text>
          {showCompletions &&
            visible.map((item, i) => {
              const actualIndex = effectiveCompletionScrollOffset + i;
              const isSelected = actualIndex === selectedCompletionIndex;
              return (
                <MouseClickable
                  key={item.value}
                  onClick={() => setSelectedCompletionIndex(actualIndex)}
                  onDoubleClick={() => completePath(item)}
                >
                  {(isHovered) => (
                    <Box position="relative" width="100%">
                      <Text
                        color={isSelected || isHovered ? "cyan" : undefined}
                        dimColor={!isSelected && !isHovered}
                        bold={isSelected || isHovered}
                      >
                        {isSelected ? "▸ " : "  "}
                        {item.label}/
                      </Text>
                      <Box flexGrow={1} />
                      <Scrollbar
                        row={i}
                        totalItems={filtered.length}
                        visibleItems={visible.length}
                        windowStart={effectiveCompletionScrollOffset}
                      />
                    </Box>
                  )}
                </MouseClickable>
              );
            })}
          <ListPadding
            count={getListPaddingCount(visible.length, maxVisible)}
          />
        </TitledBox>
      )}
    </MouseClickable>
  );
}
