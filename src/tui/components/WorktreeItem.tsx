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
  isExpanded?: boolean;
  hasExpandableData?: boolean;
  maxWidth: number;
}

function truncateBranch(branch: string, available: number): string {
  if (branch.length <= available) return branch;
  if (available <= 3) return branch.slice(0, Math.max(1, available));
  return `${branch.slice(0, available - 3)}...`;
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
  isExpanded,
  hasExpandableData,
  maxWidth,
}: Props) {
  const indicator = hasSession ? "\u25CF" : "\u25CB";
  const indicatorColor = hasSession ? "green" : "gray";
  const attached = isAttached ? " *" : "";
  const notifText = notifications > 0 ? ` !${notifications}` : "";
  const changesText = changedFiles > 0 ? ` ~${changedFiles}` : "";
  const expandIcon = isExpanded
    ? "\u25BC "
    : hasExpandableData
      ? "\u25B6 "
      : "";

  const prefix = isSelected ? "❯   " : "    ";
  // prefix=4, indicator=2, expandIcon=0or2, attached=0or2, margin=2
  const overhead = 4 + 2 + (expandIcon ? 2 : 0) + (isAttached ? 2 : 0) + 2;
  const available = Math.max(10, maxWidth - overhead);
  const displayBranch = truncateBranch(branch, available);

  if (pendingStatus === "opening") {
    return (
      <Box>
        <Text color={isSelected ? "cyan" : undefined}>{prefix}</Text>
        <Text color="yellow">
          <Text italic>
            {"\u25CB"} {displayBranch} opening...
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
          {indicator} {displayBranch} closing...
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color={isSelected ? "cyan" : undefined}>{prefix}</Text>
      {expandIcon ? <Text dimColor>{expandIcon}</Text> : null}
      <Text color={indicatorColor}>
        {indicator}
        {pendingStatus === "starting" ? (
          <Text dimColor> starting...</Text>
        ) : null}
      </Text>
      <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
        {" "}
        {displayBranch}
      </Text>
      <Text dimColor>{attached}</Text>
      {sync && sync !== "\u2713" ? <Text dimColor> {sync}</Text> : null}
      {changesText ? <Text color="yellow">{changesText}</Text> : null}
      {notifText ? <Text color="yellow">{notifText}</Text> : null}
    </Box>
  );
}
