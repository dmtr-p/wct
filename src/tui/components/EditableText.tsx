import { Text } from "ink";
import { graphemes } from "../hooks/useTextEditing";

export function EditableText({
  value,
  cursor,
  isFocused,
  cursorVisible,
  dimColor = false,
}: {
  value: string;
  cursor: number;
  isFocused: boolean;
  cursorVisible: boolean;
  dimColor?: boolean;
}) {
  const chars = graphemes(value);
  const before = chars.slice(0, cursor).join("");
  const next = chars[cursor];
  const after = chars.slice(cursor + 1).join("");
  return (
    <Text dimColor={dimColor}>
      {before}
      {next === undefined ? (
        isFocused ? (
          cursorVisible ? (
            "▎"
          ) : (
            " "
          )
        ) : !value ? (
          " "
        ) : null
      ) : (
        <Text inverse={isFocused && cursorVisible}>{next}</Text>
      )}
      {after}
    </Text>
  );
}
