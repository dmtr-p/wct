import { Box, Text } from "ink";
import { useGuardedInput } from "../hooks/useGuardedInput";

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
}: {
  label: string;
  checked: boolean;
  isFocused: boolean;
  onToggle: () => void;
}) {
  useGuardedInput(
    (input) => {
      if (input === " ") onToggle();
    },
    { isActive: isFocused },
  );

  return (
    <Text
      color={isFocused ? "cyan" : undefined}
      dimColor={!isFocused}
      bold={isFocused}
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
  useGuardedInput(
    (input, key) => {
      if ((key.return && !key.ctrl) || input === " ") onSubmit();
    },
    { isActive: isFocused && !disabled },
  );

  return (
    <Box marginTop={1}>
      <Text
        color={!disabled && isFocused ? "cyan" : undefined}
        dimColor={disabled || !isFocused}
        bold={isFocused}
      >
        {isFocused ? "▸ " : "  "}Submit
      </Text>
    </Box>
  );
}
