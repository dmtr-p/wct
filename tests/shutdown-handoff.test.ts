import { EventEmitter } from "node:events";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";
import { waitForShutdownStart } from "../src/effect/shutdown-worker";

function handoff() {
  const events = new EventEmitter();
  const ready = Deferred.makeUnsafe<void>();
  const wait = waitForShutdownStart(events, () => {
    Deferred.doneUnsafe(ready, Effect.void);
  });
  return { events, ready, wait };
}

function expectNoListeners(events: EventEmitter) {
  expect(events.listenerCount("message")).toBe(0);
  expect(events.listenerCount("disconnect")).toBe(0);
}

describe("shutdown handoff", () => {
  it.effect("waits for Start and removes listeners after success", () =>
    Effect.gen(function* () {
      const { events, ready, wait } = handoff();
      const fiber = yield* Effect.forkChild(wait);
      yield* Deferred.await(ready);
      events.emit("message", { _tag: "Other" });
      expect(events.listenerCount("message")).toBe(1);
      events.emit("message", { _tag: "Start" });
      yield* Fiber.join(fiber);
      expectNoListeners(events);
    }),
  );

  it.effect("preserves the disconnect failure and removes listeners", () =>
    Effect.gen(function* () {
      const { events, ready, wait } = handoff();
      const fiber = yield* Effect.forkChild(Effect.flip(wait));
      yield* Deferred.await(ready);
      events.emit("disconnect");
      const error = yield* Fiber.join(fiber);
      expect(error.message).toBe("Shutdown handoff failed");
      expect(error.cause).toEqual(
        new Error("Shutdown caller exited before handoff"),
      );
      expectNoListeners(events);
    }),
  );

  it.effect("times out after 30 seconds and removes listeners", () =>
    Effect.gen(function* () {
      const { events, ready, wait } = handoff();
      const fiber = yield* Effect.forkChild(Effect.flip(wait));
      yield* Deferred.await(ready);
      yield* TestClock.adjust("29 seconds");
      expect(events.listenerCount("message")).toBe(1);
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(fiber);
      expect(error.message).toBe("Shutdown handoff failed");
      expect(error.cause).toEqual(new Error("Shutdown handoff timed out"));
      expectNoListeners(events);
    }),
  );

  it.effect("removes listeners when interrupted", () =>
    Effect.gen(function* () {
      const { events, ready, wait } = handoff();
      const fiber = yield* Effect.forkChild(wait);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      expectNoListeners(events);
    }),
  );
});
