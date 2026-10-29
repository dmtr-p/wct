import { Config, ConfigProvider, Context, Effect } from "effect";
import { commandError } from "../errors";

export function loadRuntimeConfig<A>(config: Config.Config<A>) {
  return Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    // The default provider caches its environment snapshot across executions.
    const provider =
      Context.getOrUndefined(context, ConfigProvider.ConfigProvider) ??
      ConfigProvider.fromEnv({ preserveEmptyStrings: true });
    return yield* config.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
      Effect.mapError((error) =>
        commandError("config_error", error.message, error),
      ),
    );
  });
}
