# Testing

Use [wctTestLayer or WctTestLayer](../tests/helpers/effect-vitest.ts) for layered
tests and [withTestServices](../tests/helpers/services.ts) with imperative
runners. All three default to `noopTmuxService`, including when the tmux
override is `undefined`. Defined overrides take precedence; other services
remain live.

[Test setup](../tests/setup.ts) blocks bare tmux commands through application
process helpers. Use fake services or mocked process results. CLI subprocess
tests that exercise tmux must provide a fixture executable, as in the
[shutdown integration tests](../tests/shutdown-runner.test.ts).

## Effect tests

Prefer `it.effect`; use `it.live` when live clocks or console output are required.
Both own the test scope, so acquire resources directly without an extra
`Effect.scoped`. Own pending work with child fibers and synchronize with
`Deferred`. Imperative runners must cancel and settle pending work in `finally`.

Read captured output with `TestConsole.logLines` and `TestConsole.errorLines`.
Terminal-styling tests provide explicit `Stdio` flags.

`it.layer` shares service instances for its block. Build layers inside the test
or use `{ buildPerTest: true }` when each test needs independent state. Suites
that mutate process-wide environment, working directory, or shared mocks
declare `{ concurrent: false }`.

Create Effect methods for fixtures with `makeMethods(test.extend(...))` using
the top-level `test` export. Destructure fixture dependencies; `it.effect.each`
receives fixture context as its second argument. Guard fixture setup and `use`
with `try/finally` immediately after acquisition. Use `test.for` for imperative
parameterized tests that need fixture context.

For property tests, bound generators and local `arbitrary` options (`runs`,
`size`, `maxShrinks`), retain regression examples, and include positive cases so
an implementation that always rejects input cannot satisfy the properties.

Use a child scope when testing early release of a `PrRefreshService` session;
see the [service tests](../tests/services/pr-refresh-service.test.ts) for scope
completion, interruption, and session isolation.
