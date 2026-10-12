import type { BunServices } from "@effect/platform-bun";
import {
  Context,
  Crypto,
  Effect,
  FileSystem,
  Path,
  Stdio,
  Terminal,
} from "effect";
import { ChildProcessSpawner } from "effect/process";

export type ServiceImplementation<Service, Requirements> = {
  [Key in keyof Service]: Service[Key] extends Effect.Effect<infer A, infer E>
    ? Effect.Effect<A, E, Requirements>
    : Service[Key] extends (
          ...args: infer Args
        ) => Effect.Effect<infer A, infer E>
      ? (...args: Args) => Effect.Effect<A, E, Requirements>
      : never;
};

export const bunServiceKeys = [
  ChildProcessSpawner.ChildProcessSpawner,
  Crypto.Crypto,
  FileSystem.FileSystem,
  Path.Path,
  Stdio.Stdio,
  Terminal.Terminal,
] as const;

export function bindServiceContext<Service, Requirements>(
  implementation: ServiceImplementation<Service, Requirements>,
  context: Context.Context<Requirements>,
): Service {
  const entries = Object.entries(implementation).map(([key, value]) => {
    if (Effect.isEffect(value))
      return [key, Effect.provideContext(value, context)];
    const method = value as (
      ...args: unknown[]
    ) => Effect.Effect<unknown, unknown, Requirements>;
    return [
      key,
      (...args: unknown[]) =>
        Effect.provideContext(method.apply(implementation, args), context),
    ];
  });
  // Each public member keeps its arguments and result, with dependencies supplied.
  return Object.fromEntries(entries) as Service;
}

export function captureBunService<Service>(
  implementation: ServiceImplementation<Service, BunServices.BunServices>,
) {
  return Effect.map(Effect.context<BunServices.BunServices>(), (context) =>
    bindServiceContext<Service, BunServices.BunServices>(
      implementation,
      Context.pick(...bunServiceKeys)(context),
    ),
  );
}
