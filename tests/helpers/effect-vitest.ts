import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { makeWctServicesLayer } from "../../src/effect/services";
import { noopTmuxService, type ServiceOverrides } from "./services";

export type { ServiceOverrides };

export function wctTestLayer(overrides: ServiceOverrides = {}) {
  return makeWctServicesLayer({
    ...overrides,
    tmux: overrides.tmux ?? noopTmuxService,
  }).pipe(Layer.provideMerge(BunServices.layer));
}

export const WctTestLayer = wctTestLayer();
