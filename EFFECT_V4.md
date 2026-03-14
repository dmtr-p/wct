# Effect v4 Reference for Agents

> This project uses Effect v4. If your training data covers Effect v3, read this
> document carefully — it describes the correct v4 APIs and patterns you must use.

## Package Changes

### Consolidation

Many packages merged into `effect`:

- `@effect/platform` → `effect` (FileSystem, Path, etc. now under `effect/unstable/*`)
- `@effect/rpc`, `@effect/cluster` → `effect`
- Platform-specific packages remain separate: `@effect/platform-bun`, `@effect/platform-node`

### Versioning

All packages share a single version number. Use matching versions everywhere.

### Unstable Modules

New imports under `effect/unstable/*` (e.g., `effect/unstable/cli/Command`, `effect/unstable/process`). These may break in minor releases.

---

## Services: `Context.Tag` → `ServiceMap.Service`

This is the most pervasive change. Every service definition must be updated.

### Simple services

```ts
// ❌ v3
import { Context } from "effect";
const Database = Context.GenericTag<Database>("Database");

// ✅ v4
import { ServiceMap } from "effect";
const Database = ServiceMap.Service<Database>("Database");
```

### Class-based services

```ts
// ❌ v3
class Database extends Context.Tag("Database")<
  Database,
  {
    readonly query: (sql: string) => string;
  }
>() {}

// ✅ v4 — note: type params first, then id string in second call
class Database extends ServiceMap.Service<
  Database,
  {
    readonly query: (sql: string) => string;
  }
>()("Database") {}
```

### Services with constructors (`Effect.Service` → `ServiceMap.Service` with `make`)

```ts
// ❌ v3
class Logger extends Effect.Service<Logger>()("Logger", {
  effect: Effect.gen(function*() { ... }),
  dependencies: [Config.Default]
}) {}
// Logger.Default auto-generated

// ✅ v4 — no auto-generated layer, build it yourself
class Logger extends ServiceMap.Service<Logger>()("Logger", {
  make: Effect.gen(function*() { ... })
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Config.layer)
  )
}
```

**Key differences:**

- `effect:` → `make:`
- `dependencies:` removed — use `Layer.provide()` explicitly
- Generic upstream guidance often uses `layer` instead of `Default` or `Live`
- Repo convention here is more specific:
  - for service classes such as `Logger extends ServiceMap.Service(...)`, `static readonly layer` is the preferred name
  - for concrete service values provided from plain objects, keep the existing `live<ServiceName>Service` style, for example `liveGitHubService`, `liveTmuxService`, and `liveWorktreeService`
- Do not rename the current `live*Service` values just to match upstream examples; the important part is consistent Effect provisioning, not forcing every concrete implementation to be named `layer`

### Accessors removed

```ts
// ❌ v3 — static proxy access
const program = Notifications.notify("hello");

// ✅ v4 — use `use` or `yield*`
const program = Notifications.use((n) => n.notify("hello"));
// or preferably:
const program = Effect.gen(function* () {
  const n = yield* Notifications;
  yield* n.notify("hello");
});
```

### References (services with defaults)

```ts
// ❌ v3
class LogLevel extends Context.Reference<LogLevel>()("LogLevel", {
  defaultValue: () => "info",
}) {}

// ✅ v4
const LogLevel = ServiceMap.Reference<"info" | "warn" | "error">("LogLevel", {
  defaultValue: () => "info",
});
```

### Quick reference table

| v3                                    | v4                                         |
| ------------------------------------- | ------------------------------------------ |
| `Context.GenericTag<T>(id)`           | `ServiceMap.Service<T>(id)`                |
| `Context.Tag(id)<Self, Shape>()`      | `ServiceMap.Service<Self, Shape>()(id)`    |
| `Effect.Tag(id)<Self, Shape>()`       | `ServiceMap.Service<Self, Shape>()(id)`    |
| `Effect.Service<Self>()(id, opts)`    | `ServiceMap.Service<Self>()(id, { make })` |
| `Context.Reference<Self>()(id, opts)` | `ServiceMap.Reference<T>(id, opts)`        |
| `Context.make(tag, impl)`             | `ServiceMap.make(tag, impl)`               |
| `Context.get(ctx, tag)`               | `ServiceMap.get(map, tag)`                 |
| `Context`                             | `ServiceMap`                               |

---

## Error Handling: `catch*` Renamings

| v3                       | v4                               |
| ------------------------ | -------------------------------- |
| `Effect.catchAll`        | `Effect.catch`                   |
| `Effect.catchAllCause`   | `Effect.catchCause`              |
| `Effect.catchAllDefect`  | `Effect.catchDefect`             |
| `Effect.catchTag`        | `Effect.catchTag` _(unchanged)_  |
| `Effect.catchTags`       | `Effect.catchTags` _(unchanged)_ |
| `Effect.catchIf`         | `Effect.catchIf` _(unchanged)_   |
| `Effect.catchSome`       | `Effect.catchFilter`             |
| `Effect.catchSomeCause`  | `Effect.catchCauseFilter`        |
| `Effect.catchSomeDefect` | _Removed_                        |

---

## Forking

| v3                            | v4                                |
| ----------------------------- | --------------------------------- |
| `Effect.fork`                 | `Effect.forkChild`                |
| `Effect.forkDaemon`           | `Effect.forkDetach`               |
| `Effect.forkScoped`           | `Effect.forkScoped` _(unchanged)_ |
| `Effect.forkIn`               | `Effect.forkIn` _(unchanged)_     |
| `Effect.forkAll`              | _Removed_                         |
| `Effect.forkWithErrorHandler` | _Removed_                         |

Fork functions now accept an options object:

```ts
Effect.forkChild(myEffect, { startImmediately: true, uninterruptible: true });
```

---

## Yieldable (replaces Effect subtyping)

In v3, types like `Ref`, `Deferred`, `Fiber`, `Option`, `Either`, `Context.Tag` were subtypes of `Effect`.
In v4, they are **not** — some implement `Yieldable` (works with `yield*`), others need explicit conversion.

### Still works with `yield*`:

- `Option` — yields value or fails with `NoSuchElementError`
- `Result` (renamed from `Either`) — yields success or fails
- `ServiceMap.Service` — yields the service

### No longer Effect subtypes — use explicit functions:

```ts
// ❌ v3 — Ref is an Effect
const value = yield * ref;

// ✅ v4
const value = yield * Ref.get(ref);
```

```ts
// ❌ v3 — Deferred is an Effect
const value = yield * deferred;

// ✅ v4
const value = yield * Deferred.await(deferred);
```

```ts
// ❌ v3 — Fiber is an Effect
const result = yield * fiber;

// ✅ v4
const result = yield * Fiber.join(fiber);
```

### Using Yieldable types with combinators

```ts
// ❌ v3 — Option assignable to Effect
Effect.map(Option.some(42), (n) => n + 1);

// ✅ v4 — must convert explicitly
Effect.map(Option.some(42).asEffect(), (n) => n + 1);
// or use a generator (preferred)
Effect.gen(function* () {
  const n = yield* Option.some(42);
  return n + 1;
});
```

---

## Cause: Flattened Structure

`Cause` is now a flat array of `Reason` values instead of a recursive tree.

```ts
// v4 Cause structure
interface Cause<E> {
  readonly reasons: ReadonlyArray<Reason<E>>;
}
type Reason<E> = Fail<E> | Die | Interrupt;
```

**Removed variants:** `Empty`, `Sequential`, `Parallel`

| v3                            | v4                             |
| ----------------------------- | ------------------------------ |
| `Cause.isFailure(cause)`      | `Cause.hasFails(cause)`        |
| `Cause.isDie(cause)`          | `Cause.hasDies(cause)`         |
| `Cause.isInterrupted(cause)`  | `Cause.hasInterrupts(cause)`   |
| `Cause.sequential(l, r)`      | `Cause.combine(l, r)`          |
| `Cause.parallel(l, r)`        | `Cause.combine(l, r)`          |
| `Cause.failureOption(cause)`  | `Cause.findErrorOption(cause)` |
| `Cause.failureOrCause(cause)` | `Cause.findError(cause)`       |
| `Cause.dieOption(cause)`      | `Cause.findDefect(cause)`      |

### Exception → Error renames

| v3                               | v4                           |
| -------------------------------- | ---------------------------- |
| `Cause.NoSuchElementException`   | `Cause.NoSuchElementError`   |
| `Cause.TimeoutException`         | `Cause.TimeoutError`         |
| `Cause.IllegalArgumentException` | `Cause.IllegalArgumentError` |
| `Cause.UnknownException`         | `Cause.UnknownError`         |

---

## FiberRef → `ServiceMap.Reference`

`FiberRef` is removed. Use `ServiceMap.Reference` instead.

| v3                            | v4                              |
| ----------------------------- | ------------------------------- |
| `FiberRef.currentLogLevel`    | `References.CurrentLogLevel`    |
| `FiberRef.currentConcurrency` | `References.CurrentConcurrency` |

```ts
// ❌ v3
const level = yield * FiberRef.get(FiberRef.currentLogLevel);

// ✅ v4
const level = yield * References.CurrentLogLevel;
```

```ts
// ❌ v3
Effect.locally(myEffect, FiberRef.currentLogLevel, LogLevel.Debug);

// ✅ v4
Effect.provideService(myEffect, References.CurrentLogLevel, "Debug");
```

---

## Runtime: `Runtime<R>` Removed

```ts
// ❌ v3
const runtime = yield * Effect.runtime<MyService>();
Runtime.runFork(runtime)(program);

// ✅ v4
const services = yield * Effect.services<MyService>();
Effect.runForkWith(services)(program);
```

---

## Scope

| v3                            | v4                             |
| ----------------------------- | ------------------------------ |
| `Scope.extend(effect, scope)` | `Scope.provide(scope)(effect)` |

---

## Equality

- `Equal.equals` now uses **structural equality** by default (v3 used reference equality)
- `NaN === NaN` is now `true`
- `Equal.equivalence` → `Equal.asEquivalence`
- Use `Equal.byReference(obj)` to opt out of structural equality

---

## Layer Memoization

In v4, layers are automatically memoized across `Effect.provide` calls (v3 only memoized within a single `provide`).

- Use `Layer.fresh(layer)` to force rebuilding
- Use `Effect.provide(layer, { local: true })` for isolated memo map

---

## Fiber Keep-Alive

The runtime now automatically keeps the process alive while fibers are suspended. You no longer need `@effect/platform-node`'s `runMain` just for keep-alive (though `runMain` is still recommended for signal handling and exit codes).

---

## Schema Changes

### Simple renames

| v3                           | v4                              |
| ---------------------------- | ------------------------------- |
| `Schema.annotations(ann)`    | `Schema.annotate(ann)`          |
| `Schema.compose(schemaB)`    | `Schema.decodeTo(schemaB)`      |
| `Schema.parseJson()`         | `Schema.UnknownFromJsonString`  |
| `Schema.parseJson(schema)`   | `Schema.fromJsonString(schema)` |
| `Schema.nonEmptyString`      | `Schema.isNonEmpty`             |
| `Schema.BigIntFromSelf`      | `Schema.BigInt`                 |
| `Schema.TaggedError`         | `Schema.TaggedErrorClass`       |
| `Schema.decodeUnknown`       | `Schema.decodeUnknownEffect`    |
| `Schema.decode`              | `Schema.decodeEffect`           |
| `Schema.decodeUnknownEither` | `Schema.decodeUnknownExit`      |
| `Schema.decodeEither`        | `Schema.decodeExit`             |
| `Schema.encodeUnknown`       | `Schema.encodeUnknownEffect`    |
| `Schema.encode`              | `Schema.encodeEffect`           |
| `Schema.encodeUnknownEither` | `Schema.encodeUnknownExit`      |
| `Schema.encodeEither`        | `Schema.encodeExit`             |
| `Schema.encodedSchema`       | `Schema.toEncoded`              |
| `Schema.typeSchema`          | `Schema.toType`                 |
| `Schema.asSchema`            | `Schema.revealCodec`            |

### `*FromSelf` renames (drop the suffix)

`DateFromSelf` → `Date`, `DurationFromSelf` → `Duration`, `OptionFromSelf` → `Option`, `CauseFromSelf` → `Cause`, `ExitFromSelf` → `Exit`, etc.

### Variadic → Array arguments

```ts
// ❌ v3
Schema.Literal("a", "b");
Schema.Union(A, B);
Schema.Tuple(A, B);

// ✅ v4
Schema.Literals(["a", "b"]);
Schema.Union([A, B]);
Schema.Tuple([A, B]);
```

Note: single literal stays as `Schema.Literal("a")`, multiple use `Schema.Literals(["a", "b"])`.

### Filter renames (add `is` prefix)

`greaterThan` → `isGreaterThan`, `lessThan` → `isLessThan`, `int` → `isInt`, `minLength` → `isMinLength`, `maxLength` → `isMaxLength`, `between` → `isBetween`, `pattern` → `isPattern`, etc.

Filters now use `check()`:

```ts
// ❌ v3
Schema.String.pipe(Schema.pattern(/^[a-z]+$/));

// ✅ v4
Schema.String.check(Schema.isPattern(/^[a-z]+$/));
```

### Record

```ts
// ❌ v3
Schema.Record({ key: Schema.String, value: Schema.Number });

// ✅ v4
Schema.Record(Schema.String, Schema.Number);
```

### filter → check/refine

```ts
// ❌ v3 — predicate filter
Schema.String.pipe(Schema.filter((s) => s.length > 0));

// ✅ v4
Schema.String.check(Schema.makeFilter((s) => s.length > 0));

// ❌ v3 — refinement filter
Schema.Option(Schema.String).pipe(Schema.filter(Option.isSome));

// ✅ v4
Schema.Option(Schema.String).pipe(Schema.refine(Option.isSome));
```

### transform

```ts
// ❌ v3
Schema.transform(SchemaA, SchemaB, { decode, encode });

// ✅ v4
import { SchemaTransformation } from "effect";
SchemaA.pipe(
  Schema.decodeTo(SchemaB, SchemaTransformation.transform({ decode, encode })),
);
```

### pick / omit

```ts
// ❌ v3
myStruct.pipe(Schema.pick("a"));
myStruct.pipe(Schema.omit("b"));

// ✅ v4
import { Struct } from "effect";
myStruct.mapFields(Struct.pick(["a"]));
myStruct.mapFields(Struct.omit(["b"]));
```

### partial

```ts
// ❌ v3
myStruct.pipe(Schema.partial);
myStruct.pipe(Schema.partialWith({ exact: true }));

// ✅ v4
import { Struct } from "effect";
myStruct.mapFields(Struct.map(Schema.optional));
myStruct.mapFields(Struct.map(Schema.optionalKey));
```

### extend (Struct + Struct)

```ts
// ❌ v3
structA.pipe(Schema.extend(Schema.Struct({ c: Schema.Number })));

// ✅ v4
import { Struct } from "effect";
structA.mapFields(Struct.assign({ c: Schema.Number }));
// or
structA.pipe(Schema.fieldsAssign({ c: Schema.Number }));
```

### Removed Schema APIs

- `Schema.validate*` — use `Schema.decode*` + `Schema.toType` instead
- `Schema.keyof` — removed
- `Schema.Data` — removed (structural equality is default in v4)
- `Schema.ArrayEnsure`, `Schema.NonEmptyArrayEnsure` — removed
- `Schema.withDefaults`, `Schema.fromKey` — removed
- `positive`, `negative`, `nonNegative`, `nonPositive` filters — removed

### Utility renames

| v3                   | v4                     |
| -------------------- | ---------------------- |
| `Schema.equivalence` | `Schema.toEquivalence` |
| `Schema.arbitrary`   | `Schema.toArbitrary`   |
| `Schema.pretty`      | `Schema.toFormatter`   |

---

## Either → Result

`Either` has been renamed to `Result` throughout v4:

```ts
// ❌ v3
import { Either } from "effect";
Either.right(42);
Either.left("error");

// ✅ v4
import { Result } from "effect";
Result.ok(42);
Result.err("error");
```

---

## Summary of Import Changes

| v3 import          | v4 import                                               |
| ------------------ | ------------------------------------------------------- |
| `Context`          | `ServiceMap`                                            |
| `FiberRef`         | `References` / `ServiceMap.Reference`                   |
| `Runtime`          | Mostly removed; use `Effect.runFork`, `Effect.services` |
| `Either`           | `Result`                                                |
| `ParseResult`      | `SchemaIssue`                                           |
| `@effect/platform` | `effect` (many modules moved to `effect/unstable/*`)    |
