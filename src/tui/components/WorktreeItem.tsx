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

  const displayBranch = truncateBranch(
    branch,
    branchBudget(
      maxWidth,
      prefix.length +
        expandIcon.length +
        indicator.length +
        1 +
        attached.length,
    ),
  );
  const content = `${prefix}${expandIcon}${indicator} ${displayBranch}${attached}`;

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
        </Text>
        {selectedRowFill(isSelected, maxWidth, content)}
      </Text>
    </Box>
  );
}
