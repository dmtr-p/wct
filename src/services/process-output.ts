import { Effect, Stream } from "effect";

export function decodeText<E, LimitError = never>(
  stream: Stream.Stream<Uint8Array, E>,
  limit?: { maxBytes: number; onLimit: () => LimitError },
): Effect.Effect<string, E | LimitError> {
  return Effect.suspend(() => {
    let bounded: Stream.Stream<Uint8Array, E | LimitError> = stream;
    if (limit) {
      let bytes = 0;
      bounded = Stream.mapEffect(stream, (chunk) => {
        bytes += chunk.byteLength;
        return bytes > limit.maxBytes
          ? Effect.fail(limit.onLimit())
          : Effect.succeed(chunk);
      });
    }
    return Stream.mkString(Stream.decodeText(bounded));
  });
}
