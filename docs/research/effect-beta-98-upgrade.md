# Effect 4.0.0-beta.98 upgrade notes

## Scope and conclusion

The upgrade baseline is `4.0.0-beta.97` for `effect`, `@effect/platform-bun`, and `@effect/vitest`; the lockfile also resolves `@effect/platform-node-shared` at beta.97 ([wct package manifest at the baseline revision](https://github.com/dmtr-p/wct/blob/d76faca5a18afd841008aad08e798eeb36eac212/package.json#L20-L38)). The official beta.97-to-beta.98 comparison contains 30 commits ([full upstream comparison](https://github.com/Effect-TS/effect-smol/compare/effect@4.0.0-beta.97...effect@4.0.0-beta.98)).

The upgrade is low-risk for wct after accounting for one undocumented CLI `_tag` regression. The documented breaking changes are confined to unstable `HttpApi` types and runtime shapes, and wct does not import or use `HttpApi` ([beta.98 core changelog](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/CHANGELOG.md#L122-L166)). The beta.98 changelogs for `@effect/platform-bun` and `@effect/vitest` list dependency updates only, with no package-specific API changes ([platform-bun changelog](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/platform-bun/CHANGELOG.md#L3-L9), [vitest changelog](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/vitest/CHANGELOG.md#L3-L8)).

## Breaking changes and regressions relevant to wct

### `CliError.UnknownSubcommand._tag` typo

Beta.98 changes `CliError.UnknownSubcommand` from `Schema.ErrorClass` to `Schema.TaggedErrorClass`, but passes the misspelled tag literal `"UnknownSubcomand"` (one `m`) while retaining the class/export name `UnknownSubcommand` ([tagged beta.98 source](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/src/unstable/cli/CliError.ts#L408-L413)). This behavior change is not disclosed beyond the changelog's generic “Cleanup internals of CLI package” entry ([changelog entry](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/CHANGELOG.md#L192-L192)).

At the baseline revision, wct maps unknown commands to its JSON `unknown_command` code by matching `_tag === "UnknownSubcommand"`, so beta.98 would skip that case ([baseline wct source](https://github.com/dmtr-p/wct/blob/d76faca5a18afd841008aad08e798eeb36eac212/src/index.ts#L23-L34)). Matching `error instanceof CliError.UnknownSubcommand` before the `_tag` switch is the correct localized compatibility measure: it uses the unchanged exported class and does not depend on the misspelled serialized tag.

### Other CLI cleanup

The same cleanup removes the exported `GlobalFlag.BuiltInSettingContext` type, derives the equivalent type internally, and narrows `GlobalFlag.BuiltIns` from a general readonly array to a precise tuple ([upstream CLI cleanup commit](https://github.com/Effect-TS/effect-smol/commit/4ae0c5ffcbe6c56ddfcb05c639112a079483539e)). wct uses neither export, so this causes no source change here.

### Documented `HttpApi` breakage

Beta.98 renames structural constraint/helper types, changes endpoints from plain objects to function objects, replaces endpoint `.name` with `.identifier`, changes handler/client type parameters, and tightens identifier-keyed maps ([breaking-change section](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/CHANGELOG.md#L122-L166)). These changes are irrelevant to the current codebase because it has no `HttpApi` usage.

## New or fixed functionality worth considering

- A public `effect/SchemaError` module and `Schema.isSchemaError` guard now provide stable schema-error narrowing ([upstream change](https://github.com/Effect-TS/effect-smol/commit/989603b60ab1197b64acf214208e0d370cd1f842)). wct decodes its config with Schema, but already obtains and formats all validation issues through the Standard Schema adapter; adopting this API now would not simplify the current flow materially ([wct validator](https://github.com/dmtr-p/wct/blob/d76faca5a18afd841008aad08e798eeb36eac212/src/config/validator.ts#L10-L53)).
- Schema union dispatch now considers all sentinel keys, rejects ambiguous `oneOf` matches, preserves declared member order, and commits concurrent results in declaration order ([upstream fix](https://github.com/Effect-TS/effect-smol/commit/388dcf953f65d317547f34d40e6443c5f264205f)). wct's config union is the simple `string | string[]` profile matcher, so no migration or redesign is indicated ([wct config schema](https://github.com/dmtr-p/wct/blob/d76faca5a18afd841008aad08e798eeb36eac212/src/config/schema.ts#L36-L43)).
- `Clock.sleep` now handles very large durations safely ([upstream fix](https://github.com/Effect-TS/effect-smol/commit/87bea7e16259246f3bcdf565446394751abca953)). wct currently has no `Clock.sleep` or `Effect.sleep` usage, so there is nothing to adopt.
- Bracket-path decoding from `FormData` and `URLSearchParams` no longer permits inherited-prototype mutation ([upstream security fix](https://github.com/Effect-TS/effect-smol/commit/01d00a3abfbf1f37996cdbe738ea5137c646cdd7)). wct does not use those schema decoding paths.
- `HttpApiBuilder.Handlers.handleAll`, identifier-keyed group/endpoint typing, extendable endpoint classes, and substantial type-instantiation improvements are new in beta.98 ([feature and performance notes](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/CHANGELOG.md#L74-L121)). They are useful only if wct later adopts `HttpApi`.

## Recommendation

Upgrade all four resolved Effect packages together to beta.98 and retain the class-based unknown-subcommand check. No other application refactor or new beta.98 API adoption is warranted for the current codebase.
