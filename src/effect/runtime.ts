import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";

export { BunRuntime, BunServices };

export function provideBunServices<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, BunServices.BunServices>> {
  return Effect.provide(effect, BunServices.layer);
}

export function runBunPromise<A, E>(effect: Effect.Effect<A, E, never>): Promise<A>;
export function runBunPromise<A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices>,
): Promise<A>;
export function runBunPromise(
  effect: Effect.Effect<any, any, never | BunServices.BunServices>,
): Promise<any> {
  return Effect.runPromise(provideBunServices(effect));
}

export function runBunSync<A, E>(effect: Effect.Effect<A, E, never>): A;
export function runBunSync<A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices>,
): A;
export function runBunSync(
  effect: Effect.Effect<any, any, never | BunServices.BunServices>,
): any {
  return Effect.runSync(provideBunServices(effect));
}
