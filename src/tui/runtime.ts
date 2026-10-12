import { BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, ManagedRuntime } from "effect";
import { type WctServices, WctServicesLayer } from "../effect/services";
import { AgentService, makeAgentService } from "../services/agent-service";

const tuiLayer = Layer.mergeAll(
  Layer.effect(AgentService, makeAgentService()),
  WctServicesLayer,
).pipe(Layer.provideMerge(BunServices.layer));

export const tuiRuntime = ManagedRuntime.make(tuiLayer);

const noop = () => {};

const silentConsole: Console.Console = {
  assert: noop,
  clear: noop,
  count: noop,
  countReset: noop,
  debug: noop,
  dir: noop,
  dirxml: noop,
  error: noop,
  group: noop,
  groupCollapsed: noop,
  groupEnd: noop,
  info: noop,
  log: noop,
  table: noop,
  time: noop,
  timeEnd: noop,
  timeLog: noop,
  trace: noop,
  warn: noop,
};

export function runTuiSilentPromise<A, E>(
  effect: Effect.Effect<A, E, WctServices>,
): Promise<A> {
  return tuiRuntime.runPromise(
    Effect.provideService(
      effect,
      Console.Console,
      silentConsole,
    ) as Effect.Effect<A, E, WctServices>,
  );
}
