import { Box, Text } from "ink";
import { truncateBranch } from "../utils/truncate";
import {
  SELECTED_ROW_BACKGROUND,
  SELECTED_ROW_FOREGROUND,
  selectedRowFill,
} from "./tree-row";

interface Props {
  project: string;
  isSelected: boolean;
  isChildSelected: boolean;
  worktreeCount: number;
  maxWidth: number;
  isRefreshing?: boolean;
  hasError?: boolean;
}

export function RepoNode({
  project,
  isSelected,
  isChildSelected,
  worktreeCount,
  maxWidth,
  isRefreshing,
  hasError,
}: Props) {
  const active = isSelected || isChildSelected;
  // Overhead is only the optional refresh/error suffixes. Repo rows no longer
  // reserve space for a selection pointer or disclosure icon.
  const refreshSuffix = isRefreshing ? " ↻" : "";
  const errorSuffix = hasError ? " ⚠" : "";
  const prefix = " ";
  const displayProject = truncateBranch(
    project,
    maxWidth - prefix.length - refreshSuffix.length - errorSuffix.length,
  );
  const content = prefix + displayProject + refreshSuffix + errorSuffix;

  return (
    <Box flexDirection="column">
      <Box>
        <Text
          color={isSelected ? SELECTED_ROW_FOREGROUND : undefined}
          backgroundColor={isSelected ? SELECTED_ROW_BACKGROUND : undefined}
          wrap="truncate"
        >
          {prefix}
          <Text color={isSelected ? undefined : "yellow"} bold={active}>
            {displayProject}
          </Text>
          {isRefreshing ? <Text dimColor={!isSelected}> ↻</Text> : null}
          {hasError ? (
            <Text color={isSelected ? undefined : "yellow"}> ⚠</Text>
          ) : null}
          {selectedRowFill(isSelected, maxWidth, content)}
        </Text>
      </Box>
      {worktreeCount === 0 ? (
        <Box>
          <Text wrap="truncate">
            {"   "}
            <Text dimColor>(no worktrees)</Text>
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
