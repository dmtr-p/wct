import { Box, Text } from "ink";
import React from "react";

interface Props {
  branch: string;
  hasSession: boolean;
  isAttached: boolean;
  sync: string;
  notifications: number;
  isSelected: boolean;
}

export function WorktreeItem({
  branch,
  hasSession,
  isAttached,
  sync,
  notifications,
  isSelected,
}: Props) {
  const indicator = hasSession ? "\u25CF" : "\u25CB";
  const indicatorColor = hasSession ? "green" : "gray";
  const attached = isAttached ? " *" : "";
  const notifText = notifications > 0 ? ` !${notifications}` : "";

  return (
    <Box>
      <Text color={isSelected ? "cyan" : undefined}>
        {"  "}
        <Text color={indicatorColor}>{indicator}</Text> {branch}
        <Text dimColor>{attached}</Text>
        {sync && sync !== "\u2713" ? <Text dimColor> {sync}</Text> : null}
        {notifText ? <Text color="yellow">{notifText}</Text> : null}
      </Text>
    </Box>
  );
}
