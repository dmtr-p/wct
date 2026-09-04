import { Box, Text } from "ink";
import { type LifecyclePhase, lifecycleProgressContent } from "../lifecycle";

interface Props {
  phase: LifecyclePhase;
  maxWidth: number;
}

/**
 * No spinner or elapsed timer: either would repaint the whole Ink frame
 * several times a second for the entire duration of a lifecycle.
 */
export function LifecycleProgressRow({ phase, maxWidth }: Props) {
  return (
    <Box>
      <Text color="yellow" wrap="truncate">
        {lifecycleProgressContent(phase, maxWidth)}
      </Text>
    </Box>
  );
}
