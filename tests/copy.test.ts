import {
  chmod,
  link,
  mkdir,
  rm,
  stat,
  symlink,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { describe, expect, vi } from "vitest";
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
  parseEntry,
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

  test("detects directory glob patterns", () => {
    expect(detectEntryType("**/secrets/")).toBe("glob");
  });
});

describe("expandEntry", () => {
  const candidates = new Set([
    ".env",
    ".env.local",
    ".settings/settings.json",
    ".settings/.hidden",
    ".claude/config.json",
    ".claude/nested/settings.json",
    ".claude/readme.md",
    "config/a.json",
    "config/nested/b.json",
    "config/nested/deep/c.json",
    "config/.hidden",
    "config/app1.env",
    "config/app2.env",
    "literal[1].env",
    "!literal.env",
    "back\\slash.env",
    "secrets/token",
    "config/secrets/nested/token",
    "config/cache/data",
    "cache[v1]/data",
    "!cache[v1]/data",
    "file[1].txt",
    "file1.txt",
  ]);

  test.each([
    [".env", [".env"]],
    ["missing.env", []],
    [".settings/", [".settings/settings.json", ".settings/.hidden"]],
    ["missing/", []],
    [
      ".claude/**/*.json",
      [".claude/config.json", ".claude/nested/settings.json"],
    ],
    ["**/*.nonexistent", []],
    [
      "config/",
      [
        "config/a.json",
        "config/nested/b.json",
        "config/nested/deep/c.json",
        "config/.hidden",
        "config/app1.env",
        "config/app2.env",
        "config/secrets/nested/token",
        "config/cache/data",
      ],
    ],
    [
      "config/*.{env,json}",
      ["config/a.json", "config/app1.env", "config/app2.env"],
    ],
    ["config/app[0-9].env", ["config/app1.env", "config/app2.env"]],
    ["literal\\[1\\].env", ["literal[1].env"]],
    ["\\!literal.env", ["!literal.env"]],
    ["back\\slash.env", ["back\\slash.env"]],
    ["config/../.env", [".env"]],
    ["config/../.claude/*.json", [".claude/config.json"]],
    ["./config/a.json", ["config/a.json"]],
    ["/source/*.env", []],
    ["../*.env", []],
    ["**/secrets/", ["secrets/token", "config/secrets/nested/token"]],
    ["*/cache/", ["config/cache/data"]],
    ["cache[v1]/", ["cache[v1]/data"]],
    ["./!lit*", ["!literal.env"]],
    ["\\!cache[v1]/", ["!cache[v1]/data"]],
    ["file[1].txt", ["file[1].txt", "file1.txt"]],
    ["config/[x]/../a.json", ["config/a.json"]],
  ] as const)("selects %s from Git's candidate paths", (entry, expected) => {
    expect(expandEntry(parseEntry(entry), candidates)).toEqual(expected);
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

  test("limits glob matching to literal directory prefixes and root files", async ({
    sourceDir,
    targetDir,
    includeRepo,
  }) => {
    await includeRepo.git("add", "--force", ".gitignore");
    for (const file of [
      ".claude/a.json",
      ".claude/nested/b.json",
      ".config/c.json",
      "node_modules/package/unrelated.json",
      "other/d.json",
      "root.json",
    ])
      await includeRepo.write(file, "{}");
    const match = vi.spyOn(Bun.Glob.prototype, "match");
    try {
      const results = await runEffect(
        copyEntries(
          [
            ".claude/**/*.json",
            ".config/**/*.json",
            "*.json",
            "!node_modules/**/*.json",
            "!.claude/nested/*.json",
          ],
          sourceDir,
          targetDir,
        ),
      );
      expect(results.map((result) => result.file)).toEqual([
        ".claude/a.json",
        ".config/c.json",
        "root.json",
      ]);
      expect(match.mock.calls.map(([path]) => path)).toEqual([
        ".claude/a.json",
        ".claude/nested/b.json",
        ".config/c.json",
        "root.json",
        ".claude/nested/b.json",
      ]);
    } finally {
      match.mockRestore();
    }
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

  test.for([
    { entries: ["**/.env*", "!**/.env.local"], files: [".env"] },
    { entries: ["!*.local"], files: [] },
    { entries: ["**/.env*", "!.env.local"], files: [".env"] },
    { entries: ["config/../.env"], files: [".env"] },
    {
      entries: ["**/.env*", "!**/.env.local", ".env.local"],
      files: [".env", ".env.local"],
    },
    {
      entries: ["**/*", "!node_modules/", "!dist/", "!cache/"],
      files: [".env", ".env.local"],
    },
    {
      entries: ["**/*", "!node_modules", "!dist*", "!cache"],
      files: [".env", ".env.local"],
    },
    {
      entries: ["**/*", "!**/node_modules", "!**/dist", "!**/cache"],
      files: [".env", ".env.local"],
    },
  ])(
    "applies ordered copy rules $entries without adding unrelated files",
    async ({ entries, files }, { sourceDir, targetDir, includeRepo }) => {
      await includeRepo.git("add", "--force", ".gitignore");
      await Bun.write(join(sourceDir, ".env"), "keep");
      await Bun.write(join(sourceDir, ".env.local"), "skip");
      await includeRepo.write("node_modules/pkg/large.js", "unrelated");
      await includeRepo.write("dist/bundle.js", "unrelated");
      await includeRepo.write("cache/data", "unrelated");
      const results = await runEffect(
        copyEntries(entries, sourceDir, targetDir),
      );
      expect(results.map((result) => result.file).sort()).toEqual(files);
      expect(results.every((result) => result.success)).toBe(true);
      for (const file of [
        "node_modules/pkg/large.js",
        "dist/bundle.js",
        "cache/data",
      ])
        expect(await Bun.file(join(targetDir, file)).exists()).toBe(false);
    },
  );

  test("uses one syntax for character classes, brace alternatives, and escaped exclusions", async ({
    sourceDir,
    targetDir,
    includeRepo,
  }) => {
    for (const file of [
      "config/app1.env",
      "config/app2.env",
      "config/appA.env",
      "literal[1].env",
    ])
      await includeRepo.write(file, "content");
    const results = await runEffect(
      copyEntries(
        [
          "config/app[0-9].env",
          "!config/app{2,3}.env",
          "literal\\[1\\].env",
          "!literal\\[1\\].env",
        ],
        sourceDir,
        targetDir,
      ),
    );
    expect(results).toEqual([{ file: "config/app1.env", success: true }]);
  });

  test("excludes globbed directories and copies literal leading markers and backslashes", async ({
    sourceDir,
    targetDir,
    includeRepo,
  }) => {
    await includeRepo.git("add", "--force", ".gitignore");
    for (const file of [
      "secrets/token",
      "config/secrets/nested/token",
      "config/cache/data",
      "config/keep",
      "!important.local",
      "back\\slash.env",
    ])
      await includeRepo.write(file, "content");
    const results = await runEffect(
      copyEntries(
        [
          "**/*",
          "!**/secrets/",
          "!*/cache/",
          "!\\!important.local",
          "\\!important.local",
          "back\\slash.env",
        ],
        sourceDir,
        targetDir,
      ),
    );
    expect(results.map((result) => result.file).sort()).toEqual([
      "!important.local",
      "back\\slash.env",
      "config/keep",
    ]);
    expect(results.every((result) => result.success)).toBe(true);
  });

  test("looks up plain file entries without iterating the ignored-file set", () => {
    const candidates = new Set([".env"]);
    candidates[Symbol.iterator] = () => {
      throw new Error("Literal lookup must not scan candidates");
    };
    expect(expandEntry(parseEntry("config/../.env"), candidates)).toEqual([
      ".env",
    ]);
    expect(expandEntry(parseEntry("missing.env"), candidates)).toEqual([]);
  });

  test.for([
    {
      exclude: "!settings.local.json",
      files: [".claude/keep.json", ".claude/settings.local.json"],
      warned: true,
    },
    {
      exclude: "!**/settings.local.json",
      files: [".claude/keep.json"],
      warned: false,
    },
    {
      exclude: "!config/../.claude/*.local.json",
      files: [".claude/keep.json"],
      warned: false,
    },
    {
      exclude: "!missing/",
      files: [".claude/keep.json", ".claude/settings.local.json"],
      warned: true,
    },
    {
      exclude: "!**/*.missing",
      files: [".claude/keep.json", ".claude/settings.local.json"],
      warned: true,
    },
  ])(
    "reports no-op exclusions while keeping root-relative matching: $exclude",
    async (
      { exclude, files, warned },
      { sourceDir, targetDir, includeRepo },
    ) => {
      await includeRepo.write(".claude/keep.json", "keep");
      await includeRepo.write(".claude/settings.local.json", "local");
      const notices: Array<{ entry: string; reason: string }> = [];
      const results = await runEffect(
        copyEntries([".claude/", exclude], sourceDir, targetDir, {
          entrySkipped: (notice) =>
            Effect.sync(() => {
              notices.push(notice);
            }),
        }),
      );
      expect(results.map((result) => result.file).sort()).toEqual(files);
      expect(notices).toEqual(
        warned ? [{ entry: exclude, reason: "exclusion_no_matches" }] : [],
      );
    },
  );

  test("orders missing-file results and reports by selection despite concurrent inspection", async ({
    sourceDir,
    targetDir,
    includeRepo,
  }) => {
    for (const file of ["first.env", "keep.env", "second.env"])
      await includeRepo.write(file, "content");
    const events: string[] = [];
    const results = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const secondInspected = yield* Deferred.make<void>();
        return yield* copyEntries(
          ["first.env", "keep.env", "second.env"],
          sourceDir,
          targetDir,
          {
            entryFailed: ({ file }) =>
              Effect.sync(() => {
                events.push(file);
              }),
          },
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            lstat: (path) => {
              if (path.endsWith("keep.env")) return fs.lstat(path);
              const missing = fs
                .remove(path)
                .pipe(Effect.andThen(fs.lstat(path)));
              return path.endsWith("first.env")
                ? Deferred.await(secondInspected).pipe(Effect.andThen(missing))
                : missing.pipe(
                    Effect.onExit(() =>
                      Deferred.succeed(secondInspected, undefined),
                    ),
                  );
            },
            open: (path, options) =>
              fs.open(path, options).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (path === join(targetDir, "keep.env"))
                      events.push("copy:keep.env");
                  }),
                ),
              ),
          }),
        );
      }),
    );
    expect(results).toEqual([
      { file: "first.env", success: false, error: "File not found" },
      { file: "keep.env", success: true },
      { file: "second.env", success: false, error: "File not found" },
    ]);
    expect(events).toEqual(["first.env", "copy:keep.env", "second.env"]);
  });

  test("reports a source removed after inspection without an existence precheck", async ({
    sourceDir,
    targetDir,
    includeRepo,
  }) => {
    await includeRepo.write("vanished.env", "gone");
    await includeRepo.write("keep.env", "keep");
    const results = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* copyEntries(
          ["vanished.env", "keep.env"],
          sourceDir,
          targetDir,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            exists: () =>
              Effect.die(
                new Error("Copying must not check existence separately"),
              ),
            open: (path, options) =>
              path === join(sourceDir, "vanished.env")
                ? fs.remove(path).pipe(Effect.andThen(fs.open(path, options)))
                : fs.open(path, options),
          }),
        );
      }),
    );
    expect(results).toEqual([
      { file: "vanished.env", success: false, error: "File not found" },
      { file: "keep.env", success: true },
    ]);
    expect(await Bun.file(join(targetDir, "vanished.env")).exists()).toBe(
      false,
    );
  });

  test("selects from Git's file list without filesystem glob or directory reads", async ({
    sourceDir,
    targetDir,
    includeRepo,
  }) => {
    await includeRepo.write(".env", "keep");
    await includeRepo.write("secrets/secret.env", "unselected");
    const results = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const forbiddenWalk = () =>
          Effect.die(new Error("Copy selection must not walk the filesystem"));
        return yield* copyEntries(
          ["secrets/missing*", ".env"],
          sourceDir,
          targetDir,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            glob: forbiddenWalk,
            stat: forbiddenWalk,
            readDirectory: forbiddenWalk,
            readDirectoryEntries: forbiddenWalk,
          }),
        );
      }),
    );
    expect(results).toEqual([{ file: ".env", success: true }]);
  });

  test("filters absolute and ineligible candidates before inspecting each ignored file once", async ({
    sourceDir,
    targetDir,
    includeRepo,
  }) => {
    await includeRepo.write(".gitignore", "*.env\n");
    await includeRepo.write("keep.env", "keep");
    await includeRepo.write("vanished.env", "gone");
    await includeRepo.write("nonignored.json", "skip");
    const inspected: string[] = [];
    const failures: string[] = [];
    const results = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* copyEntries(
          [join(sourceDir, "*.env"), "**/*", "*.env"],
          sourceDir,
          targetDir,
          {
            entryFailed: (failure) =>
              Effect.sync(() => {
                failures.push(failure.reason);
              }),
          },
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            lstat: (path) =>
              Effect.gen(function* () {
                inspected.push(path);
                if (path === join(sourceDir, "vanished.env"))
                  yield* fs.remove(path);
                return yield* fs.lstat(path);
              }),
          }),
        );
      }),
    );
    expect(results).toEqual([
      { file: "keep.env", success: true },
      { file: "vanished.env", success: false, error: "File not found" },
    ]);
    expect(failures).toEqual(["source_not_found"]);
    expect(inspected.sort()).toEqual(
      [join(sourceDir, "keep.env"), join(sourceDir, "vanished.env")].sort(),
    );
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

  test("YAML copy globs reach wholly ignored directories", async ({
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

test.for([[], ["!*.local", "!cache/"]])(
  "skips Git discovery for exclusion-only copy lists: %s",
  async (entries, { tempDir }) => {
    const notices: string[] = [];
    const results = await runEffect(
      copyEntries(entries, tempDir, join(tempDir, "target"), {
        entrySkipped: ({ entry }) =>
          Effect.sync(() => {
            notices.push(entry);
          }),
      }),
    );
    expect(results).toEqual([]);
    expect(notices).toEqual(entries);
  },
);

describe("bounded Workspace file copying", () => {
  test("copies binary chunks and truncates existing targets while retaining destination permissions", async ({
    tempDir,
  }) => {
    const sourceDir = join(tempDir, "source");
    const targetDir = join(tempDir, "target");
    await mkdir(sourceDir);
    await mkdir(targetDir);
    const bytes = new Uint8Array(1024 * 1024 + 257);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const source = join(sourceDir, "binary");
    const target = join(targetDir, "binary");
    await Bun.write(source, bytes);
    await chmod(source, 0o600);
    await utimes(source, 946684800, 946684800);
    await Bun.write(target, new Uint8Array(bytes.length + 100));
    await chmod(target, 0o640);
    expect(
      await runEffect(copyFiles(["binary"], sourceDir, targetDir)),
    ).toEqual([{ file: "binary", success: true }]);
    expect(
      Buffer.from(await Bun.file(target).arrayBuffer()).equals(bytes),
    ).toBe(true);
    const info = await stat(target);
    expect(info.mode & 0o777).toBe(0o640);
    expect(info.mtimeMs).toBeGreaterThan(946684800000);
    await rm(target);
    expect(
      await runEffect(copyFiles(["binary"], sourceDir, targetDir)),
    ).toEqual([{ file: "binary", success: true }]);
    const reference = join(targetDir, "creation-mode");
    await runBunPromise(
      FileSystem.FileSystem.use((fs) => fs.writeFile(reference, bytes)),
    );
    expect((await stat(target)).mode & 0o777).toBe(
      (await stat(reference)).mode & 0o777,
    );
    expect(
      Buffer.from(await Bun.file(target).arrayBuffer()).equals(bytes),
    ).toBe(true);
  });
});

test("cancelled partial copies release both handles without reporting success", async ({
  tempDir,
}) => {
  const sourceDir = join(tempDir, "source");
  const targetDir = join(tempDir, "target");
  await mkdir(sourceDir);
  await mkdir(targetDir);
  await Bun.write(
    join(sourceDir, "large"),
    new Uint8Array(2 * 1024 * 1024).fill(7),
  );
  await runBunPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const reading = yield* Deferred.make<void>();
        let reads = 0;
        let released = 0;
        let completed = false;
        const override = {
          ...fs,
          open: (path: string, options?: Parameters<typeof fs.open>[1]) =>
            fs.open(path, options).pipe(
              Effect.tap(() =>
                Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    released++;
                  }),
                ),
              ),
              Effect.map((handle) =>
                path === join(sourceDir, "large")
                  ? {
                      ...handle,
                      stat: handle.stat,
                      read: (buffer: Uint8Array) =>
                        Effect.suspend(() =>
                          ++reads === 1
                            ? handle.read(buffer)
                            : Deferred.succeed(reading, undefined).pipe(
                                Effect.andThen(Effect.never),
                              ),
                        ),
                    }
                  : handle,
              ),
            ),
        };
        const fiber = yield* Effect.forkChild(
          copyFiles(["large"], sourceDir, targetDir).pipe(
            Effect.provideService(FileSystem.FileSystem, override),
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true;
              }),
            ),
          ),
        );
        yield* Effect.raceFirst(Deferred.await(reading), Fiber.join(fiber));
        yield* Fiber.interrupt(fiber);
        expect(released).toBe(2);
        expect(completed).toBe(false);
      }),
    ),
  );
  expect((await stat(join(targetDir, "large"))).size).toBe(1024 * 1024);
});

test.for(["same path", "hard link", "symlink"] as const)(
  "copying to the source through %s preserves its contents",
  async (alias, { tempDir }) => {
    const sourceDir = join(tempDir, "source");
    const targetDir =
      alias === "same path" ? sourceDir : join(tempDir, "target");
    await mkdir(sourceDir);
    if (targetDir !== sourceDir) await mkdir(targetDir);
    const source = join(sourceDir, "file");
    const target = join(targetDir, "file");
    const content = "source data must survive copying";
    await Bun.write(source, content);
    if (alias === "hard link") await link(source, target);
    if (alias === "symlink") await symlink(source, target);
    expect(await runEffect(copyFiles(["file"], sourceDir, targetDir))).toEqual([
      { file: "file", success: true },
    ]);
    expect(await Bun.file(source).text()).toBe(content);
    expect(await Bun.file(target).text()).toBe(content);
  },
);
