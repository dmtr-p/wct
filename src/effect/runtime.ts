import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";

export { BunRuntime, BunServices };

export function provideBunServices<A, E>(
  effect: Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never>;
export function provideBunServices<A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices>,
): Effect.Effect<A, E, never>;
export function provideBunServices<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, BunServices.BunServices>> {
  return Effect.provide(effect, BunServices.layer);
}

export function runBunPromise<A, E>(
  effect: Effect.Effect<A, E, never>,
): Promise<A>;
export function runBunPromise<A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices>,
): Promise<A>;
export function runBunPromise<A, E, R extends never | BunServices.BunServices>(
  effect: Effect.Effect<A, E, R>,
): Promise<A> {
  return Effect.runPromise(provideBunServices(effect));
}

export function runBunSync<A, E>(effect: Effect.Effect<A, E, never>): A;
export function runBunSync<A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices>,
): A;
export function runBunSync<A, E, R extends never | BunServices.BunServices>(
  effect: Effect.Effect<A, E, R>,
): A {
  return Effect.runSync(provideBunServices(effect));
}
