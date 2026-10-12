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

type ServiceEffects<Service> = {
  [Key in keyof Service]: Service[Key] extends (
    ...args: never[]
  ) => infer Result
    ? Result
    : Service[Key];
}[keyof Service];

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
  type MemberEffect = Effect.Effect<
    Effect.Success<ServiceEffects<Service>>,
    Effect.Error<ServiceEffects<Service>>,
    Requirements
  >;
  // Object.entries erases member types; retain the service's result/error unions.
  const members = Object.entries(implementation) as Array<
    [string, MemberEffect | ((...args: never[]) => MemberEffect)]
  >;
  const entries = members.map(([key, value]) => {
    if (typeof value !== "function")
      return [key, Effect.provideContext(value, context)];
    return [
      key,
      (...args: never[]) =>
        Effect.provideContext(value.apply(implementation, args), context),
    ];
  });
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
