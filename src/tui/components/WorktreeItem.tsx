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

export function truncateBranch(branch: string, available: number): string {
  if (branch.length <= available) return branch;
  if (available <= 3) return ".".repeat(Math.max(0, available));
  return `${branch.slice(0, available - 3)}...`;
}

function branchBudget(maxWidth: number, overhead: number): number {
  return Math.max(0, maxWidth - overhead);
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
  const expandIcon = isExpanded
    ? "\u25BC "
    : hasExpandableData
      ? "\u25B6 "
      : "";

  const prefix = isSelected ? "❯   " : "    ";
  const openingDisplayBranch = truncateBranch(
    branch,
    branchBudget(
      maxWidth,
      prefix.length + "\u25CB ".length + " opening...".length,
    ),
  );
  const closingDisplayBranch = truncateBranch(
    branch,
    branchBudget(
      maxWidth,
      prefix.length + `${indicator} `.length + " closing...".length,
    ),
  );
  const mainSuffix =
    attached + (pendingStatus === "starting" ? " starting..." : "");
  const mainDisplayBranch = truncateBranch(
    branch,
    branchBudget(
      maxWidth,
      prefix.length +
        expandIcon.length +
        indicator.length +
        1 +
        mainSuffix.length,
    ),
  );
  const showStats = isSelected || isExpanded;
  const hasStats =
    (sync && sync !== "\u2713") || changedFiles > 0 || notifications > 0;

  if (pendingStatus === "opening") {
    return (
      <Box>
        <Text color={isSelected ? "cyan" : undefined}>{prefix}</Text>
        <Text color="yellow">
          <Text italic>
            {"\u25CB"} {openingDisplayBranch} opening...
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
          {indicator} {closingDisplayBranch} closing...
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
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
          {mainDisplayBranch}
        </Text>
        <Text dimColor>{attached}</Text>
      </Box>
      {showStats && hasStats ? (
        <Box>
          <Text>{"        "}</Text>
          {sync && sync !== "\u2713" ? <Text dimColor>{sync}</Text> : null}
          {changedFiles > 0 ? (
            <Text color="yellow">
              {sync && sync !== "\u2713" ? " " : ""}~{changedFiles}
            </Text>
          ) : null}
          {notifications > 0 ? (
            <Text color="yellow">
              {(sync && sync !== "\u2713") || changedFiles > 0 ? " " : ""}!
              {notifications}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
