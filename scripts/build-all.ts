#!/usr/bin/env bun
import { join } from "node:path";
import { $ } from "bun";
import { FileSystem } from "effect";
import { runBunPromise } from "../src/effect/runtime";

const platforms = [
  { target: "bun-darwin-x64", outfile: "wct-darwin-x64" },
  { target: "bun-darwin-arm64", outfile: "wct-darwin-arm64" },
  { target: "bun-linux-x64", outfile: "wct-linux-x64" },
  { target: "bun-linux-arm64", outfile: "wct-linux-arm64" },
];

const distDir = join(import.meta.dir, "..", "dist");

async function build(): Promise<void> {
  const fs = await runBunPromise(FileSystem.FileSystem);
  console.log("Building wct for all platforms...\n");

  await runBunPromise(fs.makeDirectory(distDir, { recursive: true }));

  const checksums: string[] = [];

  for (const { target, outfile } of platforms) {
    const outpath = join(distDir, outfile);

    console.log(`Building ${outfile} (${target})...`);

    try {
      await $`bun build src/index.ts --compile --target ${target} --outfile ${outpath}`;

      const stat = await runBunPromise(fs.stat(outpath));
      const sizeMB = (Number(stat.size) / 1024 / 1024).toFixed(2);
      console.log(`  ✓ Built ${outfile} (${sizeMB} MB)`);

      const buffer = await runBunPromise(fs.readFile(outpath));
      const hash = new Bun.CryptoHasher("sha256");
      hash.update(buffer);
      const checksum = hash.digest("hex");
      checksums.push(`${checksum}  ${outfile}`);
      console.log(`  ✓ Checksum: ${checksum}\n`);
    } catch (error) {
      console.error(`  ✗ Failed to build ${outfile}:`, error);
      process.exit(1);
    }
  }

  const checksumsPath = join(distDir, "checksums.txt");
  await runBunPromise(
    fs.writeFileString(checksumsPath, `${checksums.join("\n")}\n`),
  );
  console.log(`\n✓ Checksums written to ${checksumsPath}`);

  console.log("\n✓ Build complete! Binaries available in dist/");
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
