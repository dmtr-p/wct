import { Box, Text } from "ink";
import type { Mode } from "../types";
import { toSingleLine } from "../utils/truncate";
import { wrapText } from "../utils/wrap-text";
import { Modal } from "./Modal";
import { MouseClickable } from "./MouseClickable";

export type ConfirmMode = Extract<
  Mode,
  {
    type: "ConfirmKill" | "ConfirmDown" | "ConfirmClose" | "ConfirmCloseForce";
  }
>;

export function isConfirmMode(mode: Mode): mode is ConfirmMode {
  return (
    mode.type === "ConfirmKill" ||
    mode.type === "ConfirmDown" ||
    mode.type === "ConfirmClose" ||
    mode.type === "ConfirmCloseForce"
  );
}

interface Props {
  mode: ConfirmMode;
  width?: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function copyFor(mode: ConfirmMode): {
  title: string;
  question: string;
  confirmLabel: string;
} {
  switch (mode.type) {
    case "ConfirmKill":
      return {
        title: "Kill Pane",
        question: `Kill pane ${mode.label}?`,
        confirmLabel: "enter:confirm",
      };
    case "ConfirmDown":
      return {
        title: "Kill Session",
        question: `Kill session for ${mode.branch}?`,
        confirmLabel: "enter:confirm",
      };
    case "ConfirmClose":
      return {
        title: "Close Worktree",
        question: `Close worktree ${mode.branch}?`,
        confirmLabel: "enter:confirm",
      };
    case "ConfirmCloseForce":
      return {
        title: "Force Close Worktree",
        question: `${mode.branch} has uncommitted changes`,
        confirmLabel: "enter:force close",
      };
  }
}

export function confirmationQuestionLines(
  mode: ConfirmMode,
  width: number,
): string[] {
  return wrapText(copyFor(mode).question, Math.max(1, width - 4));
}

export function confirmModalRowCount(mode: ConfirmMode, width: number): number {
  return confirmationQuestionLines(mode, width).length + 4;
}

function Action({
  label,
  onClick,
  destructive = false,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <MouseClickable onClick={onClick}>
      {(isHovered) => (
        <Text
          wrap="truncate"
          color={destructive ? (isHovered ? "redBright" : "red") : undefined}
          bold={isHovered}
          dimColor={!destructive && !isHovered}
        >
          {label}
        </Text>
      )}
    </MouseClickable>
  );
}

export function ConfirmModal({ mode, width, onConfirm, onCancel }: Props) {
  const modalWidth = width ?? 40;
  const { title, confirmLabel } = copyFor(mode);
  const questionLines = confirmationQuestionLines(mode, modalWidth);

  return (
    <Modal title={title} visible width={width} accentColor="red" dimAccent>
      <Box flexDirection="column" paddingX={1}>
        <Text wrap="truncate">
          {questionLines.map(toSingleLine).join("\n")}
        </Text>
        <Box gap={2} marginTop={1}>
          <Action label={confirmLabel} onClick={onConfirm} destructive />
          <Action label="esc:cancel" onClick={onCancel} />
        </Box>
      </Box>
    </Modal>
  );
}
