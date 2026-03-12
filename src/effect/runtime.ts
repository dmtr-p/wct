import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";

export { BunRuntime, BunServices };

export function provideBunServices<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | BunServices.BunServices> {
  return Effect.provide(effect, BunServices.layer);
}

export function runBunPromise<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Promise<A> {
  return Effect.runPromise(
    provideBunServices(effect) as unknown as Effect.Effect<A, E, never>,
  );
}

export function runBunSync<A, E, R>(effect: Effect.Effect<A, E, R>): A {
  return Effect.runSync(
    provideBunServices(effect) as unknown as Effect.Effect<A, E, never>,
  );
}
