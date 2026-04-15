import { Box, Text, useInput } from "ink";

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
  useInput(
    (input) => {
      if (input === " ") onToggle();
    },
    { isActive: isFocused },
  );

  return (
    <Text color={isFocused ? "cyan" : "dim"} bold={isFocused}>
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
  useInput(
    (input, key) => {
      if (key.return || input === " ") onSubmit();
    },
    { isActive: isFocused && !disabled },
  );

  return (
    <Box marginTop={1}>
      <Text color={!disabled && isFocused ? "cyan" : "dim"} bold={isFocused}>
        {isFocused ? "▸ " : "  "}Submit
      </Text>
    </Box>
  );
}
