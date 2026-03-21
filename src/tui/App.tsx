import React from "react";
import { render, Text, Box } from "ink";

export function App() {
  return (
    <Box flexDirection="column">
      <Text bold>wct</Text>
      <Text dimColor>Loading...</Text>
    </Box>
  );
}

export function startTui() {
  render(<App />);
}
