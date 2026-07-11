import { Box, type DOMElement, measureElement } from "ink";
import { type ReactNode, useRef, useState } from "react";
import { useGuardedInput } from "../hooks/useGuardedInput";

interface Props {
  children: ReactNode | ((isHovered: boolean) => ReactNode);
  onClick: () => void;
  isActive?: boolean;
}

/** Hit-test a left mouse press against the rendered bounds of its children. */
export function MouseClickable({ children, onClick, isActive = true }: Props) {
  const ref = useRef<DOMElement>(null);
  const [isHovered, setIsHovered] = useState(false);

  useGuardedInput(() => {}, {
    isActive,
    onMouseEvent: (event) => {
      if (!ref.current || event.kind === "wheel") {
        return;
      }
      const { width, height } = measureElement(ref.current);
      let x = 0;
      let y = 0;
      let node: DOMElement | undefined = ref.current;
      while (node) {
        x += node.yogaNode?.getComputedLeft() ?? 0;
        y += node.yogaNode?.getComputedTop() ?? 0;
        node = node.parentNode;
      }
      const col = event.col - 1;
      const row = event.row - 1;
      const isInside =
        col >= x && col < x + width && row >= y && row < y + height;
      if (event.kind === "move") {
        setIsHovered(isInside);
      } else if (event.button === "left" && isInside) {
        onClick();
      }
    },
  });

  return (
    <Box ref={ref}>
      {typeof children === "function" ? children(isHovered) : children}
    </Box>
  );
}
