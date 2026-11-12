#!/usr/bin/env bun
import { join } from "node:path";
import { buildBrowser, projectDir } from "./build-browser";

await buildBrowser();
const child = Bun.spawn(
  [
    process.execPath,
    "build",
    "src/index.ts",
    "--compile",
    "--outfile",
    join(projectDir, "dist/wct"),
    ...process.argv.slice(2),
  ],
  { cwd: projectDir, stdio: ["ignore", "inherit", "inherit"] },
);
process.exitCode = await child.exited;
