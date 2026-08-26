import { Box, Text } from "ink";
import { type LifecyclePhase, lifecycleProgressContent } from "../lifecycle";

interface Props {
  phase: LifecyclePhase;
  maxWidth: number;
}

/**
 * The temporary Lifecycle Progress Row rendered directly beneath the Workspace
 * an `open`/`up`/`down`/`close` is acting on.
 *
 * Deliberately inert and deliberately still: a STATIC child connector, yellow
 * text, no spinner and no elapsed timer. A spinner or timer would repaint the
 * whole Ink frame several times a second for the entire duration of a
 * lifecycle, and the phase labels already tell the user which step is slow.
 * The content is truncated (never wrapped) by `lifecycleProgressContent`, so
 * the row occupies EXACTLY the one terminal row `buildTreeRows` budgeted for
 * it — and a long `Setup: <name>…` label can never leak past the terminal
 * width. Only the configured setup NAME reaches this component; the shell
 * command behind it never leaves `SetupService`.
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
