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
  isHovered?: boolean;
  maxWidth: number;
  isRefreshing?: boolean;
  hasError?: boolean;
}

export function RepoNode({
  project,
  isSelected,
  isChildSelected,
  isHovered,
  maxWidth,
  isRefreshing,
  hasError,
}: Props) {
  const active = isSelected || isChildSelected || !!isHovered;
  const prefix = " ";
  const refreshSuffix = isRefreshing ? " ↻" : "";
  const errorSuffix = hasError ? " ⚠" : "";
  const displayProject = truncateBranch(
    project,
    maxWidth - prefix.length - refreshSuffix.length - errorSuffix.length,
  );
  const content = prefix + displayProject + refreshSuffix + errorSuffix;

  return (
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
        {isRefreshing ? <Text dimColor={!active}> ↻</Text> : null}
        {hasError ? (
          <Text color={isSelected ? undefined : "yellow"} bold={active}>
            {" ⚠"}
          </Text>
        ) : null}
        {selectedRowFill(isSelected, maxWidth, content)}
      </Text>
    </Box>
  );
}
