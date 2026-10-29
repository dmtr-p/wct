import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Cause, Effect, Exit, FileSystem, PlatformError } from "effect";
import { describe, expect } from "vitest";
import {
  type BunServices as BunServicesType,
  runBunPromise,
} from "../src/effect/runtime";
import type { WctError } from "../src/errors";
import {
  copyEntries,
  copyFiles,
  detectEntryType,
  expandEntry,
} from "../src/services/copy";
import { test as repoTest } from "./helpers/include-repo";
import { test } from "./helpers/temp-dir";

function runEffect<A>(
  effect: Effect.Effect<A, WctError, BunServicesType.BunServices>,
): Promise<A> {
  return runBunPromise(effect);
}

describe("detectEntryType", () => {
  test("detects file entries", () => {
    expect(detectEntryType(".env")).toBe("file");
    expect(detectEntryType("config/settings.json")).toBe("file");
    expect(detectEntryType(".gitignore")).toBe("file");
  });

  test("detects directory entries with trailing slash", () => {
    expect(detectEntryType(".settings/")).toBe("directory");
    expect(detectEntryType("config/")).toBe("directory");
    expect(detectEntryType("nested/path/dir/")).toBe("directory");
  });

  test("detects glob patterns with asterisk", () => {
    expect(detectEntryType("*.json")).toBe("glob");
    expect(detectEntryType(".claude/**/*.json")).toBe("glob");
    expect(detectEntryType("src/*.ts")).toBe("glob");
  });

  test("detects glob patterns with question mark", () => {
    expect(detectEntryType("file?.txt")).toBe("glob");
  });

  test("detects glob patterns with brackets", () => {
    expect(detectEntryType("[abc].txt")).toBe("glob");
    expect(detectEntryType("file[0-9].txt")).toBe("glob");
  });

  test("detects glob patterns with braces", () => {
    expect(detectEntryType("*.{js,ts}")).toBe("glob");
    expect(detectEntryType("{src,lib}/**/*.ts")).toBe("glob");
  });
});

describe("expandEntry", () => {
  test("returns single file for file entry", async ({ tempDir }) => {
    await Bun.write(join(tempDir, ".env"), "TEST=1");

    const files = await runEffect<string[]>(expandEntry(".env", tempDir));
    expect(files).toEqual([".env"]);
  });

  test("returns file path even if file does not exist", async ({ tempDir }) => {
    const files = await runEffect<string[]>(
      expandEntry("nonexistent.txt", tempDir),
    );
    expect(files).toEqual(["nonexistent.txt"]);
  });

  test("expands directory to all files recursively", async ({ tempDir }) => {
    await mkdir(join(tempDir, ".settings"), { recursive: true });
    await Bun.write(join(tempDir, ".settings/settings.json"), "{}");
    await Bun.write(join(tempDir, ".settings/extensions.json"), "[]");

    const files = await runEffect<string[]>(expandEntry(".settings/", tempDir));
    expect(files.sort()).toEqual(
      [".settings/settings.json", ".settings/extensions.json"].sort(),
    );
  });

  test("returns empty array for non-existent directory", async ({
    tempDir,
  }) => {
    const files = await runEffect<string[]>(
      expandEntry("nonexistent/", tempDir),
    );
    expect(files).toEqual([]);
  });

  test("recovers stat failures while preserving mixed failure defects", async ({
    tempDir,
  }) => {
    const failure = PlatformError.systemError({
      _tag: "NotFound",
      module: "FileSystem",
      method: "stat",
    });
    const expand = expandEntry("missing/", tempDir);
    expect(
      await runBunPromise(
        expand.pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              stat: () => Effect.fail(failure),
            }),
          ),
        ),
      ),
    ).toEqual([]);

    const exit = await runBunPromise(
      expand.pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            stat: () =>
              Effect.failCause(
                Cause.combine(
                  Cause.fail(failure),
                  Cause.die(new Error("filesystem defect")),
                ),
              ),
          }),
        ),
        Effect.exit,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
  });

  test("expands glob pattern to matching files", async ({ tempDir }) => {
    await mkdir(join(tempDir, ".claude/nested"), { recursive: true });
    await Bun.write(join(tempDir, ".claude/config.json"), "{}");
    await Bun.write(join(tempDir, ".claude/nested/settings.json"), "{}");
    await Bun.write(join(tempDir, ".claude/readme.md"), "# README");

    const files = await runEffect<string[]>(
      expandEntry(".claude/**/*.json", tempDir),
    );
    expect(files.sort()).toEqual(
      [".claude/config.json", ".claude/nested/settings.json"].sort(),
    );
  });

  test("returns empty array for glob with no matches", async ({ tempDir }) => {
    const files = await runEffect<string[]>(
      expandEntry("**/*.nonexistent", tempDir),
    );
    expect(files).toEqual([]);
  });

  test("expands nested directory structure", async ({ tempDir }) => {
    await mkdir(join(tempDir, "config/nested/deep"), { recursive: true });
    await Bun.write(join(tempDir, "config/a.json"), "{}");
    await Bun.write(join(tempDir, "config/nested/b.json"), "{}");
    await Bun.write(join(tempDir, "config/nested/deep/c.json"), "{}");

    const files = await runEffect<string[]>(expandEntry("config/", tempDir));
    expect(files.sort()).toEqual(
      [
        "config/a.json",
        "config/nested/b.json",
        "config/nested/deep/c.json",
      ].sort(),
    );
  });

  test("includes dotfiles inside directories", async ({ tempDir }) => {
    await mkdir(join(tempDir, "config"), { recursive: true });
    await Bun.write(join(tempDir, "config/.hidden"), "secret");
    await Bun.write(join(tempDir, "config/.env.local"), "KEY=value");
    await Bun.write(join(tempDir, "config/visible.json"), "{}");

    const files = await runEffect<string[]>(expandEntry("config/", tempDir));
    expect(files.sort()).toEqual(
      ["config/.hidden", "config/.env.local", "config/visible.json"].sort(),
    );
  });
});

describe("copyEntries", { concurrent: false }, () => {
  const test = repoTest.extend<{ sourceDir: string; targetDir: string }>({
    sourceDir: async ({ includeRepo }, use) => {
      await includeRepo.write(".gitignore", "*\n");
      await use(includeRepo.repo);
    },
    targetDir: async ({ includeRepo }, use) => {
      const target = join(includeRepo.root, "target");
      await mkdir(target, { recursive: true });
      await use(target);
    },
  });

  test("copies single file", async ({ sourceDir, targetDir }) => {
    await Bun.write(join(sourceDir, ".env"), "SECRET=123");

    const results = await runEffect(
      copyEntries([".env"], sourceDir, targetDir),
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.success).toBe(true);
    expect(results[0]?.file).toBe(".env");

    const content = await Bun.file(join(targetDir, ".env")).text();
    expect(content).toBe("SECRET=123");
  });

  test("copies directory contents", async ({ sourceDir, targetDir }) => {
    await mkdir(join(sourceDir, ".settings"), { recursive: true });
    await Bun.write(
      join(sourceDir, ".settings/settings.json"),
      '{"editor.tabSize": 2}',
    );
    await Bun.write(join(sourceDir, ".settings/extensions.json"), "[]");

    const results = await runEffect(
      copyEntries([".settings/"], sourceDir, targetDir),
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);

    const settings = await Bun.file(
      join(targetDir, ".settings/settings.json"),
    ).text();
    expect(settings).toBe('{"editor.tabSize": 2}');

    const extensions = await Bun.file(
      join(targetDir, ".settings/extensions.json"),
    ).text();
    expect(extensions).toBe("[]");
  });

  test("copies files matching glob pattern", async ({
    sourceDir,
    targetDir,
  }) => {
    await mkdir(join(sourceDir, ".claude/nested"), { recursive: true });
    await Bun.write(join(sourceDir, ".claude/config.json"), '{"key": "value"}');
    await Bun.write(
      join(sourceDir, ".claude/nested/data.json"),
      '{"data": true}',
    );
    await Bun.write(join(sourceDir, ".claude/readme.md"), "# Skip this");

    const results = await runEffect(
      copyEntries([".claude/**/*.json"], sourceDir, targetDir),
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);

    const config = await Bun.file(
      join(targetDir, ".claude/config.json"),
    ).text();
    expect(config).toBe('{"key": "value"}');

    const data = await Bun.file(
      join(targetDir, ".claude/nested/data.json"),
    ).text();
    expect(data).toBe('{"data": true}');

    const mdExists = await Bun.file(
      join(targetDir, ".claude/readme.md"),
    ).exists();
    expect(mdExists).toBe(false);
  });

  test("copies mixed entry types", async ({ sourceDir, targetDir }) => {
    await Bun.write(join(sourceDir, ".env"), "ENV=prod");
    await mkdir(join(sourceDir, ".settings"), { recursive: true });
    await Bun.write(join(sourceDir, ".settings/settings.json"), "{}");
    await mkdir(join(sourceDir, "config"), { recursive: true });
    await Bun.write(join(sourceDir, "config/app.json"), "{}");
    await Bun.write(join(sourceDir, "config/db.json"), "{}");

    const results = await runEffect(
      copyEntries(
        [".env", ".settings/", "config/*.json"],
        sourceDir,
        targetDir,
      ),
    );

    expect(results).toHaveLength(4);
    expect(results.filter((r) => r.success)).toHaveLength(4);
  });

  test("deduplicates overlapping patterns", async ({
    sourceDir,
    targetDir,
  }) => {
    await mkdir(join(sourceDir, "src"), { recursive: true });
    await Bun.write(join(sourceDir, "src/index.ts"), "export {}");

    const results = await runEffect(
      copyEntries(
        ["src/", "src/**/*.ts", "src/index.ts"],
        sourceDir,
        targetDir,
      ),
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.success).toBe(true);
  });

  test("handles missing file gracefully", async ({ sourceDir, targetDir }) => {
    const results = await runEffect(
      copyEntries(["missing.txt"], sourceDir, targetDir),
    );

    expect(results).toEqual([]);
  });

  test("reports source, directory-creation, and target-write failures with semantic reasons", async ({
    sourceDir,
    targetDir,
  }) => {
    const failures: Array<{
      file: string;
      reason: "source_not_found" | "copy_failed";
      error: string;
    }> = [];
    const reporter = {
      entryFailed: (failure: (typeof failures)[number]) =>
        Effect.sync(() => {
          failures.push(failure);
        }),
    };

    await runEffect(copyFiles(["missing.txt"], sourceDir, targetDir, reporter));

    await mkdir(join(sourceDir, "nested"), { recursive: true });
    await Bun.write(join(sourceDir, "nested/file.txt"), "content");
    const blockedTarget = join(targetDir, "blocked");
    await Bun.write(blockedTarget, "not a directory");
    await runEffect(
      copyEntries(["nested/file.txt"], sourceDir, blockedTarget, reporter),
    );

    await Bun.write(join(sourceDir, "target-is-directory"), "content");
    await mkdir(join(targetDir, "target-is-directory"), { recursive: true });
    await runEffect(
      copyEntries(["target-is-directory"], sourceDir, targetDir, reporter),
    );

    expect(failures).toEqual([
      {
        file: "missing.txt",
        reason: "source_not_found",
        error: "File not found",
      },
      {
        file: "nested/file.txt",
        reason: "copy_failed",
        error: expect.any(String),
      },
      {
        file: "target-is-directory",
        reason: "copy_failed",
        error: expect.any(String),
      },
    ]);
  });

  test("handles missing directory gracefully", async ({
    sourceDir,
    targetDir,
  }) => {
    const results = await runEffect(
      copyEntries(["missing/"], sourceDir, targetDir),
    );

    expect(results).toHaveLength(0);
  });

  test("handles glob with no matches gracefully", async ({
    sourceDir,
    targetDir,
  }) => {
    const results = await runEffect(
      copyEntries(["**/*.nonexistent"], sourceDir, targetDir),
    );

    expect(results).toHaveLength(0);
  });

  test("creates nested target directories", async ({
    sourceDir,
    targetDir,
  }) => {
    await mkdir(join(sourceDir, "deep/nested/path"), { recursive: true });
    await Bun.write(join(sourceDir, "deep/nested/path/file.txt"), "content");

    const results = await runEffect(
      copyEntries(["deep/"], sourceDir, targetDir),
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.success).toBe(true);

    const content = await Bun.file(
      join(targetDir, "deep/nested/path/file.txt"),
    ).text();
    expect(content).toBe("content");
  });

  test.for(["files", "directory", "glob"])(
    "filters %s entries to untracked gitignored regular files",
    async (kind, { sourceDir, targetDir, includeRepo: fixture }) => {
      await fixture.write(".gitignore", "config/*.env\nconfig/*.txt\n");
      await fixture.write("config/tracked.env", "tracked");
      await fixture.git("add", "--force", "config/tracked.env");
      await fixture.write("config/ignored.env", "ignored");
      await fixture.write("config/nonignored.json", "nonignored");
      await fixture.write(".git/info/metadata.env", "metadata");
      await symlink(
        join(sourceDir, "config/ignored.env"),
        join(sourceDir, "config/link.env"),
      );
      const entries =
        kind === "files"
          ? [
              "./config/ignored.env",
              "config/tracked.env",
              "config/nonignored.json",
              "config/link.env",
              ".git/info/metadata.env",
              "config/missing.env",
              "../global-ignore",
            ]
          : [kind === "directory" ? "config/" : "config/**/*"];
      const results = await runEffect(
        copyEntries(entries, sourceDir, targetDir),
      );
      expect(results).toEqual([{ file: "config/ignored.env", success: true }]);
      expect(await Bun.file(join(targetDir, "config/ignored.env")).text()).toBe(
        "ignored",
      );
      for (const file of [
        "config/tracked.env",
        "config/nonignored.json",
        "config/link.env",
        ".git/info/metadata.env",
      ]) {
        expect(await Bun.file(join(targetDir, file)).exists()).toBe(false);
      }
    },
  );

  test("includes info/exclude and global ignore rules for YAML entries", async ({
    sourceDir,
    targetDir,
    includeRepo: fixture,
  }) => {
    await fixture.write(".gitignore", "");
    await fixture.write(".git/info/exclude", "info.env\n");
    await fixture.write("../global-ignore", "global.env\n");
    await fixture.git(
      "config",
      "--global",
      "core.excludesFile",
      join(fixture.root, "global-ignore"),
    );
    await fixture.write("info.env");
    await fixture.write("global.env");
    await fixture.write("other.env");
    const results = await runEffect(
      copyEntries(["*.env"], sourceDir, targetDir),
    );
    expect(results.map((result) => result.file).sort()).toEqual([
      "global.env",
      "info.env",
    ]);
  });

  test("YAML Bun globs reach wholly ignored directories", async ({
    sourceDir,
    targetDir,
    includeRepo: fixture,
  }) => {
    await fixture.write(".gitignore", "vendor/\n");
    await fixture.write("vendor/nested/config.json");
    const results = await runEffect(
      copyEntries(["**/config.json"], sourceDir, targetDir),
    );
    expect(results).toEqual([
      { file: "vendor/nested/config.json", success: true },
    ]);
  });

  test("Git discovery failures fail copying clearly", async ({
    sourceDir,
    targetDir,
  }) => {
    await rm(join(sourceDir, ".git"), { recursive: true, force: true });
    await expect(
      runEffect(copyEntries([".env"], sourceDir, targetDir)),
    ).rejects.toThrow("Failed to discover gitignored files");
  });
});
