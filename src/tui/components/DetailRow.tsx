import { Box, Text } from "ink";
import { PR_INDENT, prLabelStart, wrapPrLabel } from "../pr-layout";
import { compactPrText, PR_COLORS } from "../pr-status";
import type { TreeItem } from "../types";
import { truncateBranch, truncateWithPrefix } from "../utils/truncate";
import {
  SELECTED_ROW_BACKGROUND,
  SELECTED_ROW_FOREGROUND,
  selectedRowFill,
} from "./tree-row";

interface Props {
  item: Extract<TreeItem, { type: "detail" }>;
  isSelected: boolean;
  isHovered?: boolean;
  maxWidth: number;
  pieceIndex?: number;
  prLine?: string;
}

function rollupIcon(
  rollupState: "success" | "failure" | "pending" | "unknown" | null,
): string {
  switch (rollupState) {
    case "success":
      return "✓";
    case "failure":
      return "✗";
    case "pending":
      return "◌";
    case "unknown":
      return "?";
    default:
      return "";
  }
}

function rollupColor(
  rollupState: "success" | "failure" | "pending" | "unknown" | null,
): "green" | "red" | "yellow" | undefined {
  switch (rollupState) {
    case "success":
      return "green";
    case "failure":
      return "red";
    case "pending":
      return "yellow";
    default:
      return undefined;
  }
}

export function DetailRow({
  item,
  isSelected,
  isHovered,
  maxWidth,
  pieceIndex = 0,
  prLine,
}: Props) {
  const highlighted = isSelected || !!isHovered;
  const selectedProps = {
    color: isSelected ? SELECTED_ROW_FOREGROUND : undefined,
    backgroundColor: isSelected ? SELECTED_ROW_BACKGROUND : undefined,
  };

  switch (item.detailKind) {
    case "pane-header": {
      const indent = "     ";
      const displayLabel = truncateBranch(item.label, maxWidth - indent.length);
      const content = indent + displayLabel;
      return (
        <Box>
          <Text
            {...selectedProps}
            bold={isSelected}
            dimColor={!isSelected}
            wrap="truncate"
          >
            {content}
            {selectedRowFill(isSelected, maxWidth, content)}
          </Text>
        </Box>
      );
    }

    case "pr": {
      if (item.meta.presentation && item.meta.pr) {
        const { presentation, pr, expanded } = item.meta;
        const line = compactPrText(pr.number, presentation, maxWidth, expanded);
        const statusAt = line.indexOf(presentation.primary);
        const prefix = statusAt >= 0 ? line.slice(0, statusAt) : line;
        const numberText = `#${pr.number}`;
        const numberAt = prefix.indexOf(numberText);
        const beforeNumber = numberAt >= 0 ? prefix.slice(0, numberAt) : prefix;
        const afterNumber =
          numberAt >= 0 ? prefix.slice(numberAt + numberText.length) : "";
        const suffix =
          statusAt >= 0
            ? line.slice(statusAt + presentation.primary.length)
            : "";
        const checksMatch = suffix.match(/ · checks [✓✗◌?]/);
        const checkBefore = checksMatch
          ? suffix.slice(0, checksMatch.index)
          : suffix;
        const checkAfter = checksMatch
          ? suffix.slice((checksMatch.index ?? 0) + checksMatch[0].length)
          : "";
        const checkTone =
          presentation.checks === "success"
            ? PR_COLORS.green
            : presentation.checks === "failure"
              ? PR_COLORS.red
              : presentation.checks === "pending"
                ? PR_COLORS.yellow
                : PR_COLORS.muted;
        return (
          <Box>
            <Text {...selectedProps} wrap="truncate">
              {beforeNumber}
              {numberAt >= 0 ? <Text bold>{numberText}</Text> : null}
              {afterNumber ? (
                <Text
                  color={
                    isSelected
                      ? undefined
                      : statusAt < 0 && presentation.stale
                        ? PR_COLORS.muted
                        : undefined
                  }
                >
                  {afterNumber}
                </Text>
              ) : null}
              {statusAt >= 0 ? (
                <Text
                  color={
                    isSelected
                      ? undefined
                      : PR_COLORS[
                          presentation.stale ? "muted" : presentation.tone
                        ]
                  }
                  bold={presentation.bold}
                >
                  {presentation.primary}
                </Text>
              ) : null}
              {checkBefore}
              {checksMatch ? (
                <Text
                  color={
                    isSelected
                      ? undefined
                      : presentation.stale
                        ? PR_COLORS.muted
                        : checkTone
                  }
                >
                  {checksMatch[0]}
                </Text>
              ) : null}
              {checkAfter ? (
                <Text color={isSelected ? undefined : PR_COLORS.muted}>
                  {checkAfter}
                </Text>
              ) : null}
              {selectedRowFill(isSelected, maxWidth, line)}
            </Text>
          </Box>
        );
      }
      const { rollupState } = item.meta;
      const icon = rollupIcon(rollupState);
      const iconText = icon ? `${icon} ` : "";
      const line =
        prLine ??
        wrapPrLabel(item.label, maxWidth, icon !== "")[pieceIndex] ??
        "";
      const indent = " ".repeat(prLabelStart(icon !== ""));

      if (pieceIndex > 0) {
        const content = indent + line;
        return (
          <Box>
            <Text {...selectedProps} bold={highlighted} wrap="truncate-end">
              {content}
              {selectedRowFill(isSelected, maxWidth, content)}
            </Text>
          </Box>
        );
      }

      const leading = " ".repeat(PR_INDENT);
      const content = leading + iconText + line;
      return (
        <Box>
          <Text {...selectedProps} bold={highlighted} wrap="truncate-end">
            {leading}
            {icon ? (
              <Text color={isSelected ? undefined : rollupColor(rollupState)}>
                {iconText}
              </Text>
            ) : null}
            {line}
            {selectedRowFill(isSelected, maxWidth, content)}
          </Text>
        </Box>
      );
    }

    case "pr-title": {
      const indent = "         ";
      const content = indent + (prLine ?? item.label);
      return (
        <Box>
          <Text {...selectedProps} wrap="truncate-end">
            {content}
            {selectedRowFill(isSelected, maxWidth, content)}
          </Text>
        </Box>
      );
    }

    case "pr-fact": {
      const indent = "         ";
      const content =
        indent + truncateBranch(item.label, maxWidth - indent.length);
      return (
        <Box>
          <Text
            {...selectedProps}
            color={isSelected ? SELECTED_ROW_FOREGROUND : PR_COLORS.muted}
            wrap="truncate"
          >
            {content}
            {selectedRowFill(isSelected, maxWidth, content)}
          </Text>
        </Box>
      );
    }

    case "candidate-group": {
      const content = `     ${item.meta.expanded ? "▾" : "▸"} ${item.label}`;
      const line = truncateBranch(content, maxWidth);
      return (
        <Box>
          <Text {...selectedProps} wrap="truncate">
            {line}
            {selectedRowFill(isSelected, maxWidth, line)}
          </Text>
        </Box>
      );
    }

    case "candidate": {
      const indent = "         ";
      const content =
        indent + truncateBranch(item.label, maxWidth - indent.length);
      return (
        <Box>
          <Text {...selectedProps} wrap="truncate">
            {content}
            {selectedRowFill(isSelected, maxWidth, content)}
          </Text>
        </Box>
      );
    }

    case "pane": {
      const indent = "       ";
      const { window, paneIndex, command, zoomed, active } = item.meta;
      const zoomedEmoji = zoomed && active ? "🔍 " : "";
      const panePrefix = `${window}:${paneIndex} `;
      const displayLabel = truncateWithPrefix(
        panePrefix,
        command,
        maxWidth - indent.length - (zoomedEmoji ? 3 : 0),
      );
      const content = indent + zoomedEmoji + displayLabel;
      return (
        <Box>
          <Text
            {...selectedProps}
            dimColor={!highlighted}
            bold={highlighted}
            wrap="truncate"
          >
            {content}
            {selectedRowFill(isSelected, maxWidth, content)}
          </Text>
        </Box>
      );
    }
  }
}
