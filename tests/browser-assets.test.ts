import { join, resolve } from "node:path";
import { describe, expect } from "vitest";
import { test } from "./helpers/temp-dir";

const root = resolve(import.meta.dirname, "..");
const loader = join(root, "src/browser/load-assets.ts");

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  return stdout;
}

describe("browser build boundary", () => {
  test("loads the same allowlisted assets in development and an executable outside the checkout", async ({
    tempDir,
  }) => {
    await run(
      [process.execPath, join(root, "scripts/build-browser.ts")],
      tempDir,
    );
    const probe = join(tempDir, "probe.ts");
    await Bun.write(
      probe,
      `import { loadBrowserAssets } from ${JSON.stringify(loader)};
import { startLocalTerminal } from ${JSON.stringify(join(root, "src/browser/server.ts"))};
const { browserAssetPaths, browserAssetResponse } = await loadBrowserAssets();
const bodies = {};
for (const path of browserAssetPaths) {
  const response = browserAssetResponse(path);
  bodies[path] = {body: await response.text(), headers: Object.fromEntries(response.headers)};
}
const rejected = ["/../package.json", "/%2e%2e/package.json", "/src/index.ts", "/package.json", "/__proto__", "/constructor", "/index.html/extra", "/index.html?x=1", "//index.html", "/missing.js"];
if (rejected.some(path => browserAssetResponse(path) !== undefined)) throw new Error("Unlisted path served");
if (await browserAssetResponse("/").text() !== bodies["/index.html"].body) throw new Error("Root alias mismatch");
const endpoint = await startLocalTerminal({ env: {}, backend: {
  prepare: async () => { throw new Error("No attachment in asset probe"); },
  query: async () => null, detach: async () => {},
  verify: async () => { throw new Error("No target in asset probe"); }
} });
try {
  const page = await fetch(endpoint.url);
  if (page.status !== 200 || await page.text() !== bodies["/index.html"].body) throw new Error("Compiled endpoint assets unavailable");
  const auth = await fetch(new URL("/api/bootstrap", endpoint.url), {
    method: "POST", headers: { origin: new URL(endpoint.url).origin, "content-type": "application/json" },
    body: JSON.stringify({ secret: new URL(endpoint.bootstrapUrl).hash.slice(1) })
  });
  if (auth.status !== 204 || !auth.headers.get("set-cookie")?.includes("HttpOnly")) throw new Error("Compiled authentication endpoint unavailable");
} finally { await endpoint.stop(); }
console.log(JSON.stringify(bodies));`,
    );
    const source = await run([process.execPath, probe], tempDir);
    const binary = join(tempDir, "asset-probe");
    await run(
      [process.execPath, "build", probe, "--compile", "--outfile", binary],
      tempDir,
    );
    const compiled = await run([binary], tempDir);
    expect(JSON.parse(compiled)).toEqual(JSON.parse(source));
    const assets = JSON.parse(compiled) as Record<
      string,
      { body: string; headers: Record<string, string> }
    >;
    const html = assets["/index.html"];
    expect(html?.headers["content-type"]).toBe("text/html; charset=utf-8");
    for (const match of html?.body.matchAll(/(?:src|href)="([^"]+)"/g) ?? []) {
      const path = match[1];
      expect(path).toMatch(/^\//);
      expect(assets[path ?? ""]).toBeDefined();
    }
    expect(Object.keys(assets).some((path) => path.endsWith(".js"))).toBe(true);
    expect(Object.keys(assets).some((path) => path.endsWith(".css"))).toBe(
      true,
    );
    for (const asset of Object.values(assets)) {
      expect(asset.headers["cache-control"]).toBe("no-store");
      expect(asset.headers["x-content-type-options"]).toBe("nosniff");
    }
    const notices = assets["/third-party-licenses.txt"]?.body;
    expect(notices).toContain("@xterm/xterm 6.0.0");
    expect(notices).toContain("@xterm/addon-fit 0.11.0");
    expect(notices).toContain("effect 4.1.2");
    expect(notices).toBe(
      [
        `@xterm/xterm 6.0.0\n\n${await Bun.file(join(root, "docs/licenses/xterm-MIT.txt")).text()}`,
        `@xterm/addon-fit 0.11.0\n\n${await Bun.file(join(root, "docs/licenses/xterm-addon-fit-MIT.txt")).text()}`,
        `effect 4.1.2\n\n${await Bun.file(join(root, "docs/licenses/effect-MIT.txt")).text()}`,
      ].join("\n\n"),
    );
    const info = JSON.parse(assets["/build-info.json"]?.body ?? "{}");
    expect(info.bun).toBe(Bun.version);
    expect(info.dependencies["@xterm/xterm"]).toEqual({
      version: "6.0.0",
      license: "MIT",
    });
    expect(info.inputs["src/browser/client/main.ts"]).toMatch(/^[a-f0-9]{64}$/);
    expect(info.inputs["src/browser/client/index.html"]).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(info.inputs["src/browser/client/style.css"]).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(info.inputs["bun.lock"]).toMatch(/^[a-f0-9]{64}$/);
    expect(info.inputs["bunfig.toml"]).toMatch(/^[a-f0-9]{64}$/);
    expect(info.inputs["tsconfig.json"]).toMatch(/^[a-f0-9]{64}$/);
    expect(
      Object.keys(info.inputs).every(
        (path) => !path.startsWith("/") && !path.startsWith(".."),
      ),
    ).toBe(true);
  }, 30_000);

  test("ordinary source and compiled CLI commands leave browser assets and Ink unloaded", async ({
    tempDir,
  }) => {
    const guard = join(tempDir, "guard.ts");
    await Bun.write(
      guard,
      `import { plugin } from "bun";
plugin({ name: "forbid-ui-execution", setup(build) {
  build.onLoad({ filter: /(?:browser\\/(?:assets|server)\\.ts|built\\.browser-assets|node_modules\\/.*ink\\/)/ }, () => { throw new Error("UI loaded by ordinary CLI"); });
} });`,
    );
    const entry = join(root, "src/index.ts");
    for (const args of [["--help"], ["--version"], ["--completions", "bash"]]) {
      expect(
        await run(
          [process.execPath, "--preload", guard, entry, ...args],
          tempDir,
        ),
      ).not.toBe("");
    }

    // The compiler must include the lazy module but runtime must never evaluate it.
    const builder = join(tempDir, "compile.ts");
    const binary = join(tempDir, "wct");
    await Bun.write(
      builder,
      `const result = await Bun.build({
  entrypoints: [${JSON.stringify(entry)}],
  compile: { outfile: ${JSON.stringify(binary)} },
  plugins: [{ name: "poison-ui", setup(build) {
    build.onLoad({ filter: /(?:browser\\/(?:assets|server)\\.ts|node_modules\\/.*ink\\/.*\\.js)/ }, async args => ({ contents: 'throw new Error("UI initialized by ordinary CLI");\\n' + await Bun.file(args.path).text(), loader: args.path.endsWith(".ts") ? "ts" : "js" }));
  }}]
});
if (!result.success) throw new AggregateError(result.logs, "Compile failed");`,
    );
    await run([process.execPath, builder], tempDir);
    for (const args of [["--help"], ["--version"], ["--completions", "bash"]]) {
      expect(await run([binary, ...args], tempDir)).not.toBe("");
    }
    for (const command of [
      [process.execPath, "--preload", guard, entry],
      [binary],
    ]) {
      const child = Bun.spawn([...command, "browser", "--json"], {
        cwd: tempDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("strict per-session input fencing");
      expect(stderr).not.toContain("UI initialized");
      expect(stderr).not.toContain("UI loaded");
    }
  }, 30_000);
});
