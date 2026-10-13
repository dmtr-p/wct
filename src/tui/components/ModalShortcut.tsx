import { Text } from "ink";
import { MouseClickable } from "./MouseClickable";

interface Props {
  label: string;
  onClick: () => void;
}

export function ModalShortcut({ label, onClick }: Props) {
  return (
    <MouseClickable onClick={onClick}>
      {(isHovered) => (
        <Text bold={isHovered} dimColor={!isHovered}>
          {label}
        </Text>
      )}
    </MouseClickable>
  );
}
