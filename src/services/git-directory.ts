import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

function absent(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Follow Git's .git/gitdir/commondir layout, including bare Main Repositories. */
export function gitCommonDirectory(mainRepoPath: string): string {
  const entry = join(mainRepoPath, ".git");
  let directory: string;
  try {
    const stat = lstatSync(entry);
    if (stat.isDirectory()) directory = entry;
    else {
      const pointer = readFileSync(entry, "utf8");
      if (!pointer.startsWith("gitdir: "))
        throw new Error("Invalid Git directory pointer");
      directory = resolve(mainRepoPath, pointer.slice(8).trim());
    }
  } catch (error) {
    if (!absent(error)) throw error;
    // Bare repositories contain their metadata directly. Nonexistent fixture
    // paths have no registration; callers still verify the actual target.
    try {
      lstatSync(join(mainRepoPath, "HEAD"));
      directory = mainRepoPath;
    } catch (error) {
      if (!absent(error)) throw error;
      return entry;
    }
  }
  try {
    directory = resolve(
      directory,
      readFileSync(join(directory, "commondir"), "utf8").trim(),
    );
  } catch (error) {
    if (!absent(error)) throw error;
  }
  return realpathSync(directory);
}
