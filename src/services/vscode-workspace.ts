import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { access, cp, mkdir, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as logger from "../utils/logger";

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

interface ISerializedEditorInput {
  id: string;
  value: string;
}

interface ISerializedEditorGroupModel {
  editors?: ISerializedEditorInput[];
  mru?: number[];
  preview?: number;
  sticky?: number;
}

interface ISerializedNode {
  type: string;
  data: ISerializedEditorGroupModel | ISerializedNode[];
  size?: number;
}

async function filterEditorsInState(
  state: Record<string, unknown>,
): Promise<number> {
  let totalRemoved = 0;

  async function walkNode(node: ISerializedNode): Promise<void> {
    if (node.type === "branch") {
      for (const child of node.data as ISerializedNode[]) {
        await walkNode(child);
      }
      return;
    }

    if (node.type !== "leaf") return;

    const group = node.data as ISerializedEditorGroupModel;
    const editors = group.editors ?? [];
    const keepIndices: number[] = [];

    for (let i = 0; i < editors.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: <key> is guaranteed by the loop condition
      const editor = editors[i]!;
      if (editor.id !== "workbench.editors.files.fileEditorInput") {
        keepIndices.push(i);
        continue;
      }

      let filePath: string | undefined;
      try {
        filePath = JSON.parse(editor.value)?.resourceJSON?.path;
      } catch {
        keepIndices.push(i);
        continue;
      }

      if (!filePath) {
        keepIndices.push(i);
        continue;
      }

      try {
        await access(filePath);
        keepIndices.push(i);
      } catch {
        // File does not exist in the worktree — remove this editor
      }
    }

    const removed = editors.length - keepIndices.length;
    totalRemoved += removed;

    if (removed === 0) return;

    const oldToNew = new Map<number, number>();
    keepIndices.forEach((oldIdx, newIdx) => {
      oldToNew.set(oldIdx, newIdx);
    });

    // biome-ignore lint/style/noNonNullAssertion: keepIndices contains valid indices from editors
    group.editors = keepIndices.map((i) => editors[i]!);

    if (group.mru) {
      group.mru = group.mru
        .filter((i: number) => oldToNew.has(i))
        .map((i: number) => oldToNew.get(i) ?? 0);
    }

    if (group.preview !== undefined) {
      group.preview = oldToNew.has(group.preview)
        ? oldToNew.get(group.preview)
        : undefined;
    }

    if (group.sticky !== undefined) {
      let newSticky = 0;
      for (let i = 0; i < group.sticky; i++) {
        if (oldToNew.has(i)) newSticky++;
      }
      group.sticky = newSticky;
    }
  }

  if (state.serializedGrid) {
    const grid = state.serializedGrid as { root?: ISerializedNode };
    if (grid.root) {
      await walkNode(grid.root);
    }
  }

  return totalRemoved;
}

export async function filterMissingEditors(
  dbPath: string,
  _worktreePath: string,
): Promise<number> {
  try {
    const db = new Database(dbPath);
    try {
      let totalRemoved = 0;

      // Try top-level editorpart.state (older VS Code versions)
      const topRow = db
        .query("SELECT value FROM ItemTable WHERE key = ?")
        .get("editorpart.state") as { value: string | Buffer } | null;

      if (topRow) {
        const text =
          typeof topRow.value === "string"
            ? topRow.value
            : Buffer.from(topRow.value).toString("utf-8");
        const state = JSON.parse(text);
        const removed = await filterEditorsInState(state);
        totalRemoved += removed;
        if (removed > 0) {
          db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run(
            JSON.stringify(state),
            "editorpart.state",
          );
        }
      }

      // Try memento/workbench.parts.editor (newer VS Code versions)
      const memoRow = db
        .query("SELECT value FROM ItemTable WHERE key = ?")
        .get("memento/workbench.parts.editor") as {
        value: string | Buffer;
      } | null;

      if (memoRow) {
        const text =
          typeof memoRow.value === "string"
            ? memoRow.value
            : Buffer.from(memoRow.value).toString("utf-8");
        const memento = JSON.parse(text);
        const editorState = memento["editorpart.state"];
        if (editorState?.serializedGrid) {
          const removed = await filterEditorsInState(editorState);
          totalRemoved += removed;
          if (removed > 0) {
            db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run(
              JSON.stringify(memento),
              "memento/workbench.parts.editor",
            );
          }
        }
      }

      return totalRemoved;
    } finally {
      db.close();
    }
  } catch (err) {
    logger.warn(
      `Failed to filter missing editors in VS Code state DB '${dbPath}': ${String(err)}`,
    );
    return 0;
  }
}

const TERMINAL_KEYS_TO_CLEAR = [
  "terminal",
  "terminal.integrated.layoutInfo",
  "terminal.numberOfVisibleViews",
];

export function clearTerminalState(dbPath: string): number {
  try {
    const db = new Database(dbPath);
    try {
      const placeholders = TERMINAL_KEYS_TO_CLEAR.map(() => "?").join(", ");
      const result = db
        .prepare(`DELETE FROM ItemTable WHERE key IN (${placeholders})`)
        .run(...TERMINAL_KEYS_TO_CLEAR);
      return result.changes;
    } finally {
      db.close();
    }
  } catch (err) {
    logger.warn(
      `Failed to clear terminal state in VS Code state DB '${dbPath}': ${String(err)}`,
    );
    return 0;
  }
}

const AGENT_SESSION_KEYS_TO_CLEAR = [
  "agentSessions.state.cache",
  "agentSessions.readDateBaseline2",
];

export function clearExternalAgentSessions(dbPath: string): number {
  try {
    const db = new Database(dbPath);
    try {
      // Delete agent session state that references stale SSE ports
      const placeholders = AGENT_SESSION_KEYS_TO_CLEAR.map(() => "?").join(
        ", ",
      );
      const deleteResult = db
        .prepare(`DELETE FROM ItemTable WHERE key IN (${placeholders})`)
        .run(...AGENT_SESSION_KEYS_TO_CLEAR);

      // Remove external sessions (e.g. Claude Code) from the chat session index
      const row = db
        .query("SELECT value FROM ItemTable WHERE key = ?")
        .get("chat.ChatSessionStore.index") as {
        value: string | Buffer;
      } | null;

      if (!row) return deleteResult.changes;

      const text =
        typeof row.value === "string"
          ? row.value
          : Buffer.from(row.value).toString("utf-8");
      const data = JSON.parse(text);

      let removed = 0;
      if (data.entries) {
        for (const [id, entry] of Object.entries(
          data.entries as Record<string, { isExternal?: boolean }>,
        )) {
          if (entry.isExternal) {
            delete data.entries[id];
            removed++;
          }
        }
      }

      if (removed > 0) {
        db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run(
          JSON.stringify(data),
          "chat.ChatSessionStore.index",
        );
      }

      return deleteResult.changes + removed;
    } finally {
      db.close();
    }
  } catch (err) {
    logger.warn(
      `Failed to clear external agent sessions in VS Code state DB '${dbPath}': ${String(err)}`,
    );
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
      await filterMissingEditors(dbFile, worktreePath);
      clearTerminalState(dbFile);
      clearExternalAgentSessions(dbFile);
    }

    const backupDbFile = join(
      storagePath,
      worktreeWorkspaceId,
      "state.vscdb.backup",
    );
    if (await Bun.file(backupDbFile).exists()) {
      rewriteStatePaths(backupDbFile, mainRepoPath, worktreePath);
      await filterMissingEditors(backupDbFile, worktreePath);
      clearTerminalState(backupDbFile);
      clearExternalAgentSessions(backupDbFile);
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
