import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import {
  makeWctServicesLayer,
  WctServicesLayer,
} from "../../src/effect/services";
import type { ServiceOverrides } from "./services";

export type { ServiceOverrides };

/** Supplies Bun dependencies when constructing live services for `it.layer`. */
export const WctTestLayer = WctServicesLayer.pipe(
  Layer.provideMerge(BunServices.layer),
);

/** Keeps Bun dependencies available for services not replaced by overrides. */
export function wctTestLayer(overrides: ServiceOverrides = {}) {
  return makeWctServicesLayer(overrides).pipe(
    Layer.provideMerge(BunServices.layer),
  );
}
