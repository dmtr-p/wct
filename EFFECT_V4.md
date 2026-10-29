# Effect v4 Reference for Agents

This project uses Effect v4. Use the APIs and repository patterns below for
application code, services, schemas, CLI commands, and tests.

## Packages and imports

Keep `effect`, `@effect/platform-bun`, and `@effect/vitest` on matching exact
versions in `package.json`, without `^` or `~`. Resolved transitive Effect runtime
packages in `bun.lock`, including `@effect/platform-node-shared`, must match too.
Update the Effect runtime packages together. `package.json` is the source of
truth for dependency versions. The `@effect/tsgo` development tool has its own
version and must support the pinned `typescript`, `oxlint`, and
`oxlint-tsgolint` versions. Check its installed `README.md` for the supported
versions before changing any of these tools.

Lifecycle scripts are disabled in `bunfig.toml`. Run `bun run prepare` after
`bun install` to patch TypeScript, Oxlint, and oxlint-tsgolint with Effect tsgo;
worktree setup and CI run this step explicitly.
CI uses `bun run lint` and the stop hooks use `mise run lint:fix` to report
TypeScript errors, lint issues, and Effect diagnostics in one Oxlint run.
Errors and warnings fail the check; suggestions are shown only in the editor.
Oxlint uses the Effect-aware schema and `effecttsgo` plugin in `.oxlintrc.json`
with both `options.typeAware` and `options.typeCheck` enabled. It extends
`@effect/tsgo/oxlint-presets/strict.json`, which reports its Effect rules as
errors, including refactors otherwise offered as editor suggestions. Explicit
Effect rules retain warning-level checks for error/context types, native Error
subclasses, and unsafe Effect type assertions that the preset does not cover.
Additional error-level rules require Effect clock, logging, HTTP, random,
Crypto, Config, and timer APIs inside generators, schema-aware checks for Schema
types, and no redundant nested generators. Effect composition uses `Effect.gen`
or `Effect.fn` rather than `Effect.Do` helpers. TypeScript rules check promise misuse, exhaustive
switches over union types, deprecated APIs, redundant type assertions, and
non-Error throws and promise rejections.
The language service diagnostics in `tsconfig.json` configure editor feedback
independently of Oxlint's strict severities.
Bun's built-in formatter owns formatting and import sorting through the
`[fmt]` and `[fmt.sortImports]` sections in `bunfig.toml`.
The React Compiler rules for refs, state updates in effects, globals, and
immutability are disabled. The Ink TUI uses explicit mutable refs and Effect
polling without React Compiler.
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

Define command names, descriptions, aliases, and parameters in
`src/cli/command-metadata.ts`. Native Effect CLI parameters and the command
modules' `commandDef` completion views share these definitions.
`src/cli/root-command.ts` binds the parameters to handlers. Global option
metadata and supported completion shells belong in `src/cli/global-options.ts`.

- Use `Command.validate` with `CliError.ValidationError` for input-only
  constraints before handlers run. Keep service-level validation for callers
  such as the TUI. Optional empty strings retain the service's truthiness
  semantics; report conflicting PR options before `--existing`/`--base`.
- Application boolean switches use `Flag.withoutNegation`, including `--json`
  and `--no-attach`. Only the declared spellings and aliases are accepted and
  offered by custom completions.

- Configure built-in actions through `CliConfig.layer` in `src/index.ts`.
- Use `CompletionsFlag` from `src/cli/completions-flag.ts` instead of the default
  `GlobalFlag.Completions` to offer only `bash`, `zsh`, and `fish`.
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
- Use `TerminalCapabilities.layer` for CLI color detection through the current
  `ConfigProvider` and `Stdio`. The default reference caches process detection
  on its first read. The logger builds the layer when output runs, substituting
  stderr's terminal detection for stdout's when styling errors.
  It preserves an explicit config provider and otherwise creates an environment
  provider per execution, since the default config reference also caches its
  environment snapshot.
  `TERM=dumb` disables color; nonempty `NO_COLOR` wins over `FORCE_COLOR`.
  Nonempty `FORCE_COLOR` forces styling on redirected streams except for `0`
  and case-insensitive `false`, which retain normal TTY detection.
  The `Stdio` service exposes `stderrIsTerminal` as an Effect, allowing terminal
  detection to be overridden in service implementations. Bun's platform layer
  supplies runtime detection; the default implementation returns false.
  `src/utils/logger.ts` uses `stdoutIsTerminal` for normal output and
  `stderrIsTerminal` for errors. A nonempty `NO_COLOR` disables styling on both
  streams. JSON mode always disables logger styling, regardless of `NO_COLOR`
  or terminal detection; JSON envelopes bypass the logger entirely.
  The CLI output boundary writes formatted strings directly to the streams so
  Bun's console styling cannot add color. Suppressed help emits no blank line
  in JSON mode.
  When a downstream pipe closes, stdout exits successfully and stderr exits
  with failure without printing an EPIPE stack trace. Other stream errors
  remain visible.
  For table cells and hints, yield `logger.stdoutStyles` inside the
  Effect and use its `bold` and `green` formatters.

### Profile completions

The private profile completion helper resolves the Main Repository through the
Worktree service and uses `loadConfig`. Configuration errors produce no
suggestions. Preserve profile names and typed prefixes as data without
evaluating shell text.

Config validation restricts profile names to `[A-Za-z0-9][A-Za-z0-9._-]*`.
All three shells consume newline-separated identifiers. Bash strips surrounding
single or double quotes from the current word before matching; it uses
`COMP_WORDS` so completion also works mid-line after multibyte text.

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
  GitHub, tmux, worktree, workspace, setup, and agent public methods have no
  service requirements. Their `make<ServiceName>Service` factories capture
  dependencies during layer construction. `makeWctServicesLayer` applies
  overrides before constructing the workspace service. Supply `BunServices.layer`
  to these layers with `Layer.provide` or `Layer.provideMerge`.
  Capture only service dependencies so caller settings such as `JsonFlag` and
  `Console` remain effective when a method runs.
  The `leakingRequirements` diagnostic enforces this service boundary.
- Represent parameterless operations as Effect values. Read changing state
  inside `Effect.sync`, `Effect.suspend`, or `Effect.gen` so each execution
  observes current values.
- Use `Effect.provideService` for individual overrides.
- Use `Context.make` and `Context.get` when manipulating a context directly.
- Use `Layer.fresh(layer)` when a layer must be built independently.
  Composed layers share their inner dependencies; wrap the complete composition
  in `Layer.fresh` only when independent instances are required. The CLI, TUI,
  and test service bundles intentionally share platform dependencies within
  each construction.

## Runtime and process boundaries

Keep `src/index.ts` thin: handle completion/version shortcuts, dispatch the CLI,
private profile completion helper, or shutdown worker, provide application and
Bun services, and call `BunRuntime.runMain`.

- `provideBunServices` supplies `BunServices.layer`.
- `provideWctServices` supplies the live application services and default JSON
  flag value.
- `runBunPromise` runs Effects at imperative Bun boundaries.
- Inside an Effect, compose child Effects with `yield*`. For imperative
  callbacks that must execute an Effect, capture the surrounding context and
  use `Effect.runPromiseWith` or `Effect.runSyncWith` to preserve caller services
  and settings. The `runEffectInsideEffect` diagnostic enforces this boundary.
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
- Read runtime settings with `loadRuntimeConfig` from `src/effect/config.ts`.
  It preserves an explicit Config provider and otherwise reads a fresh
  environment snapshot on each execution, preserving empty strings. Subprocess
  inheritance uses `processEnvironment` from `src/services/process.ts` to copy the complete
  environment independently of Config overrides.
- Wrap IPC listeners in `Effect.callback` with interruption cleanup. The
  shutdown worker's handoff uses a 30-second Effect timeout.
- Use `FileSystem.lstat` when selecting regular files without following
  symlinks. Keep filesystem dependencies available during service construction;
  use `FileSystem.makeNoop` for partial test implementations. Stat metadata uses
  `bigint` for 64-bit identifiers and `ByteSize` for sizes.

`Effect.Effect<A, E, R>` records the result type, typed error, and required
services. Preserve these types when defining command and service interfaces.

The `anyUnknownInErrorContext` diagnostic rejects `any` and `unknown` in error
and requirement channels. Use concrete error unions for application interfaces
and generic error parameters in reusable helpers. `unknown` remains appropriate
for external payloads and nested error causes.

## Errors and cleanup

Use `WctCommandError` and the constructors in `src/errors.ts` for command errors.
Tagged application errors use `Data.TaggedError`.
Keep payload fields distinct from the error's `name` so they do not overwrite
its identity. Only attach typed error handlers to Effects that can fail;
use cause or defect handlers when those are the intended recovery targets.
Yield tagged errors directly inside `Effect.gen`, for example
`return yield* commandError("not_git_repo", "Not a git repository")`.
Use `Effect.fail` when returning a failed Effect outside a generator.
Inside generators, execute returned Effects with `return yield*` and handle
failures with Effect APIs rather than JavaScript `try/catch`. The
`returnEffectInGen` and `tryCatchInEffectGen` diagnostics enforce these patterns.

Workspace reporters return Effects with no required services and `WctError`
for typed failures. Reporter failures and defects, including synchronous
callback throws, are discarded with `Effect.ignoreCause` so reporting cannot
fail a Workspace Operation.

| Purpose                            | API                                    |
| ---------------------------------- | -------------------------------------- |
| Handle typed failures              | `Effect.catch`                         |
| Handle failures by tag             | `Effect.catchTag`, `Effect.catchTags`  |
| Handle a full cause                | `Effect.catchCause`                    |
| Handle defects                     | `Effect.catchDefect`                   |
| Handle selected errors             | `Effect.catchIf`, `Effect.catchFilter` |
| Recover with a fallback value      | `Effect.orElseSucceed`                 |
| Discard results and typed failures | `Effect.ignore`                        |
| Discard results and full causes    | `Effect.ignoreCause`                   |
| Convert an error                   | `Effect.mapError`                      |
| Observe both outcomes              | `Effect.match`, `Effect.matchCause`    |

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
Inside Effect generators, use Effect-based Schema decoders and encoders to
preserve typed failures. Construct Schema class instances with their constructor
or `make` method; object literals and spreads do not preserve the prototype.

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
