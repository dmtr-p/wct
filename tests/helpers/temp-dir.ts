import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base } from "vitest";

export async function tempDirFixture(
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest requires destructuring even without dependencies.
  {}: object,
  use: (directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "wct-test-"));
  try {
    await use(await realpath(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const test = base.extend<{ tempDir: string }>({
  tempDir: tempDirFixture,
});
