import { Effect } from "effect";
import type { WctServices } from "../effect/services";
import { toWctError, type WctError } from "../errors";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "tui",
  description:
    "Interactive TUI sidebar for managing worktrees (mouse on by default; WCT_DISABLE_MOUSE=1 to disable)",
};

export function tuiCommand(): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const { startTui } = yield* Effect.tryPromise({
      try: () => import("../tui/App"),
      catch: (error) => toWctError(error, "Failed to load TUI"),
    });
    // The TUI runtime is process-scoped here; we intentionally omit an
    // explicit runtime disposal call because command exit tears down the process.
    yield* Effect.tryPromise({
      try: () => startTui(),
      catch: (error) => toWctError(error, "Failed to start TUI"),
    });
  });
}
