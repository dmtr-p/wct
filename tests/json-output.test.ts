import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";
import { jsonError, jsonSuccess } from "../src/utils/json-output";

describe("jsonSuccess", () => {
  test("writes JSON envelope with ok:true to stdout", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await Effect.runPromise(jsonSuccess({ branch: "main", changes: 3 }));
      expect(spy).toHaveBeenCalledOnce();
      const output = JSON.parse(spy.mock.calls[0]?.[0] as string);
      expect(output).toEqual({
        ok: true,
        data: { branch: "main", changes: 3 },
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("outputs valid JSON for arrays", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await Effect.runPromise(jsonSuccess([1, 2, 3]));
      const output = JSON.parse(spy.mock.calls[0]?.[0] as string);
      expect(output).toEqual({ ok: true, data: [1, 2, 3] });
    } finally {
      spy.mockRestore();
    }
  });

  test("normalizes undefined data to null", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await Effect.runPromise(jsonSuccess(undefined));
      const output = JSON.parse(spy.mock.calls[0]?.[0] as string);
      expect(output).toEqual({ ok: true, data: null });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("jsonError", () => {
  test("writes JSON envelope with ok:false to stderr", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await Effect.runPromise(jsonError("worktree_error", "Not found"));
      expect(spy).toHaveBeenCalledOnce();
      const output = JSON.parse(spy.mock.calls[0]?.[0] as string);
      expect(output).toEqual({
        ok: false,
        error: { code: "worktree_error", message: "Not found" },
      });
    } finally {
      spy.mockRestore();
    }
  });
});
