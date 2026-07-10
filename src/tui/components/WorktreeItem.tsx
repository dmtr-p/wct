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
  sync: string;
  changedFiles: number;
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
  sync,
  changedFiles,
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

  const prefix = "   ";
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
  const hasStats = (sync && sync !== "\u2713") || changedFiles > 0;

  if (pendingStatus === "opening") {
    const content = `${prefix}\u25CB ${openingDisplayBranch} opening...`;
    return (
      <Box>
        <Text
          color={isSelected ? SELECTED_ROW_FOREGROUND : "yellow"}
          backgroundColor={isSelected ? SELECTED_ROW_BACKGROUND : undefined}
          wrap="truncate"
        >
          {prefix}
          <Text italic>
            {"\u25CB"} {openingDisplayBranch} opening...
          </Text>
          {selectedRowFill(isSelected, maxWidth, content)}
        </Text>
      </Box>
    );
  }

  if (pendingStatus === "closing") {
    const content = `${prefix}${indicator} ${closingDisplayBranch} closing...`;
    return (
      <Box>
        <Text
          color={isSelected ? SELECTED_ROW_FOREGROUND : undefined}
          backgroundColor={isSelected ? SELECTED_ROW_BACKGROUND : undefined}
          dimColor={!isSelected}
          wrap="truncate"
        >
          {prefix}
          {indicator} {closingDisplayBranch} closing...
          {selectedRowFill(isSelected, maxWidth, content)}
        </Text>
      </Box>
    );
  }

  if (pendingStatus === "stopping") {
    const content = `${prefix}${indicator} ${stoppingDisplayBranch} stopping...`;
    return (
      <Box>
        <Text
          color={isSelected ? SELECTED_ROW_FOREGROUND : undefined}
          backgroundColor={isSelected ? SELECTED_ROW_BACKGROUND : undefined}
          dimColor={!isSelected}
          wrap="truncate"
        >
          {prefix}
          {indicator} {stoppingDisplayBranch} stopping...
          {selectedRowFill(isSelected, maxWidth, content)}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text
          color={isSelected ? SELECTED_ROW_FOREGROUND : undefined}
          backgroundColor={isSelected ? SELECTED_ROW_BACKGROUND : undefined}
          wrap="truncate"
        >
          {prefix}
          {expandIcon ? <Text dimColor={!isSelected}>{expandIcon}</Text> : null}
          <Text color={isSelected ? undefined : indicatorColor}>
            {indicator}
            {pendingStatus === "starting" ? (
              <Text dimColor={!isSelected}> starting...</Text>
            ) : null}
          </Text>
          <Text bold={active}> {mainDisplayBranch}</Text>
          <Text dimColor={!isSelected}>{attached}</Text>
          {selectedRowFill(
            isSelected,
            maxWidth,
            prefix +
              expandIcon +
              indicator +
              (pendingStatus === "starting" ? " starting..." : "") +
              ` ${mainDisplayBranch}` +
              attached,
          )}
        </Text>
      </Box>
      {isExpanded && hasStats ? (
        <Box>
          <Text wrap="truncate">
            {"       "}
            {sync && sync !== "\u2713" ? <Text dimColor>{sync}</Text> : null}
            {changedFiles > 0 ? (
              <Text color="yellow">
                {sync && sync !== "\u2713" ? " " : ""}~{changedFiles}
              </Text>
            ) : null}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
