import { Effect } from "effect";
import type { WctServices } from "../effect/services";
import type { WctError } from "../errors";
import type { CommandDef } from "./command-def";

export const commandDef: CommandDef = {
  name: "tui",
  description: "Interactive TUI sidebar for managing worktrees",
};

export function tuiCommand(): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const { startTui } = yield* Effect.promise(() => import("../tui/App"));
    yield* Effect.promise(() => startTui());
  });
}
