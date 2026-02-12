import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { access, cp, mkdir, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface SyncResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
  mainWorkspaceId?: string;
  worktreeWorkspaceId?: string;
}

export function getVSCodeStoragePath(): string | null {
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
    // See docs/bun-birthtime-bug.md
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

export async function findMainRepoWorkspaceId(
  mainRepoPath: string,
): Promise<string | null> {
  const workspaceId = await computeWorkspaceId(mainRepoPath);
  const exists = await workspaceExists(workspaceId);
  return exists ? workspaceId : null;
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
    filter: (src) => !src.endsWith("workspace.json"),
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
    JSON.stringify({ folder: `file://${folderPath}` }),
  );
}

export function rewriteStatePaths(
  dbPath: string,
  oldPath: string,
  newPath: string,
): number {
  const db = new Database(dbPath);
  try {
    const encodedOld = oldPath.replaceAll("/", "%2F");
    const encodedNew = newPath.replaceAll("/", "%2F");

    const rows = db.query("SELECT key, value FROM ItemTable").all() as {
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

      if (!text.includes(oldPath) && !text.includes(encodedOld)) continue;

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

    const worktreeExists_ = await workspaceExists(worktreeWorkspaceId);
    if (worktreeExists_) {
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
    rewriteStatePaths(dbFile, mainRepoPath, worktreePath);

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
