import { Box, Text } from "ink";
import { useState } from "react";
import { useGuardedInput } from "../hooks/useGuardedInput";
import { Modal } from "./Modal";

export interface PrMenuOption {
  id: string;
  label: string;
  disabled?: boolean;
}

export function PrActionsModal({
  title,
  options,
  width,
  onChoose,
  onCancel,
}: {
  title: string;
  options: PrMenuOption[];
  width?: number;
  onChoose: (id: string) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState(0);
  useGuardedInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow || key.downArrow) {
        if (options.length === 0) return;
        const direction = key.upArrow ? -1 : 1;
        let next = selected;
        for (let i = 0; i < options.length; i++) {
          next = (next + direction + options.length) % options.length;
          if (!options[next]?.disabled) {
            setSelected(next);
            break;
          }
        }
      }
      if (key.return && !options[selected]?.disabled) {
        const id = options[selected]?.id;
        if (id) onChoose(id);
      }
    },
    { isActive: true },
  );
  return (
    <Modal title={title} visible width={width}>
      <Box flexDirection="column" paddingX={1}>
        {options.map((option, index) => (
          <Text
            key={option.id}
            color={
              option.disabled
                ? "#6c6f85"
                : index === selected
                  ? "cyan"
                  : undefined
            }
            bold={index === selected && !option.disabled}
          >
            {index === selected ? "▸ " : "  "}
            {option.label}
          </Text>
        ))}
        {options.length === 0 ? (
          <Text color="#6c6f85">No matching PRs</Text>
        ) : null}
        <Text color="#6c6f85">esc:close</Text>
      </Box>
    </Modal>
  );
}
