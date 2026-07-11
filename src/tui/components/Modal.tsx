import type { TextProps } from "ink";
import type { ReactNode } from "react";
import { TitledBox } from "./TitledBox";

interface Props {
  title: string;
  children: ReactNode;
  visible: boolean;
  width?: number;
  accentColor?: TextProps["color"];
  dimAccent?: boolean;
}

export function Modal({
  title,
  children,
  visible,
  width,
  accentColor,
  dimAccent,
}: Props) {
  if (!visible) return null;

  return (
    <TitledBox
      title={title}
      isFocused={true}
      width={width}
      accentColor={accentColor}
      dimAccent={dimAccent}
    >
      {children}
    </TitledBox>
  );
}
