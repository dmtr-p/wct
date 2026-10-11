import { Flag, GlobalFlag } from "effect/cli";

export const CompletionsFlag: typeof GlobalFlag.Completions = {
  ...GlobalFlag.Completions,
  flag: Flag.ChoiceWithValue("completions", [
    ["bash", "bash"],
    ["zsh", "zsh"],
    ["fish", "fish"],
    ["sh", "bash"],
  ] as const).pipe(
    Flag.optional,
    Flag.withMetavar("<bash|zsh|fish|sh>"),
    Flag.withDescription("Print shell completion script"),
  ),
};
