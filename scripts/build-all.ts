#!/usr/bin/env bun
import { BunCrypto, BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Layer, Path } from "effect";
import { Digest } from "effect/crypto";
import { commandError, toWctError } from "../src/errors";
import { execProcess, getProcessErrorMessage } from "../src/services/process";

const platforms = [
  { target: "bun-darwin-x64", outfile: "wct-darwin-x64" },
  { target: "bun-darwin-arm64", outfile: "wct-darwin-arm64" },
  { target: "bun-linux-x64", outfile: "wct-linux-x64" },
  { target: "bun-linux-arm64", outfile: "wct-linux-arm64" },
];

function buildPlatform(
  { target, outfile }: (typeof platforms)[number],
  projectDir: string,
  distDir: string,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const digest = yield* Digest.Digest;
    const outpath = path.join(distDir, outfile);

    yield* Console.log(`Building ${outfile} (${target})...`);
    yield* execProcess(
      process.execPath,
      [
        "build",
        "src/index.ts",
        "--compile",
        "--target",
        target,
        "--outfile",
        outpath,
      ],
      {
        cwd: projectDir,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      },
    );

    const info = yield* fs.stat(outpath);
    const sizeMB = (Number(info.size) / 1024 / 1024).toFixed(2);
    yield* Console.log(`  ✓ Built ${outfile} (${sizeMB} MB)`);

    const buffer = yield* fs.readFile(outpath);
    const checksum = yield* digest.digestHex(Digest.sha256, buffer);
    yield* Console.log(`  ✓ Checksum: ${checksum}\n`);
    return `${checksum}  ${outfile}`;
  }).pipe(
    Effect.mapError((error) =>
      commandError(
        "unexpected_error",
        `Failed to build ${outfile}: ${getProcessErrorMessage(error)}`,
        error,
      ),
    ),
  );
}

export const buildAll = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const distDir = path.join(projectDir, "dist");

  yield* Console.log("Building wct for all platforms...\n");
  yield* fs.makeDirectory(distDir, { recursive: true });

  yield* execProcess(process.execPath, ["run", "scripts/build-browser.ts"], {
    cwd: projectDir,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });

  const checksums = yield* Effect.forEach(platforms, (platform) =>
    buildPlatform(platform, projectDir, distDir),
  );

  const checksumsPath = path.join(distDir, "checksums.txt");
  yield* fs.writeFileString(checksumsPath, `${checksums.join("\n")}\n`);
  yield* Console.log(`\n✓ Checksums written to ${checksumsPath}`);
  yield* Console.log("\n✓ Build complete! Binaries available in dist/");
}).pipe(Effect.mapError((error) => toWctError(error, "Build failed")));

if (import.meta.main) {
  const buildLayer = Layer.mergeAll(
    BunServices.layer,
    // oxlint-disable-next-line effecttsgo/unstable-api-usage -- BunCrypto re-exports this layer from the pinned shared platform package.
    BunCrypto.layerDigest,
  );
  BunRuntime.runMain(buildAll.pipe(Effect.provide(buildLayer)));
}
