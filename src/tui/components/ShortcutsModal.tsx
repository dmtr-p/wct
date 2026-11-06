import { Box, Text } from "ink";
import { Modal } from "./Modal";
import { ModalShortcut } from "./ModalShortcut";

interface Props {
  width?: number;
  onHide: () => void;
  agentsView?: boolean;
}

const SHORTCUTS = [
  ["↑ / ↓", "navigate"],
  ["← / →", "collapse / show details"],
  ["enter", "open selected PR in GitHub"],
  ["p", "PR actions"],
  ["space", "switch or activate"],
  ["o", "open worktree"],
  ["u", "start session"],
  ["d", "stop session"],
  ["c", "close worktree"],
  ["a", "add project"],
  ["g", "switch worktrees / agents view"],
  ["⌫ / delete", "remove selected project"],
  ["/", "search"],
  ["r", "refresh pull requests"],
  ["z", "zoom selected pane"],
  ["x", "kill selected pane"],
  ["q", "quit"],
] as const;

const AGENT_SHORTCUTS = [
  ["↑ / ↓", "select agent"],
  ["enter", "switch to agent pane"],
  ["space", "switch to agent pane"],
  ["x", "kill agent pane (confirm)"],
  ["c", "close agent workspace (confirm)"],
  ["home / end", "first / last agent"],
  ["pgup / pgdn", "navigate by page"],
  ["g", "switch to worktrees view"],
  ["a", "add project"],
  ["q", "quit"],
] as const;

export function ShortcutsModal({ width, onHide, agentsView = false }: Props) {
  return (
    <Modal title="Shortcuts" visible width={width}>
      <Box flexDirection="column" paddingX={1}>
        {(agentsView ? AGENT_SHORTCUTS : SHORTCUTS).map(
          ([key, description]) => (
            <Box key={key}>
              <Box width={10}>
                <Text color="cyan">{key}</Text>
              </Box>
              <Text>{description}</Text>
            </Box>
          ),
        )}
        <Box marginTop={1}>
          <ModalShortcut label="esc:close" onClick={onHide} />
        </Box>
      </Box>
    </Modal>
  );
}
