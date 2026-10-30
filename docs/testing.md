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

See the [Effect reference](../EFFECT_V4.md) for scope ownership, console capture,
layers, and property testing.

`PrRefreshService.openSession` requires an Effect scope. Acquire a session
directly in an `it.effect` test, or provide a child scope when testing early
release. The [PR refresh service tests](../tests/services/pr-refresh-service.test.ts)
cover scope completion, interruption, and session isolation; see
[PR refresh](pr-refresh.md) for behavior.
