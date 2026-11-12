# Browser assets

`src/browser/client/index.html` is the browser entry point. Bun bundles its
TypeScript and CSS, including xterm.js and the fit addon, for the browser.
The shell renders an inactive terminal preview; there is no connection or
attachment endpoint. Browser code must not import CLI, Ink or server services.
The packaging boundary is recorded in [ADR 0003](adr/0003-browser-assets.md).

## Build and loading

`bun run build:browser` generates the ignored
`src/browser/built.browser-assets` file. It contains only emitted HTML, JS
and CSS, `/third-party-licenses.txt`, and `/build-info.json`. Build info records
the Bun version, dependency versions/licenses and SHA-256 hashes for the lock,
package manifest, build script, browser source, resolved bundle inputs and
dependency licenses. Source maps and arbitrary source files are not served.
Binary output fails the build until its encoding and MIME policy is defined.

`bun run prepare` and `bun start` prepare these assets for source development.
After browser edits, rebuild with `bun run build:browser` or restart `bun start`.
`bun run build` prepares the assets then compiles the native executable.
`bun run build:all` prepares once, embeds the same manifest in each supported
target, and checksums the resulting binaries. The release workflow uses this
path. See [development tooling](development.md) for dependency setup and checks.

`loadBrowserAssets` in `src/browser/load-assets.ts` dynamically loads the
manifest helper. `src/index.ts` re-exports it so the compiler includes the
bundle without loading it at CLI startup. Its `browserAssetResponse(pathname)`
returns a fresh response for an exact manifest key; `/` aliases `/index.html`.
Unknown paths return `undefined`. Callers pass a URL pathname, not a query
string or decoded filesystem path. The helper does no path normalization and
offers no filesystem or SPA fallback. Responses carry explicit content types,
`nosniff`, and `no-store` so shell and chunks stay from the same build.
The eventual authenticated browser handler owns HTTP method and access checks.

The text import embeds all bodies and metadata in the compiled executable.
Loading needs neither the source checkout, installed dependencies nor a
particular current directory. Source execution resolves the generated import
relative to the module. Other CLI commands neither load this manifest nor
initialize Ink.

## Dependencies and notices

| Package            | Version | License | Purpose                                  |
| ------------------ | ------- | ------- | ---------------------------------------- |
| `@xterm/xterm`     | 6.0.0   | MIT     | Browser terminal renderer and stylesheet |
| `@xterm/addon-fit` | 0.11.0  | MIT     | Size terminal to its containing element  |

The complete notices are tracked in `docs/licenses/xterm-MIT.txt` and
`docs/licenses/xterm-addon-fit-MIT.txt`. The build includes the installed
packages' complete license files in the embedded notice asset and rejects
license changes for review. Review these tracked copies on dependency updates.
Neither package adds transitive runtime dependencies. New browser dependencies
must have a concrete feature purpose and update this inventory and build
license inputs; the allowance in [AGENTS.md](../AGENTS.md#bun-runtime) is scoped
to browser feature needs.
