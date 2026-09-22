import { type Key, usePaste } from "ink";
import { useEffect, useRef, useState } from "react";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(value: string): string[] {
  return Array.from(segmenter.segment(value), ({ segment }) => segment);
}

export function normalizePastedText(value: string): string {
  return value.replace(/\r\n|\r|\n/g, " ");
}

/** Editing state for a controlled, single-line Ink field. */
export function useTextEditing(
  value: string,
  onChange: (value: string) => void,
  isFocused: boolean,
) {
  const [position, setPosition] = useState(() => graphemes(value).length);
  const positionRef = useRef(position);
  // Ink can dispatch several keystrokes from one stdin chunk before React
  // renders again. Keep the latest edit available to the next key event.
  const valueRef = useRef(value);
  if (value !== valueRef.current) valueRef.current = value;
  const wasFocused = useRef(isFocused);
  const characters = graphemes(value);
  const cursor = Math.min(positionRef.current, characters.length);

  const moveTo = (next: number) => {
    const clamped = Math.max(
      0,
      Math.min(next, graphemes(valueRef.current).length),
    );
    positionRef.current = clamped;
    setPosition(clamped);
  };
  const moveToEndOf = (nextValue: string) => {
    const end = graphemes(nextValue).length;
    valueRef.current = nextValue;
    positionRef.current = end;
    setPosition(end);
  };

  // External updates (autofill, reset) can shorten a value independently of
  // this editor. Returning focus always starts at the end of the new value.
  useEffect(() => {
    const end = graphemes(value).length;
    if ((isFocused && !wasFocused.current) || positionRef.current > end) {
      positionRef.current = end;
      setPosition(end);
    }
    wasFocused.current = isFocused;
  }, [isFocused, value]);

  const replace = (next: string[], nextPosition: number) => {
    const nextValue = next.join("");
    if (nextValue === valueRef.current) return;
    valueRef.current = nextValue;
    positionRef.current = nextPosition;
    setPosition(nextPosition);
    onChange(nextValue);
  };

  const insert = (text: string) => {
    const addition = graphemes(normalizePastedText(text));
    if (addition.length === 0) return;
    const next = graphemes(valueRef.current);
    const at = Math.min(positionRef.current, next.length);
    next.splice(at, 0, ...addition);
    replace(next, at + addition.length);
  };

  usePaste(insert, { isActive: isFocused });

  const handleInput = (input: string, key: Key): boolean => {
    const at = Math.min(
      positionRef.current,
      graphemes(valueRef.current).length,
    );
    // Ghostty's default Command+Left/Right bindings send Ctrl+A/E. Ink cannot
    // distinguish those bytes from the physical Ctrl shortcuts.
    if (
      key.home ||
      (key.super && key.leftArrow) ||
      (key.ctrl && input === "a")
    ) {
      moveTo(0);
      return true;
    }
    if (
      key.end ||
      (key.super && key.rightArrow) ||
      (key.ctrl && input === "e")
    ) {
      moveTo(graphemes(valueRef.current).length);
      return true;
    }
    // Ghostty's default Command+Backspace sends Ctrl+U. Kitty keyboard
    // protocol instead exposes the Command modifier on Backspace itself.
    if ((key.ctrl && input === "u") || (key.super && key.backspace)) {
      if (at > 0) replace(graphemes(valueRef.current).slice(at), 0);
      return true;
    }
    if (key.leftArrow) {
      moveTo(at - 1);
      return true;
    }
    if (key.rightArrow) {
      moveTo(at + 1);
      return true;
    }
    if (key.backspace || key.delete) {
      const next = graphemes(valueRef.current);
      const index = key.backspace ? at - 1 : at;
      if (index >= 0 && index < next.length) {
        next.splice(index, 1);
        replace(next, key.backspace ? at - 1 : at);
      }
      return true;
    }
    if (
      input &&
      !key.ctrl &&
      !key.meta &&
      !key.super &&
      !key.hyper &&
      !key.escape &&
      !key.return &&
      !key.tab
    ) {
      insert(input);
      return true;
    }
    return false;
  };

  return {
    cursor,
    atEnd: cursor === characters.length,
    handleInput,
    insert,
    moveTo,
    moveToEndOf,
  };
}
