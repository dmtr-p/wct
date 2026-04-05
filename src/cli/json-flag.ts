import { Flag, GlobalFlag } from "../effect/cli";

export const JsonFlag = GlobalFlag.setting("json")({
  flag: Flag.boolean("json").pipe(
    Flag.withDescription("Output results as JSON"),
    Flag.withDefault(false),
  ),
});
