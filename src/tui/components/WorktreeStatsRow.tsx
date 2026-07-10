import { Box, Text } from "ink";

interface Props {
  sync: string;
  changedFiles: number;
}

/**
 * The secondary stats line rendered beneath an expanded worktree row (e.g.
 * `↑1 ~3`). Split out of `WorktreeItem` so the visual-row model is terminal-row
 * accurate: one React element per terminal row.
 */
export function WorktreeStatsRow({ sync, changedFiles }: Props) {
  const hasSync = sync && sync !== "✓";
  return (
    <Box>
      <Text wrap="truncate">
        {"       "}
        {hasSync ? <Text dimColor>{sync}</Text> : null}
        {changedFiles > 0 ? (
          <Text color="yellow">
            {hasSync ? " " : ""}~{changedFiles}
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}
