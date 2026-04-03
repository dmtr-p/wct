import { Console, Effect } from "effect";
import { JsonFlag } from "../cli/json-flag";

export function jsonSuccess<T>(data: T) {
  const normalizedData = data === undefined ? null : data;
  return Console.log(
    JSON.stringify({ ok: true, data: normalizedData }, null, 2),
  );
}

export function jsonError(code: string, message: string) {
  return Console.error(
    JSON.stringify({ ok: false, error: { code, message } }, null, 2),
  );
}

export const isJsonMode = Effect.gen(function* () {
  return yield* JsonFlag;
});
