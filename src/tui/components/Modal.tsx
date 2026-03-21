import { Box, Text } from "ink";
import type { ReactNode } from "react";

interface Props {
  title: string;
  children: ReactNode;
  visible: boolean;
}

export function Modal({ title, children, visible }: Props) {
  if (!visible) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text bold color="cyan">
        {title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
    </Box>
  );
}
