import { Flag, GlobalFlag } from "effect/cli";
import { jsonOption } from "./global-options";

export const JsonFlag = GlobalFlag.Setting(jsonOption.name)({
  flag: Flag.Boolean(jsonOption.name).pipe(
    Flag.withoutNegation,
    Flag.withDescription(jsonOption.description),
    Flag.withDefault(false),
  ),
});
