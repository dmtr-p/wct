import { Box, Text } from "ink";
import { truncateBranch } from "../utils/truncate";
import {
  SELECTED_ROW_BACKGROUND,
  SELECTED_ROW_FOREGROUND,
  selectedRowFill,
} from "./tree-row";

interface Props {
  branch: string;
  hasSession: boolean;
  isAttached: boolean;
  isSelected: boolean;
  isChildSelected?: boolean;
  isHovered?: boolean;
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
  isHovered,
  pendingStatus,
  isExpanded,
  hasExpandableData,
  maxWidth,
}: Props) {
  const active = isSelected || !!isChildSelected || !!isHovered;
  const indicator = hasSession ? "●" : "○";
  const indicatorColor = hasSession ? "green" : "gray";
  const attached = isAttached ? " *" : "";
  const expandIcon = isExpanded ? "▼ " : hasExpandableData ? "▶ " : "";
  const prefix = "   ";

  const pendingRow = (
    suffix: "opening..." | "closing..." | "stopping...",
    rowIndicator: string,
  ) => {
    const displayBranch = truncateBranch(
      branch,
      branchBudget(
        maxWidth,
        prefix.length + rowIndicator.length + 1 + suffix.length + 1,
      ),
    );
    return {
      content: `${prefix}${rowIndicator} ${displayBranch} ${suffix}`,
      displayBranch,
    };
  };

  if (pendingStatus === "opening") {
    const { content, displayBranch } = pendingRow("opening...", "○");
    return (
      <Box>
        <Text
          color={isSelected ? SELECTED_ROW_FOREGROUND : "yellow"}
          backgroundColor={isSelected ? SELECTED_ROW_BACKGROUND : undefined}
          bold={isHovered}
          wrap="truncate"
        >
          {prefix}
          <Text italic>○ {displayBranch} opening...</Text>
          {selectedRowFill(isSelected, maxWidth, content)}
        </Text>
      </Box>
    );
  }

  if (pendingStatus === "closing" || pendingStatus === "stopping") {
    const suffix = pendingStatus === "closing" ? "closing..." : "stopping...";
    const { content, displayBranch } = pendingRow(suffix, indicator);
    return (
      <Box>
        <Text
          color={isSelected ? SELECTED_ROW_FOREGROUND : undefined}
          backgroundColor={isSelected ? SELECTED_ROW_BACKGROUND : undefined}
          dimColor={!isSelected && !isHovered}
          bold={isHovered}
          wrap="truncate"
        >
          {prefix}
          {indicator} {displayBranch} {suffix}
          {selectedRowFill(isSelected, maxWidth, content)}
        </Text>
      </Box>
    );
  }

  const starting = pendingStatus === "starting" ? " starting..." : "";
  const displayBranch = truncateBranch(
    branch,
    branchBudget(
      maxWidth,
      prefix.length +
        expandIcon.length +
        indicator.length +
        1 +
        attached.length +
        starting.length,
    ),
  );
  const content = `${prefix}${expandIcon}${indicator} ${displayBranch}${attached}${starting}`;

  return (
    <Box>
      <Text
        color={isSelected ? SELECTED_ROW_FOREGROUND : undefined}
        backgroundColor={isSelected ? SELECTED_ROW_BACKGROUND : undefined}
        wrap="truncate"
      >
        {prefix}
        {expandIcon ? <Text dimColor={!active}>{expandIcon}</Text> : null}
        <Text color={isSelected ? undefined : indicatorColor}>{indicator}</Text>
        <Text bold={active}> {displayBranch}</Text>
        <Text dimColor={!active} bold={isHovered}>
          {attached}
          {starting}
        </Text>
        {selectedRowFill(isSelected, maxWidth, content)}
      </Text>
    </Box>
  );
}
