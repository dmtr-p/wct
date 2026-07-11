import { Box, Text } from "ink";
import { useRef } from "react";
import { useGuardedInput } from "../hooks/useGuardedInput";
import { MouseClickable } from "./MouseClickable";

export function isSubmitShortcut(key: {
  ctrl?: boolean;
  return?: boolean;
}): boolean {
  return Boolean(key.ctrl && key.return);
}

export function ToggleRow({
  label,
  checked,
  isFocused,
  onToggle,
  isHovered = false,
}: {
  label: string;
  checked: boolean;
  isFocused: boolean;
  onToggle: () => void;
  isHovered?: boolean;
}) {
  useGuardedInput(
    (input) => {
      if (input === " ") onToggle();
    },
    { isActive: isFocused },
  );

  return (
    <Text
      color={isFocused || isHovered ? "cyan" : undefined}
      dimColor={!isFocused && !isHovered}
      bold={isFocused || isHovered}
    >
      {checked ? "[x]" : "[ ]"} {label}
    </Text>
  );
}

export function SubmitButton({
  isFocused,
  disabled = false,
  onSubmit,
}: {
  isFocused: boolean;
  disabled?: boolean;
  onSubmit: () => void;
}) {
  const activationPendingRef = useRef(false);
  const activate = () => {
    if (disabled || activationPendingRef.current) return;
    activationPendingRef.current = true;
    queueMicrotask(() => {
      activationPendingRef.current = false;
    });
    onSubmit();
  };

  useGuardedInput(
    (input, key) => {
      if ((key.return && !key.ctrl) || input === " ") activate();
    },
    { isActive: isFocused && !disabled },
  );

  return (
    <Box marginTop={1}>
      <MouseClickable onClick={activate}>
        {(isHovered) => (
          <Box>
            <Text
              color={!disabled && (isFocused || isHovered) ? "cyan" : undefined}
              dimColor={disabled || (!isFocused && !isHovered)}
              bold={isFocused || isHovered}
            >
              {isFocused ? "▸ " : "  "}Submit
            </Text>
          </Box>
        )}
      </MouseClickable>
    </Box>
  );
}
