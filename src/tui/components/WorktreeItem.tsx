import { Box, Text } from "ink";

interface Props {
  branch: string;
  hasSession: boolean;
  isAttached: boolean;
  sync: string;
  changedFiles: number;
  notifications: number;
  isSelected: boolean;
}

export function WorktreeItem({
  branch,
  hasSession,
  isAttached,
  sync,
  changedFiles,
  notifications,
  isSelected,
}: Props) {
  const indicator = hasSession ? "\u25CF" : "\u25CB";
  const indicatorColor = hasSession ? "green" : "gray";
  const attached = isAttached ? " *" : "";
  const notifText = notifications > 0 ? ` !${notifications}` : "";
  const changesText = changedFiles > 0 ? ` ~${changedFiles}` : "";

  const prefix = isSelected ? "❯   " : "    ";

  return (
    <Box>
      <Text color={isSelected ? "cyan" : undefined}>{prefix}</Text>
      <Text color={indicatorColor}>{indicator}</Text>
      <Text
        color={isSelected ? "cyan" : undefined}
        bold={isSelected}
        inverse={isSelected}
      >
        {" "}
        {branch}
      </Text>
      <Text dimColor>{attached}</Text>
      {sync && sync !== "\u2713" ? <Text dimColor> {sync}</Text> : null}
      {changesText ? <Text color="blue">{changesText}</Text> : null}
      {notifText ? <Text color="yellow">{notifText}</Text> : null}
    </Box>
  );
}
