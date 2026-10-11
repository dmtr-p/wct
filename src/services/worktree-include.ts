import { join } from "node:path";
import { Effect, FileSystem, Stream } from "effect";
import { commandError } from "../errors";
import { discoverIgnoredFiles, filterRegularFiles } from "./ignored-files";
import { execProcess, runProcess } from "./process";

const INCLUDE_FILENAME = ".worktreeinclude";

function escapeLeadingMarker(pattern: string): string {
  return pattern.startsWith("#") || pattern.startsWith("!")
    ? `\\${pattern}`
    : pattern;
}

function checkIgnore(
  paths: ReadonlyArray<string>,
  cwd: string,
  gitArgs: ReadonlyArray<string> = [],
) {
  return Effect.gen(function* () {
    if (paths.length === 0) return new Set<string>();
    const result = yield* runProcess(
      "git",
      [...gitArgs, "check-ignore", "--no-index", "--stdin", "-z", "--verbose"],
      {
        cwd,
        stdin: Stream.succeed(
          new TextEncoder().encode(`${paths.join("\0")}\0`),
        ),
      },
    );
    // check-ignore uses 1 for a successful query with no matches.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return yield* Effect.fail(
        new Error(result.stderr || "Git include matching failed"),
      );
    }
    const fields = result.stdout.split("\0");
    const matches = new Set<string>();
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const pattern = fields[i + 2];
      const path = fields[i + 3];
      if (pattern && !pattern.startsWith("!") && path) matches.add(path);
    }
    return matches;
  });
}

/** Undefined means absent; an empty result still overrides global copy. */
export function resolveWorktreeInclude(mainRepoPath: string) {
  const includePath = join(mainRepoPath, INCLUDE_FILENAME);
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const content = yield* Effect.catch(
        fs.readFileString(includePath),
        (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(undefined)
            : Effect.fail(error),
      );
      if (content === undefined) return undefined;

      const rules = content
        .split(/\r?\n/)
        .filter((line) => line.length > 0 && !line.startsWith("#"));
      if (rules.length === 0) return [];

      const candidates = yield* discoverIgnoredFiles(mainRepoPath);
      if (candidates.length === 0) return [];

      // A temporary repository isolates include matching from the source's
      // ignore rules; core.excludesFile below disables global ignores.
      const scratch = yield* fs.makeTempDirectoryScoped({
        prefix: "wct-include-",
      });
      yield* execProcess("git", ["init", "--quiet", "--template=", scratch]);
      const excludePath = join(scratch, ".git", "info", "exclude");
      yield* fs.makeDirectory(join(scratch, ".git", "info"), {
        recursive: true,
      });

      const matchPaths = (patterns: string, paths: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          if (paths.length === 0) return new Set<string>();
          yield* fs.writeFileString(excludePath, `${patterns}\n`);
          return yield* checkIgnore(paths, scratch, [
            "--git-dir",
            join(scratch, ".git"),
            "--work-tree",
            scratch,
            "-c",
            "core.excludesFile=",
          ]);
        });

      const selected = new Set<string>();
      for (const rule of rules) {
        const negate = rule.startsWith("!");
        const pattern = negate ? escapeLeadingMarker(rule.slice(1)) : rule;
        if (!pattern) continue;
        const matches = yield* matchPaths(pattern, candidates);
        let blockedDirectories: string[] = [];
        if (pattern.startsWith("**/") && matches.size > 0) {
          const ancestors = new Set<string>();
          for (const path of matches) {
            const parts = path.split("/");
            for (let i = 1; i < parts.length; i++) {
              ancestors.add(`${parts.slice(0, i).join("/")}/`);
            }
          }
          // Query matched paths' directories themselves: ignoring all their
          // current files is not the same as ignoring the whole directory.
          const ignoredDirectories = [
            ...(yield* checkIgnore([...ancestors], mainRepoPath)),
          ];
          const firstName = pattern.slice(3).split("/")[0];
          // Preserve leading # and ! as literals in the standalone directory rule.
          const directoryPattern = escapeLeadingMarker(`${firstName}/`);
          const reachable = yield* matchPaths(
            `${pattern}\n${directoryPattern}`,
            ignoredDirectories,
          );
          blockedDirectories = ignoredDirectories.filter(
            (dir) => !reachable.has(dir),
          );
        }

        for (const path of matches) {
          if (blockedDirectories.some((dir) => path.startsWith(dir))) continue;
          if (negate) selected.delete(path);
          else selected.add(path);
        }
      }
      return yield* filterRegularFiles([...selected], mainRepoPath);
    }),
  ).pipe(
    Effect.mapError((error) =>
      commandError(
        "worktree_error",
        `Failed to resolve ${includePath}: ${error instanceof Error ? error.message : String(error)}`,
        error,
      ),
    ),
  );
}
