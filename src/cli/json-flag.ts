import { Flag, GlobalFlag } from "../effect/cli";

export const JsonFlag = GlobalFlag.Setting("json")({
  flag: Flag.Boolean("json").pipe(
    Flag.withDescription("Output results as JSON"),
    Flag.withDefault(false),
  ),
});
