import { Box, Text } from "ink";
import { displayWidth } from "../utils/display-width";
import { truncateBranch } from "../utils/truncate";
import {
  SELECTED_ROW_BACKGROUND,
  SELECTED_ROW_FOREGROUND,
  selectedRowFill,
} from "./tree-row";

interface Props {
  agentSummary?: string;
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
  agentSummary = "",
}: Props) {
  const active = isSelected || !!isChildSelected || !!isHovered;
  const indicator = hasSession ? "●" : "○";
  const indicatorColor = hasSession ? "green" : "gray";
  const attached = isAttached ? " *" : "";
  const expandIcon = isExpanded ? "▼ " : hasExpandableData ? "▶ " : "";
  const prefix = "   ";
  const summary = agentSummary
    ? truncateBranch(
        `  [${agentSummary}]`,
        Math.max(0, maxWidth - 14 - attached.length),
      )
    : "";

  const displayBranch = truncateBranch(
    branch,
    branchBudget(
      maxWidth,
      prefix.length +
        expandIcon.length +
        indicator.length +
        1 +
        attached.length +
        displayWidth(summary),
    ),
  );
  const content = `${prefix}${expandIcon}${indicator} ${displayBranch}${attached}${summary}`;

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
        <Text dimColor={!active}>{summary}</Text>
        {selectedRowFill(isSelected, maxWidth, content)}
      </Text>
    </Box>
  );
}
