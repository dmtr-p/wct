import { Flag, GlobalFlag } from "effect/cli";
import { COMPLETION_SHELLS, completionsOption } from "./global-options";

export const CompletionsFlag: typeof GlobalFlag.Completions = {
  ...GlobalFlag.Completions,
  flag: Flag.ChoiceWithValue(
    completionsOption.name,
    COMPLETION_SHELLS.map((shell) => [shell, shell] as const),
  ).pipe(
    Flag.optional,
    Flag.withMetavar(`<${COMPLETION_SHELLS.join("|")}>`),
    Flag.withDescription(completionsOption.description),
  ),
};
