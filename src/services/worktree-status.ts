import { Effect } from "effect";
import type { WctError } from "../errors";
import * as logger from "../utils/logger";
import { execProcess } from "./process";

export function getChangedFilesCount(worktreePath: string) {
  return Effect.catch(
    execProcess("git", ["status", "--porcelain"], {
      cwd: worktreePath,
    }).pipe(
      Effect.map((result) => {
        const output = result.stdout.trim();
        if (!output) return 0;
        return output.split("\n").length;
      }),
    ),
    (error) =>
      logger
        .warn(
          `Failed to get changes for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .pipe(Effect.as(0)),
  );
}

export function getDefaultBranch(repoPath: string) {
  return Effect.gen(function* () {
    const ref = yield* Effect.catch(
      execProcess("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
        cwd: repoPath,
      }).pipe(Effect.map((result) => result.stdout.trim())),
      () => Effect.succeed(null),
    );
    if (ref) {
      return ref.replace("refs/remotes/origin/", "");
    }

    for (const candidate of ["main", "master"]) {
      const exists = yield* Effect.catch(
        execProcess("git", ["rev-parse", "--verify", candidate], {
          cwd: repoPath,
        }).pipe(Effect.as(true)),
        () => Effect.succeed(false),
      );
      if (exists) {
        return candidate;
      }
    }
    return null;
  });
}

export function getAheadBehind(
  worktreePath: string,
  defaultBranch: string | null,
) {
  if (!defaultBranch) {
    return Effect.succeed(null);
  }

  return Effect.catch(
    execProcess(
      "git",
      ["rev-list", "--left-right", "--count", `HEAD...${defaultBranch}`],
      { cwd: worktreePath },
    ).pipe(
      Effect.map((result) => {
        const [ahead, behind] = result.stdout
          .trim()
          .split(/\s+/)
          .map((n: string) => {
            const parsed = Number.parseInt(n, 10);
            return Number.isNaN(parsed) ? 0 : parsed;
          });
        return { ahead: ahead ?? 0, behind: behind ?? 0 };
      }),
    ),
    (error) =>
      logger
        .warn(
          `Failed to get sync status for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .pipe(Effect.as(null)),
  );
}

export function formatChanges(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

export function formatSync(
  sync: { ahead: number; behind: number } | null,
): string {
  if (!sync) return "?";
  const { ahead, behind } = sync;
  if (ahead === 0 && behind === 0) return "\u2713";
  const parts: string[] = [];
  if (ahead > 0) parts.push(`\u2191${ahead}`);
  if (behind > 0) parts.push(`\u2193${behind}`);
  return parts.join(" ");
}
