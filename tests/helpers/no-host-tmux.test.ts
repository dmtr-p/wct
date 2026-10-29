import { describe, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { expect } from "vitest";
import { provideBunServices } from "../../src/effect/runtime";
import {
  execProcess,
  runProcess,
  spawnInteractive,
} from "../../src/services/process";

function expectHostTmuxBlocked<A, E, R>(attempt: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(attempt);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain(
        "Host tmux is disabled in tests",
      );
    }
  });
}

describe("host tmux isolation", () => {
  it.effect("blocks tmux through every application process helper", () =>
    provideBunServices(
      Effect.gen(function* () {
        yield* expectHostTmuxBlocked(execProcess("tmux", ["-V"]));
        yield* expectHostTmuxBlocked(runProcess("tmux", ["-V"]));
        yield* expectHostTmuxBlocked(spawnInteractive("tmux", ["-V"]));
      }),
    ),
  );
});
