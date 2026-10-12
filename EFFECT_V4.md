# Effect v4 Reference for Agents

This project uses Effect v4. Use the APIs and repository patterns below for
application code, services, schemas, CLI commands, and tests.

## Packages and imports

Keep `effect`, `@effect/platform-bun`, and `@effect/vitest` on matching exact
versions in `package.json`, without `^` or `~`. Resolved transitive Effect runtime
packages in `bun.lock`, including `@effect/platform-node-shared`, must match too.
Update the Effect runtime packages together. `package.json` is the source of
truth for dependency versions. The `@effect/tsgo` development tool has its own
version and must support the pinned `typescript` version.

Lifecycle scripts are disabled in `bunfig.toml`. Run `bun run prepare` after
`bun install` to patch TypeScript with Effect tsgo; worktree setup and CI run
this step explicitly.
The stop hook and CI use `bun run typecheck`, which reports TypeScript errors
and Effect diagnostics together. Effect errors fail the check; warnings are
advisory, and suggestions are shown only in the editor.
Unstable APIs from `effect`, `@effect/platform-bun`, and `@effect/vitest` are
allowed by the language service configuration.

- Import core APIs, including `Context`, `Effect`, `FileSystem`, `Layer`, and
  `Schema`, from `effect`.
- Import CLI APIs directly from `effect/cli`.
- Import `ChildProcess` from `effect/process`.
- Import Bun runtime services through `src/effect/runtime.ts`.
- Use the exported `JsonFlag` service from `src/cli/json-flag.ts` when reading
  or providing the JSON setting. `GlobalFlag.Setting` generates runtime service
  keys with unique suffixes; do not reconstruct those keys from strings.

## CLI and terminal output

- Configure built-in actions through `CliConfig.layer` in `src/index.ts`.
- Use `CompletionsFlag` from `src/cli/completions-flag.ts` instead of the default
  `GlobalFlag.Completions`. The repository supports only `bash`, `zsh`, `fish`,
  and `sh`; `sh` maps to the built-in Bash generator. Both `powershell` and
  `pwsh` must be rejected and omitted from help and completion choices.
- Keep the custom Bash, Zsh, and Fish generators in `src/cli/completions.ts`
  for repository-specific branch, worktree, and profile suggestions.
- CLI APIs are marked `@stability unstable`; review their behavior and help
  output when upgrading Effect, even when the core package is stable.
- The TUI uses `src/tui/utils/display-width.ts` for whole-string and
  per-grapheme width calculations. This approximation can differ from Ink
  and `CliOutput.displayWidth`, especially for complex Unicode clusters.
  Keep wrapping and truncation measurements consistent with each other.
- CLI prompts respect `NO_COLOR` and acquire terminal input only when needed.
  Keep confirmations routed through `src/utils/prompt.ts` and `Prompt.Confirm`.
  The shared helper returns its safe default (`false`) without terminal access
  in JSON mode. Use `close --json --yes` to explicitly authorize closing;
  without `--yes`, close emits a structured aborted result.
- The `Stdio` service exposes `stderrIsTerminal` as an Effect, allowing terminal
  detection to be overridden in service implementations. Bun's platform layer
  supplies runtime detection; the default implementation returns false.
  `src/utils/logger.ts` uses `stdoutIsTerminal` for normal output and
  `stderrIsTerminal` for errors. A nonempty `NO_COLOR` disables styling on both
  streams. JSON mode always disables logger styling, regardless of `NO_COLOR`
  or terminal detection; JSON envelopes bypass the logger entirely.
  For table cells and hints, yield `logger.stdoutStyles` inside the
  Effect and use its `bold` and `green` formatters.

## Services and layers

Define service keys with `Context.Service`. The service identifier string is
its runtime identity; use a distinct `wct/<ServiceName>` key for each service.

```ts
import { Context, Effect, Layer } from "effect";

interface Database {
  readonly query: (sql: string) => Effect.Effect<string>;
}

const Database = Context.Service<Database>("wct/Database");

const liveDatabase: Database = {
  query: (sql) => Effect.succeed(sql),
};

const databaseLayer = Layer.succeed(Database, liveDatabase);

const program = Effect.gen(function* () {
  const database = yield* Database;
  return yield* database.query("SELECT 1");
});

const provided = Effect.provide(program, databaseLayer);
```

Class-based keys use the two-stage constructor:

```ts
class Database extends Context.Service<
  Database,
  { readonly query: (sql: string) => Effect.Effect<string> }
>()("wct/Database") {}
```

Use `Context.Reference` for a service with a default value:

```ts
const LogLevel = Context.Reference<"info" | "warn" | "error">("wct/LogLevel", {
  defaultValue: () => "info",
});
```

- Use `yield* Service` or `Service.use(...)` to access a service.
- Provide implementations with `Layer.succeed` or `Layer.effect`; compose
  dependencies with `Layer.provide` and `Layer.provideMerge`.
- Prefer `static readonly layer` for service classes that define their own layer.
- Keep the `live<ServiceName>Service` naming convention for existing concrete
  service implementations, such as `liveGitHubService` and `liveWorktreeService`.
  GitHub, tmux, worktree, and workspace public methods have no service
  requirements. Their `make<ServiceName>Service` factories capture dependencies
  during layer construction. `makeWctServicesLayer` applies overrides before
  constructing the workspace service. Supply `BunServices.layer` to these
  layers with `Layer.provide` or `Layer.provideMerge`.
  Capture only service dependencies so caller settings such as `JsonFlag` and
  `Console` remain effective when a method runs.
- Represent parameterless operations as Effect values. Read changing state
  inside `Effect.sync`, `Effect.suspend`, or `Effect.gen` so each execution
  observes current values.
- Use `Effect.provideService` for individual overrides.
- Use `Context.make` and `Context.get` when manipulating a context directly.
- Use `Layer.fresh(layer)` when a layer must be built independently.

## Runtime and process boundaries

Keep `src/index.ts` thin: handle completion/version shortcuts, build the root
CLI Effect, provide application and Bun services, and call `BunRuntime.runMain`.

- `provideBunServices` supplies `BunServices.layer`.
- `provideWctServices` supplies the live application services and default JSON
  flag value.
- `runBunPromise` runs Effects at imperative Bun boundaries.
- The TUI uses the process-scoped `ManagedRuntime` in `src/tui/runtime.ts`.
  Command exit tears down the process; there is no explicit runtime disposal
  path.
- Use the process helpers in `src/services/process.ts` for command execution.
  They collect stdout, stderr, and exit status inside an Effect scope.
- Use `Bun.spawn` with inherited stdio for interactive process handoff.
- Self-session shutdown uses a detached `Bun.spawn` worker with IPC; it saves
  its outcome outside the target checkout before exiting.
- Use `Bun.YAML.parse`, `Bun.Glob`, and `Bun.which` for their respective runtime
  primitives.

`Effect.Effect<A, E, R>` records the result type, typed error, and required
services. Preserve these types when defining command and service interfaces.

## Errors and cleanup

Use `WctCommandError` and the constructors in `src/errors.ts` for command errors.
Tagged application errors use `Data.TaggedError`.
Yield tagged errors directly inside `Effect.gen`, for example
`return yield* commandError("not_git_repo", "Not a git repository")`.
Use `Effect.fail` when returning a failed Effect outside a generator.

| Purpose | API |
| --- | --- |
| Handle typed failures | `Effect.catch` |
| Handle failures by tag | `Effect.catchTag`, `Effect.catchTags` |
| Handle a full cause | `Effect.catchCause` |
| Handle defects | `Effect.catchDefect` |
| Handle selected errors | `Effect.catchIf`, `Effect.catchFilter` |
| Recover with a fallback value | `Effect.orElseSucceed` |
| Discard results and typed failures | `Effect.ignore` |
| Discard results and full causes | `Effect.ignoreCause` |
| Convert an error | `Effect.mapError` |
| Observe both outcomes | `Effect.match`, `Effect.matchCause` |

`Effect.partition` returns `[successes, failures]`. Read the second tuple
element when aggregating failures.

`Cause` contains a flat `reasons` array with `Fail`, `Die`, and `Interrupt`
reasons. Inspect it with `Cause.hasFails`, `Cause.hasDies`,
`Cause.hasInterrupts`, `Cause.findErrorOption`, and `Cause.findDefect`.

Use `Effect.scoped` and `Effect.acquireRelease` for resource ownership.
`Scope.close` and `Scope.closeUnsafe` require a `Scope.Closeable` created by
`Scope.make` or `Scope.fork`. Use `Scope.provide(scope)(effect)` to run an Effect
within an existing scope.

## Fibers and yieldable values

- `Effect.forkChild` creates a child fiber.
- `Effect.forkScoped` and `Effect.forkIn` bind fibers to a scope.
- `Effect.forkDetach` detaches a fiber from its parent.
- Fork options include `startImmediately` and `uninterruptible`.
- Read references with `Ref.get`, wait for deferred values with `Deferred.await`,
  and join fibers with `Fiber.join`.
- Service keys support `yield*` in `Effect.gen`. Convert optional and result
  values with `Effect.fromOption` and `Effect.fromResult` before using them in
  Effect programs.
- Use `Option.gen` and `Result.gen` for generators over those data types.
- Use `Result.succeed` and `Result.fail` for result values.

## Schemas

Define configuration schemas in `src/config/schema.ts` and use the validation
helpers in `src/config/validator.ts`.

```ts
import { Schema } from "effect";

const ConfigSchema = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty()),
  layout: Schema.Literals(["horizontal", "vertical"]),
  enabled: Schema.optional(Schema.Boolean),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

type Config = typeof ConfigSchema.Type;
const decodeConfig = Schema.decodeUnknownSync(ConfigSchema);
```

- Pass arrays to `Schema.Literals`, `Schema.Union`, and `Schema.Tuple`.
  Use `Schema.Literal` for a single literal.
- Use `Schema.optional` or `Schema.optionalKey` for optional fields.
- Apply checks with `.check(...)` and refinements with `Schema.refine`.
- Numeric checks include `isGreaterThan`, `isLessThan`, `isInt`, and `isBetween`.
- String checks include `isPattern`, `isStartingWith`, `isEndingWith`, and
  `isIncluding`.
- Length and cardinality ranges use `isBetweenLength`, `isBetweenCodePoints`,
  `isBetweenSize`, and `isBetweenProperties`.
- Use `isMinCodePoints` and `isMaxCodePoints` when counting Unicode code points.
- Decode with `Schema.decodeUnknownEffect`, `Schema.decodeUnknownSync`, or
  `Schema.decodeUnknownExit`, choosing the boundary appropriate to the caller.
- Use `Schema.fromJsonString(schema)` for JSON string codecs.
- Use `Schema.toStandardSchemaV1` for the Standard Schema validation interface.
- Use `Schema.toType`, `Schema.toEncoded`, `Schema.toEquivalence`, and
  `Schema.toFormatter` for derived representations; use `Arbitrary.schema` for
  schema-based value generation.
- Use `Schema.decodeTo` with `SchemaTransformation.transform` for transformations.
- Modify struct fields with `.mapFields(...)` and `Struct.pick`, `Struct.omit`,
  `Struct.assign`, or `Struct.map`.

## Testing with @effect/vitest

Prefer `it.effect` with `it.layer` for new Effect-aware tests:

```ts
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  liveWorktreeService,
  WorktreeService,
} from "../src/services/worktree-service";
import { wctTestLayer } from "./helpers/effect-vitest";

const TestLayer = wctTestLayer({
  worktree: {
    ...liveWorktreeService,
    getCurrentBranch: () => Effect.succeed("main"),
  },
});

describe("getCurrentBranch", () => {
  it.layer(TestLayer)("with an overridden service", (it) => {
    it.effect("returns the provided branch", () =>
      Effect.gen(function* () {
        const wt = yield* WorktreeService;
        const branch = yield* wt.getCurrentBranch();
        expect(branch).toBe("main");
      }),
    );
  });
});
```

Adjust relative imports for the test's location. For service overrides, use
`wctTestLayer({ tmux: fakeTmux })`; its options match `withTestServices`.

Keep `runBunPromise` with `withTestServices` when an existing test mixes
imperative mocks with Effect execution or mutates state between separate Effect
runs. Both patterns are supported; choose the one appropriate to the test.

For Vitest fixtures, create Effect test methods with
`makeMethods(test.extend(...))` using the top-level `test` export.
`it.effect.each` receives the test context as its second argument.
`Arbitrary.configureGlobal` can configure shared property-test defaults before
concurrent tests start.

Do not run tests or lint manually; the harness hooks handle those checks as
specified in `AGENTS.md`.
