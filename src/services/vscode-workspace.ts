import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { access, cp, mkdir, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface SyncResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
  mainWorkspaceId?: string;
  worktreeWorkspaceId?: string;
}

export function getVSCodeStoragePath(): string | null {
  if (process.env.WCT_VSCODE_STORAGE_PATH) {
    return process.env.WCT_VSCODE_STORAGE_PATH;
  }
  const p = platform();
  if (p === "darwin") {
    return join(
      homedir(),
      "Library/Application Support/Code/User/workspaceStorage",
    );
  }
  if (p === "linux") {
    return join(homedir(), ".config/Code/User/workspaceStorage");
  }
  return null;
}

export async function computeWorkspaceId(folderPath: string): Promise<string> {
  const stats = await stat(folderPath, { bigint: true });

  let ctime: string;
  const p = platform();
  if (p === "linux") {
    ctime = String(stats.ino);
  } else if (p === "darwin") {
    // Bun truncates birthtimeMs to integer, losing sub-ms precision.
    // Use birthtimeNs with bigint and round manually to match Node.js/VS Code.
    // This is a Bun-specific workaround to match Node.js/VS Code ctime behavior.
    const ns = stats.birthtimeNs;
    const sec = ns / 1_000_000_000n;
    const nsec = ns % 1_000_000_000n;
    ctime = String(Number(sec) * 1000 + Math.round(Number(nsec) / 1_000_000));
  } else {
    throw new Error(`Unsupported platform: ${p}`);
  }

  return createHash("md5").update(folderPath).update(ctime).digest("hex");
}

export async function workspaceExists(workspaceId: string): Promise<boolean> {
  const storagePath = getVSCodeStoragePath();
  if (!storagePath) return false;

  try {
    await access(join(storagePath, workspaceId));
    return true;
  } catch {
    return false;
  }
}

export async function copyWorkspaceStorage(
  sourceId: string,
  targetId: string,
): Promise<void> {
  const storagePath = getVSCodeStoragePath();
  if (!storagePath) {
    throw new Error("VS Code storage path not found");
  }

  const sourcePath = join(storagePath, sourceId);
  const targetPath = join(storagePath, targetId);

  await mkdir(targetPath, { recursive: true });

  await cp(sourcePath, targetPath, {
    recursive: true,
    force: true,
    filter: (src) => src !== join(sourcePath, "workspace.json"),
  });
}

export async function createWorkspaceJson(
  workspaceId: string,
  folderPath: string,
): Promise<void> {
  const storagePath = getVSCodeStoragePath();
  if (!storagePath) return;

  const workspaceJsonPath = join(storagePath, workspaceId, "workspace.json");
  await Bun.write(
    workspaceJsonPath,
    JSON.stringify({ folder: pathToFileURL(folderPath).href }),
  );
}

export function rewriteStatePaths(
  dbPath: string,
  oldPath: string,
  newPath: string,
): number {
  try {
    const db = new Database(dbPath);
    try {
      // Note: Windows paths use backslashes, but this is not an issue as
      // getVSCodeStoragePath() returns null on Windows (unsupported platform).
      const encodedOld = oldPath.replaceAll("/", "%2F");
      const encodedNew = newPath.replaceAll("/", "%2F");

      const rows = db
        .query(
          "SELECT key, value FROM ItemTable WHERE value LIKE ? OR value LIKE ?",
        )
        .all(`%${oldPath}%`, `%${encodedOld}%`) as {
        key: string;
        value: string | Buffer;
      }[];
      const update = db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?");

      let count = 0;
      for (const row of rows) {
        const text =
          typeof row.value === "string"
            ? row.value
            : Buffer.from(row.value).toString("utf-8");

        const replaced = text
          .replaceAll(oldPath, newPath)
          .replaceAll(encodedOld, encodedNew);
        update.run(replaced, row.key);
        count++;
      }

      return count;
    } finally {
      db.close();
    }
  } catch {
    // Database file may be corrupted, locked, or missing ItemTable.
    // Return 0 to indicate no paths were rewritten.
    return 0;
  }
}

export async function syncWorkspaceState(
  mainRepoPath: string,
  worktreePath: string,
): Promise<SyncResult> {
  try {
    const storagePath = getVSCodeStoragePath();
    if (!storagePath) {
      return { success: false, error: "Unsupported platform" };
    }

    const mainWorkspaceId = await computeWorkspaceId(mainRepoPath);

    const mainExists = await workspaceExists(mainWorkspaceId);
    if (!mainExists) {
      return {
        success: false,
        error:
          "Main repo workspace storage not found. Open main repo in VS Code first.",
      };
    }

    const worktreeWorkspaceId = await computeWorkspaceId(worktreePath);

    const alreadyExists = await workspaceExists(worktreeWorkspaceId);
    if (alreadyExists) {
      return {
        success: true,
        skipped: true,
        mainWorkspaceId,
        worktreeWorkspaceId,
      };
    }

    await copyWorkspaceStorage(mainWorkspaceId, worktreeWorkspaceId);
    await createWorkspaceJson(worktreeWorkspaceId, worktreePath);

    const dbFile = join(storagePath, worktreeWorkspaceId, "state.vscdb");
    if (await Bun.file(dbFile).exists()) {
      rewriteStatePaths(dbFile, mainRepoPath, worktreePath);
    }

    const backupDbFile = join(
      storagePath,
      worktreeWorkspaceId,
      "state.vscdb.backup",
    );
    if (await Bun.file(backupDbFile).exists()) {
      rewriteStatePaths(backupDbFile, mainRepoPath, worktreePath);
    }

    return {
      success: true,
      mainWorkspaceId,
      worktreeWorkspaceId,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
