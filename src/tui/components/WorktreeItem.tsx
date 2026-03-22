import { Box, Text } from "ink";

interface Props {
  branch: string;
  hasSession: boolean;
  isAttached: boolean;
  sync: string;
  changedFiles: number;
  notifications: number;
  isSelected: boolean;
  pendingStatus?: "opening" | "closing" | "starting";
}

export function WorktreeItem({
  branch,
  hasSession,
  isAttached,
  sync,
  changedFiles,
  notifications,
  isSelected,
  pendingStatus,
}: Props) {
  const indicator = hasSession ? "\u25CF" : "\u25CB";
  const indicatorColor = hasSession ? "green" : "gray";
  const attached = isAttached ? " *" : "";
  const notifText = notifications > 0 ? ` !${notifications}` : "";
  const changesText = changedFiles > 0 ? ` ~${changedFiles}` : "";

  const prefix = isSelected ? "❯   " : "    ";

  if (pendingStatus === "opening") {
    return (
      <Box>
        <Text color={isSelected ? "cyan" : undefined}>{prefix}</Text>
        <Text color="yellow">
          <Text italic>
            {"\u25CB"} {branch} opening...
          </Text>
        </Text>
      </Box>
    );
  }

  if (pendingStatus === "closing") {
    return (
      <Box>
        <Text color={isSelected ? "cyan" : undefined}>{prefix}</Text>
        <Text dimColor>
          {indicator} {branch} closing...
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color={isSelected ? "cyan" : undefined}>{prefix}</Text>
      <Text color={indicatorColor}>
        {indicator}
        {pendingStatus === "starting" ? (
          <Text dimColor> starting...</Text>
        ) : null}
      </Text>
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
      {changesText ? <Text color="yellow">{changesText}</Text> : null}
      {notifText ? <Text color="yellow">{notifText}</Text> : null}
    </Box>
  );
}
