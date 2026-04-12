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
  onSubmit,
}: {
  isFocused: boolean;
  onSubmit: () => void;
}) {
  useInput(
    (input, key) => {
      if (key.return || input === " ") onSubmit();
    },
    { isActive: isFocused },
  );

  return (
    <Box marginTop={1}>
      <Text color={isFocused ? "cyan" : "dim"} bold={isFocused}>
        {isFocused ? "▸ " : "  "}Submit
      </Text>
    </Box>
  );
}
