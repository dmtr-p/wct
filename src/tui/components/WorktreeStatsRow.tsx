import { Box, Text } from "ink";

interface Props {
  sync: string;
  changedFiles: number;
}

/** Keep one terminal row so tree windowing and mouse hit-testing agree. */
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
