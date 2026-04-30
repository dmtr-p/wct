import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { runTuiSilentPromise } from "../runtime";
import { useBlink } from "../hooks/useBlink";
import { type ListItem, getVisibleWindow } from "./ScrollableList";
import { Effect, FileSystem } from "effect";

/** Expand leading ~/ or bare ~ to $HOME. Does not expand ~user syntax. */
export function expandTilde(path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    const home = process.env.HOME ?? "/tmp";
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

interface PathInputProps {
  value: string;
  onChange: (value: string) => void;
  isFocused: boolean;
  isGitRepo: boolean;
}

export function PathInput({
  value,
  onChange,
  isFocused,
  isGitRepo,
}: PathInputProps) {
  const cursorVisible = useBlink();
  const [completions, setCompletions] = useState<ListItem[]>([]);
  const [selectedCompletionIndex, setSelectedCompletionIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef<{ cancelled: boolean } | null>(null);

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
                }).pipe(Effect.catchAll(() => Effect.succeed(null))),
              ),
              { concurrency: 16 },
            );
            return checked.filter((d): d is string => d !== null).sort();
          }),
        );
        if (token.cancelled) return;
        setCompletions(entries.map((d) => ({ label: d, value: d })));
        setSelectedCompletionIndex(0);
      } catch {
        if (token.cancelled) return;
        setCompletions([]);
        setSelectedCompletionIndex(0);
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

  // Clamp selection when filtered list shrinks
  useEffect(() => {
    if (selectedCompletionIndex >= filtered.length && filtered.length > 0) {
      setSelectedCompletionIndex(filtered.length - 1);
    } else if (filtered.length === 0 && selectedCompletionIndex !== 0) {
      setSelectedCompletionIndex(0);
    }
  }, [filtered.length, selectedCompletionIndex]);

  useInput(
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
        // Accept completion
        const selected = filtered[selectedCompletionIndex];
        if (selected) {
          const { parent } = getParentAndPrefix(expanded);
          // Reconstruct with tilde if original used it
          const newExpanded = parent + selected.value + "/";
          const newValue = value.startsWith("~")
            ? "~" + newExpanded.slice((process.env.HOME ?? "/tmp").length)
            : newExpanded;
          onChange(newValue);
          setSelectedCompletionIndex(0);
        }
        return;
      }
      if (key.backspace || key.delete) {
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
    { isActive: isFocused },
  );

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isFocused ? "cyan" : "dim"} bold={isFocused}>
          Path:{" "}
        </Text>
        <Text>
          {value}
          {isFocused && cursorVisible ? "▎" : " "}
        </Text>
        {isGitRepo && <Text color="green"> ✓</Text>}
      </Box>
      {isFocused && filtered.length > 0 && (
        <Box flexDirection="column" marginLeft={6}>
          {(() => {
            const maxVisible = 8;
            const { start, end, hasAbove, hasBelow } = getVisibleWindow(
              filtered.length,
              selectedCompletionIndex,
              maxVisible,
            );
            const visible = filtered.slice(start, end);
            return (
              <>
                {hasAbove && <Text dimColor> ▲</Text>}
                {visible.map((item, i) => {
                  const actualIndex = start + i;
                  const isSelected = actualIndex === selectedCompletionIndex;
                  return (
                    <Text
                      key={item.value}
                      color={isSelected ? "cyan" : "dim"}
                      bold={isSelected}
                    >
                      {isSelected ? "▸ " : "  "}
                      {item.label}/
                    </Text>
                  );
                })}
                {hasBelow && <Text dimColor> ▼</Text>}
              </>
            );
          })()}
        </Box>
      )}
    </Box>
  );
}
