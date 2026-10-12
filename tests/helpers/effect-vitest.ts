import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import {
  makeWctServicesLayer,
  WctServicesLayer,
} from "../../src/effect/services";
import type { ServiceOverrides } from "./services";

export type { ServiceOverrides };

export const WctTestLayer = WctServicesLayer.pipe(
  Layer.provideMerge(BunServices.layer),
);

export function wctTestLayer(overrides: ServiceOverrides = {}) {
  return makeWctServicesLayer(overrides).pipe(
    Layer.provideMerge(BunServices.layer),
  );
}
