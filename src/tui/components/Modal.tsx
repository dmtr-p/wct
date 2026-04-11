import type { ReactNode } from "react";
import { TitledBox } from "./TitledBox";

interface Props {
  title: string;
  children: ReactNode;
  visible: boolean;
  width?: number;
}

export function Modal({ title, children, visible, width }: Props) {
  if (!visible) return null;

  return (
    <TitledBox title={title} isFocused={true} width={width}>
      {children}
    </TitledBox>
  );
}
