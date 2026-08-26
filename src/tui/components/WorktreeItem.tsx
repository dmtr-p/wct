import { Box, Text } from "ink";
import { truncateBranch } from "../utils/truncate";
import {
  SELECTED_ROW_BACKGROUND,
  SELECTED_ROW_FOREGROUND,
  selectedRowFill,
} from "./tree-row";

/**
 * A Workspace's identity line: expansion marker, session dot, branch name.
 *
 * It deliberately carries NO lifecycle status. Progress used to be painted
 * onto this row as an inline `opening…`/`closing…` suffix, which conflated
 * identity with status, jittered the branch's truncation budget as the suffix
 * changed, and could say nothing more specific than "something is happening".
 * Status now lives on a separate `LifecycleProgressRow` beneath this row; the
 * only thing a lifecycle changes here is that the Workspace is presented as
 * expanded (see `isWorktreeEffectivelyExpanded`).
 */
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
