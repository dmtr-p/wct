import { Box, Text } from "ink";
import { truncateBranch } from "../utils/truncate";

interface Props {
  branch: string;
  hasSession: boolean;
  isAttached: boolean;
  isSelected: boolean;
  isChildSelected?: boolean;
  pendingStatus?: "opening" | "closing" | "starting" | "stopping";
  isExpanded?: boolean;
  hasExpandableData?: boolean;
  maxWidth: number;
}

function branchBudget(maxWidth: number, overhead: number): number {
  return Math.max(0, maxWidth - overhead);
}

export function WorktreeItem({
  branch,
  hasSession,
  isAttached,
  isSelected,
  isChildSelected,
  pendingStatus,
  isExpanded,
  hasExpandableData,
  maxWidth,
}: Props) {
  const active = isSelected || !!isChildSelected;
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
  const stoppingDisplayBranch = truncateBranch(
    branch,
    branchBudget(
      maxWidth,
      prefix.length + `${indicator} `.length + " stopping...".length,
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

  if (pendingStatus === "stopping") {
    return (
      <Box>
        <Text color={isSelected ? "cyan" : undefined}>{prefix}</Text>
        <Text dimColor>
          {indicator} {stoppingDisplayBranch} stopping...
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
      <Text color={isSelected ? "cyan" : undefined} bold={active}>
        {" "}
        {mainDisplayBranch}
      </Text>
      <Text dimColor>{attached}</Text>
    </Box>
  );
}
