import { Effect } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import { tuiCommand } from "../src/commands/tui";
import { runBunPromise } from "../src/effect/runtime";
import { WctCommandError } from "../src/errors";
import { withTestServices } from "./helpers/services";

afterEach(() => {
  vi.doUnmock("../src/tui/App");
  vi.resetModules();
});

describe("tui command failures", () => {
  test("maps lazy import failures to command errors", async () => {
    const failure = new Error("TUI module unavailable");
    vi.doMock("../src/tui/App", () => {
      throw failure;
    });
    const error = await runBunPromise(
      Effect.flip(withTestServices(tuiCommand())),
    );
    expect(error).toBeInstanceOf(WctCommandError);
    expect(error.code).toBe("unexpected_error");
    expect(error.cause).toBeInstanceOf(Error);
  });

  test("maps startup rejections to command errors", async () => {
    const failure = new Error("Terminal unavailable");
    vi.doMock("../src/tui/App", () => ({
      startTui: vi.fn().mockRejectedValue(failure),
    }));
    const error = await runBunPromise(
      Effect.flip(withTestServices(tuiCommand())),
    );
    expect(error).toBeInstanceOf(WctCommandError);
    expect(error.code).toBe("unexpected_error");
    expect(error.message).toBe(failure.message);
    expect(error.cause).toBe(failure);
  });

  test("awaits successful startup", async () => {
    const startTui = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../src/tui/App", () => ({ startTui }));
    await runBunPromise(withTestServices(tuiCommand()));
    expect(startTui).toHaveBeenCalledOnce();
  });
});
