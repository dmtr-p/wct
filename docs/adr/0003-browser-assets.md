---
status: accepted
---

# Bundle browser terminal libraries as embedded assets

The browser terminal uses `@xterm/xterm` and `@xterm/addon-fit`. Fit supplies
container sizing without a second terminal implementation. Both are pinned
MIT-licensed dependencies. The dependency policy permits libraries needed by
the browser feature, with justification and license/build-input tracking for
additions; it does not open the server dependency list. React is permitted in
browser bundles, although the asset foundation uses a plain DOM entry point.
Ink remains exclusive to the lazy TUI.

Bun builds the browser HTML, TypeScript and CSS with `target: "browser"`.
The build collects only emitted HTML, JavaScript and CSS into a manifest of
exact URL paths and text bodies. It adds dependency notices and build-input
hashes. A text import embeds that manifest in every compiled executable;
browser JavaScript is data to the server and is never evaluated there.
An exported dynamic loader keeps the bundle reachable by the compiler while
ordinary CLI startup does not load it. This avoids a separate package and
does not require another bundler or a runtime asset directory.

The manifest is the entire static-serving boundary: no filesystem joins,
directory scans, decoded path fallback, or SPA fallback. Supporting binary
assets requires an explicit encoding policy. Source development uses the same
generated manifest as compilation, so it exercises the same URL mapping and
MIME types. Generation belongs to prepare, development start, and both build
paths. Release targets share one platform-independent browser bundle.

This decision implements the packaging prerequisite for RFC #327. It adds no
listener, terminal attachment endpoint, authentication scheme or daemon, and
does not clear the RFC's attachment, need, single-host or multi-host gates.
See [browser assets](../browser-assets.md) for the build and loading contract.
