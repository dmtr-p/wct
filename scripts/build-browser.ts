#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export const projectDir = dirname(import.meta.dirname);
export const browserBundlePath = join(
  projectDir,
  "src/browser/built.browser-assets",
);

const browserPackages = [
  { name: "@xterm/xterm", notice: "docs/licenses/xterm-MIT.txt" },
  { name: "@xterm/addon-fit", notice: "docs/licenses/xterm-addon-fit-MIT.txt" },
];

export async function buildBrowser() {
  const outputDir = join(projectDir, ".cache/browser-build");
  const result = await Bun.build({
    entrypoints: [join(projectDir, "src/browser/client/index.html")],
    root: join(projectDir, "src/browser/client"),
    outdir: outputDir,
    target: "browser",
    minify: true,
    sourcemap: "none",
    publicPath: "/",
    naming: { entry: "[name].[ext]", asset: "[name]-[hash].[ext]" },
    metafile: true,
  });
  if (!result.success)
    throw new AggregateError(result.logs, "Browser build failed");

  const assets: Record<string, { body: string; contentType: string }> = {};
  for (const output of result.outputs) {
    const name = relative(outputDir, output.path);
    // Only text outputs are accepted; binary assets need an explicit encoding policy.
    const extension = output.path.split(".").at(-1);
    const contentType = {
      html: "text/html; charset=utf-8",
      js: "text/javascript; charset=utf-8",
      css: "text/css; charset=utf-8",
    }[extension ?? ""];
    if (!contentType || name.startsWith("..") || name.includes("\\")) {
      throw new Error(`Unsupported browser output: ${output.path}`);
    }
    assets[`/${name}`] = { body: await output.text(), contentType };
  }

  const licenses: string[] = [];
  const dependencies: Record<string, { version: string; license: string }> = {};
  const inputs = new Set([
    "bun.lock",
    "bunfig.toml",
    "package.json",
    "tsconfig.json",
    "scripts/build-browser.ts",
    ...Object.keys(result.metafile?.inputs ?? {}).map((input) =>
      relative(projectDir, resolve(input)),
    ),
  ]);
  for (const { name, notice } of browserPackages) {
    const packagePath = Bun.resolveSync(`${name}/package.json`, projectDir);
    const pkg = await Bun.file(packagePath).json();
    const licensePath = join(dirname(packagePath), "LICENSE");
    if (pkg.license !== "MIT")
      throw new Error(`Review changed license for ${name}`);
    const licenseText = await Bun.file(licensePath).text();
    if (licenseText !== (await Bun.file(join(projectDir, notice)).text()))
      throw new Error(`Review changed license text for ${name}`);
    licenses.push(`${name} ${pkg.version}\n\n${licenseText}`);
    dependencies[name] = { version: pkg.version, license: pkg.license };
    inputs.add(relative(projectDir, packagePath));
    inputs.add(relative(projectDir, licensePath));
    inputs.add(notice);
  }
  assets["/third-party-licenses.txt"] = {
    body: licenses.join("\n\n"),
    contentType: "text/plain; charset=utf-8",
  };
  const hashes: Record<string, string> = {};
  for (const input of [...inputs].sort()) {
    hashes[input] = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(join(projectDir, input)).arrayBuffer())
      .digest("hex");
  }
  assets["/build-info.json"] = {
    body: JSON.stringify(
      { bun: Bun.version, dependencies, inputs: hashes },
      null,
      2,
    ),
    contentType: "application/json; charset=utf-8",
  };
  await mkdir(dirname(browserBundlePath), { recursive: true });
  await Bun.write(browserBundlePath, JSON.stringify(assets));
  return assets;
}

if (import.meta.main) {
  const assets = await buildBrowser();
  console.log(`Built ${Object.keys(assets).length} browser assets`);
}
