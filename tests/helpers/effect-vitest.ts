import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import {
  makeWctServicesLayer,
  WctServicesLayer,
} from "../../src/effect/services";
import type { ServiceOverrides } from "./services";

export type { ServiceOverrides };

/**
 * Layer providing every wct live service, JsonFlag=false, and BunServices.
 * BunServices is required because live services (worktree, tmux, github)
 * call execProcess / ChildProcess, which are provided by the Bun platform.
 * This mirrors the runtime composition of `runBunPromise(withTestServices(...))`.
 *
 * Use with `it.layer(WctTestLayer)((it) => { it.effect(...) })` from
 * @effect/vitest.
 */
export const WctTestLayer = WctServicesLayer.pipe(
  Layer.provideMerge(BunServices.layer),
);

/**
 * Variant of `WctTestLayer` that swaps in per-test overrides matching
 * the same shape as `withTestServices` from `./services.ts`. Use when a
 * single test or describe block needs a fake implementation. Also merges
 * in `BunServices.layer` so live fallthroughs that call execProcess work.
 */
export function wctTestLayer(overrides: ServiceOverrides = {}) {
  return makeWctServicesLayer(overrides).pipe(
    Layer.provideMerge(BunServices.layer),
  );
}
