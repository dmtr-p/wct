# Effect 4.0.0-beta.102 upgrade notes

## Scope and conclusion

The upgrade baseline is `4.0.0-beta.98` for `effect`, `@effect/platform-bun`, and `@effect/vitest`; the lockfile also resolves `@effect/platform-node-shared` at beta.98 ([wct manifest at the baseline revision](https://github.com/dmtr-p/wct/blob/d525b6b4d58d96f3fb79d4b3514b83ed2e91a92d/package.json#L20-L38)). This note covers the four core releases from [beta.99](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-beta.99) through [beta.102](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-beta.102).

The upgrade is low-risk for wct. One beta.102 CLI change requires a source update: the new `CliError.UnexpectedArgument` variant must be handled by wct's JSON error mapping. The other documented breaking changes affect APIs that wct does not import. `@effect/platform-bun` has one beta.102 cluster-specific change plus dependency updates, while `@effect/vitest` has a `Record.assignProperty` change plus dependency updates ([platform-bun release](https://github.com/Effect-TS/effect/releases/tag/%40effect%2Fplatform-bun%404.0.0-beta.102), [vitest release](https://github.com/Effect-TS/effect/releases/tag/%40effect%2Fvitest%404.0.0-beta.102)).

## Breaking and behavior changes relevant to wct

### CLI now rejects leftover positional arguments

Beta.102 adds `CliError.UnexpectedArgument` and rejects positional operands left after command parsing, including values beyond an `Argument.variadic` maximum ([upstream change](https://github.com/Effect-TS/effect/commit/c917bb94a4c1c4e0a24372a8ebb8a5ca232e36b5)). Because wct switches over the CLI error union in a function declared to return a non-optional result, the new variant causes a type-check failure until it is mapped. It belongs with `UnrecognizedOption`, `MissingArgument`, and `InvalidValue` under wct's `invalid_options` JSON code ([baseline error mapping](https://github.com/dmtr-p/wct/blob/d525b6b4d58d96f3fb79d4b3514b83ed2e91a92d/src/index.ts#L22-L43)).

The runtime behavior is also desirable: commands with no positional parameters no longer silently accept extra operands. Wct's unbounded `close` variadic remains unaffected ([baseline argument definition](https://github.com/dmtr-p/wct/blob/d525b6b4d58d96f3fb79d4b3514b83ed2e91a92d/src/cli/root-command.ts#L19-L25)).

### A new built-in `--wizard` flag changes CLI surface area

Beta.99 reintroduces interactive CLI wizard mode through the built-in `--wizard` flag and `Command.wizard`; it also adds the scoped `CliConfig` service so applications can choose their built-in global flags ([wizard change](https://github.com/Effect-TS/effect/commit/80b539f8aba68f478c75c35c2b4140c4ffc4fada), [configuration change](https://github.com/Effect-TS/effect/commit/8ce4795ccbaebca4292757db568c005a992546a4)). Wct generates its own completion scripts, whose global option lists contain help, version, completions, and log-level but not wizard ([baseline completion source](https://github.com/dmtr-p/wct/blob/d525b6b4d58d96f3fb79d4b3514b83ed2e91a92d/src/cli/completions.ts#L123-L136)).

This needs an explicit product choice, not just a version change:

- If wizard mode is useful, keep the default built-ins and add `--wizard` to all custom completion generators and any JSON-output action detection that should not be suppressed.
- If wct wants to preserve its previous CLI surface, provide `CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions, GlobalFlag.LogLevel] })` around the command runner. This is the cleaner near-term choice because the custom completions otherwise advertise an incomplete global-flag set.

The upgrade implements the second option: wct explicitly retains its prior
built-in flags, so `--wizard` is not exposed accidentally and the accepted
flags remain aligned with the custom completion generators.

### Other beta.102 removals do not affect current source

Beta.102 removes `Effect.withConcurrency`, `References.CurrentConcurrency`, and the `"inherit"` concurrency option; removes experimental `SchemaUtils`; makes `Schema.Date` itself reject invalid dates while removing `Schema.DateValid` and related guards; removes `Schema.asClass` in favor of directly extending schemas; and substantially replaces the low-level `SchemaRepresentation` persistence/reviver API ([beta.102 release notes](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-beta.102)). Wct imports none of those APIs, so no application migration is required. `EFFECT_V4.md` still names `References.CurrentConcurrency`, however, and should be corrected when that local migration reference is next maintained ([baseline reference](https://github.com/dmtr-p/wct/blob/d525b6b4d58d96f3fb79d4b3514b83ed2e91a92d/EFFECT_V4.md#L268)).

The prior beta.98 `CliError.UnknownSubcommand._tag` typo remains present in beta.102 (`"UnknownSubcomand"`). Wct's class-based `instanceof CliError.UnknownSubcommand` check therefore remains necessary; do not replace it with a `_tag` match ([beta.102 source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.102/packages/effect/src/unstable/cli/CliError.ts#L408-L413), [wct compatibility check](https://github.com/dmtr-p/wct/blob/d525b6b4d58d96f3fb79d4b3514b83ed2e91a92d/src/index.ts#L29-L31)).

## New and fixed functionality worth using

- Beta.100 fixes duplicated `Expected: Expected ...` text in CLI invalid-value diagnostics. Wct receives this automatically through its existing Effect CLI definitions ([upstream fix](https://github.com/Effect-TS/effect/commit/875e618c3764a7b817ac863d0af86924449528f2)).
- Beta.102 adds `Schema.Natural` for non-negative safe integers and tightens invalid numeric/date decoding across built-in schemas ([upstream change](https://github.com/Effect-TS/effect/commit/0e50ec7dbb94390666f292cf9120719bf30a7246)). Wct's config schema has only an optional numeric `version` today; `Schema.Natural` would be appropriate if that field is intended to accept only non-negative integer schema versions, but adopting it changes accepted configuration and should be a deliberate validation decision rather than part of the dependency bump.
- Beta.102 adds `Symbol.asyncDispose` to `ManagedRuntime`, enabling `await using` ([upstream change](https://github.com/Effect-TS/effect/commit/cea1d9c92601e69ebda040af8a1d860d604d885c)). Wct's TUI runtime is intentionally process-scoped and currently has no disposal path, so adopting `await using` would conflict with that lifecycle design rather than simplify it ([baseline TUI runtime](https://github.com/dmtr-p/wct/blob/d525b6b4d58d96f3fb79d4b3514b83ed2e91a92d/src/tui/runtime.ts#L24-L35)).
- Beta.102 adds `Record.assignProperty`, including safe handling for dynamic keys such as `__proto__`, and makes `Record.fromIterableBy` usable data-last ([safe assignment](https://github.com/Effect-TS/effect/commit/5101e92c9c149c153423f43dd7a94f6194653c06), [data-last constructor](https://github.com/Effect-TS/effect/commit/69663534d626003eb10a5e55ab1f13e0379fead1)). Current wct code does not build Effect `Record` values incrementally, so there is no immediate adoption site.
- Beta.101 contains runtime interruption, traversal cleanup, stack-frame, and synchronous-runner performance fixes with no API migration ([beta.101 release](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-beta.101)). Wct benefits transitively.

## Recommendation

Upgrade all resolved Effect packages together to beta.102, add `UnexpectedArgument` to the JSON invalid-options mapping, retain the class-based unknown-subcommand check, and explicitly preserve the previous built-in flag set with `CliConfig`. No other application refactor is warranted for this upgrade.
