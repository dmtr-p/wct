import { Box, Text } from "ink";
import { Modal } from "./Modal";
import { ModalShortcut } from "./ModalShortcut";

interface Props {
  width?: number;
  onHide: () => void;
}

const SHORTCUTS = [
  ["↑ / ↓", "navigate"],
  ["← / →", "collapse / show details"],
  ["space", "switch or activate"],
  ["o", "open worktree"],
  ["u", "start session"],
  ["d", "stop session"],
  ["c", "close worktree"],
  ["a", "add project"],
  ["/", "search"],
  ["r", "refresh pull requests"],
  ["z", "zoom selected pane"],
  ["x", "kill selected pane"],
  ["q", "quit"],
] as const;

export function ShortcutsModal({ width, onHide }: Props) {
  return (
    <Modal title="Shortcuts" visible width={width}>
      <Box flexDirection="column" paddingX={1}>
        {SHORTCUTS.map(([key, description]) => (
          <Box key={key}>
            <Box width={10}>
              <Text color="cyan">{key}</Text>
            </Box>
            <Text>{description}</Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <ModalShortcut label="esc:close" onClick={onHide} />
        </Box>
      </Box>
    </Modal>
  );
}
