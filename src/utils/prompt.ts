import { Effect, Option } from "effect";
import { Prompt } from "effect/cli";
import { JsonFlag } from "../cli/json-flag";

export function confirm(message: string) {
  return Effect.gen(function* () {
    const json = yield* Effect.serviceOption(JsonFlag);
    if (Option.getOrElse(json, () => false)) return false;
    return yield* Prompt.run(
      Prompt.Confirm({
        message,
        initial: false,
      }),
    );
  });
}
