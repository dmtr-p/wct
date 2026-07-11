import { Box, Text } from "ink";
import type { Mode } from "../types";
import { toSingleLine } from "../utils/truncate";
import { Modal } from "./Modal";
import { MouseClickable } from "./MouseClickable";

export type ConfirmMode = Extract<
  Mode,
  {
    type: "ConfirmKill" | "ConfirmDown" | "ConfirmClose" | "ConfirmCloseForce";
  }
>;

interface Props {
  mode: ConfirmMode;
  width?: number;
  onConfirm: () => void;
  onCancel: () => void;
}

function copyFor(mode: ConfirmMode): {
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
        title: "Stop Session",
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
  const { title, question, confirmLabel } = copyFor(mode);

  return (
    <Modal title={title} visible width={width} accentColor="red" dimAccent>
      <Box flexDirection="column" paddingX={1}>
        <Text wrap="truncate">{toSingleLine(question)}</Text>
        <Box gap={2} marginTop={1}>
          <Action label={confirmLabel} onClick={onConfirm} destructive />
          <Action label="esc:cancel" onClick={onCancel} />
        </Box>
      </Box>
    </Modal>
  );
}
