import { Command, Flag, GlobalFlag } from "effect/cli";
import { COMPLETION_SHELLS, completionsOption } from "./global-options";
import { JsonFlag } from "./json-flag";

export const CompletionsFlag: typeof GlobalFlag.Completions = {
  ...GlobalFlag.Completions,
  run: (shell, context) =>
    GlobalFlag.Completions.run(shell, {
      ...context,
      // The static generator reads command parameters, not global flags.
      // Add them to the generation copy so they also reach subcommands.
      command: context.command.pipe(
        Command.withSharedFlags(
          Object.fromEntries(
            [
              ...context.builtIns.map((builtIn) => builtIn.flag),
              JsonFlag.flag,
            ].map((flag, index) => [`global${index}`, flag]),
          ),
        ),
      ),
    }),
  flag: Flag.ChoiceWithValue(
    completionsOption.name,
    COMPLETION_SHELLS.map(
      (shell) => [shell, shell === "sh" ? "bash" : shell] as const,
    ),
  ).pipe(
    Flag.optional,
    Flag.withMetavar(`<${COMPLETION_SHELLS.join("|")}>`),
    Flag.withDescription(completionsOption.description),
  ),
};
