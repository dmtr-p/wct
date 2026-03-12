import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Console, Effect, type FileSystem, ServiceMap } from "effect";
import * as logger from "../utils/logger";
import {
  copyPath,
  ensureDirectory,
  isDirectory,
  pathExists,
  removePath,
  statBigint,
  writeText,
} from "./filesystem";

export interface SyncResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
  mainWorkspaceId?: string;
  worktreeWorkspaceId?: string;
}

export interface VSCodeWorkspaceService {
  syncWorkspaceState: (
    mainRepoPath: string,
    worktreePath: string,
  ) => Effect.Effect<
    SyncResult,
    never,
    Console.Console | FileSystem.FileSystem
  >;
}

export const VSCodeWorkspaceService =
  ServiceMap.Service<VSCodeWorkspaceService>("wct/VSCodeWorkspaceService");

const WARN_PREFIX = "\x1b[33mwarn\x1b[0m";

function warnSync(message: string) {
  console.log(`${WARN_PREFIX} ${message}`);
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

export function computeWorkspaceId(folderPath: string) {
  return Effect.gen(function* () {
    const stats = yield* statBigint(folderPath);

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
      return yield* Effect.fail(new Error(`Unsupported platform: ${p}`));
    }

    return createHash("md5").update(folderPath).update(ctime).digest("hex");
  });
}

export function workspaceExists(workspaceId: string) {
  const storagePath = getVSCodeStoragePath();
  if (!storagePath) {
    return Effect.succeed(false);
  }

  return Effect.gen(function* () {
    const workspacePath = join(storagePath, workspaceId);
    const exists = yield* pathExists(workspacePath);
    if (!exists) {
      return false;
    }

    return yield* isDirectory(workspacePath);
  });
}

export function copyWorkspaceStorage(sourceId: string, targetId: string) {
  const storagePath = getVSCodeStoragePath();
  if (!storagePath) {
    return Effect.fail(new Error("VS Code storage path not found"));
  }

  const sourcePath = join(storagePath, sourceId);
  const targetPath = join(storagePath, targetId);

  return Effect.gen(function* () {
    yield* ensureDirectory(targetPath);
    yield* copyPath(sourcePath, targetPath, { overwrite: true });
    yield* removePath(join(targetPath, "workspace.json"), { force: true });
  });
}

export function createWorkspaceJson(workspaceId: string, folderPath: string) {
  const storagePath = getVSCodeStoragePath();
  if (!storagePath) {
    return Effect.void;
  }

  const workspaceJsonPath = join(storagePath, workspaceId, "workspace.json");
  return writeText(
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

function filterEditorsInState(state: Record<string, unknown>) {
  return Effect.gen(function* () {
    let totalRemoved = 0;

    function walkNode(
      node: ISerializedNode,
    ): Effect.Effect<void, never, FileSystem.FileSystem> {
      return Effect.gen(function* () {
        if (node.type === "branch") {
          for (const child of node.data as ISerializedNode[]) {
            yield* walkNode(child);
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

          if (
            yield* Effect.catch(pathExists(filePath), () =>
              Effect.succeed(false),
            )
          ) {
            keepIndices.push(i);
          }
          // File does not exist in the worktree — remove this editor
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
      });
    }

    if (state.serializedGrid) {
      const grid = state.serializedGrid as { root?: ISerializedNode };
      if (grid.root) {
        yield* walkNode(grid.root);
      }
    }

    return totalRemoved;
  });
}

export function filterMissingEditors(dbPath: string, _worktreePath: string) {
  return Effect.gen(function* () {
    try {
      const db = new Database(dbPath);
      try {
        let totalRemoved = 0;

        // Try top-level editorpart.state (older VS Code versions)
        const topRow = db
          .query("SELECT value FROM ItemTable WHERE key = ?")
          .get("editorpart.state") as { value: string | Buffer } | null;

        if (topRow) {
          try {
            const text =
              typeof topRow.value === "string"
                ? topRow.value
                : Buffer.from(topRow.value).toString("utf-8");
            const state = JSON.parse(text);
            const removed = yield* filterEditorsInState(state);
            totalRemoved += removed;
            if (removed > 0) {
              db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run(
                JSON.stringify(state),
                "editorpart.state",
              );
            }
          } catch (err) {
            yield* logger.warn(
              `Failed to process VS Code key 'editorpart.state' in '${dbPath}': ${String(err)}`,
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
          try {
            const text =
              typeof memoRow.value === "string"
                ? memoRow.value
                : Buffer.from(memoRow.value).toString("utf-8");
            const memento = JSON.parse(text);
            const editorState = memento["editorpart.state"];
            if (editorState?.serializedGrid) {
              const removed = yield* filterEditorsInState(editorState);
              totalRemoved += removed;
              if (removed > 0) {
                db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run(
                  JSON.stringify(memento),
                  "memento/workbench.parts.editor",
                );
              }
            }
          } catch (err) {
            yield* logger.warn(
              `Failed to process VS Code key 'memento/workbench.parts.editor' in '${dbPath}': ${String(err)}`,
            );
          }
        }

        return totalRemoved;
      } finally {
        db.close();
      }
    } catch (err) {
      yield* logger.warn(
        `Failed to filter missing editors in VS Code state DB '${dbPath}': ${String(err)}`,
      );
      return 0;
    }
  });
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
    warnSync(
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

      let removed = 0;
      try {
        const text =
          typeof row.value === "string"
            ? row.value
            : Buffer.from(row.value).toString("utf-8");
        const data = JSON.parse(text);

        const externalIds: string[] = [];
        if (data.entries) {
          for (const [id, entry] of Object.entries(
            data.entries as Record<string, { isExternal?: boolean }>,
          )) {
            if (entry.isExternal) {
              externalIds.push(id);
            }
          }
        }

        if (externalIds.length > 0) {
          for (const id of externalIds) {
            delete data.entries[id];
          }
          db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run(
            JSON.stringify(data),
            "chat.ChatSessionStore.index",
          );
          removed = externalIds.length;
        }
      } catch (err) {
        warnSync(
          `Failed to process key 'chat.ChatSessionStore.index' in '${dbPath}': ${String(err)}`,
        );
      }

      return deleteResult.changes + removed;
    } finally {
      db.close();
    }
  } catch (err) {
    warnSync(
      `Failed to clear external agent sessions in VS Code state DB '${dbPath}': ${String(err)}`,
    );
    return 0;
  }
}

function syncWorkspaceStateImpl(
  mainRepoPath: string,
  worktreePath: string,
): Effect.Effect<SyncResult, never, Console.Console | FileSystem.FileSystem> {
  return Effect.catch(
    Effect.gen(function* () {
      const storagePath = getVSCodeStoragePath();
      if (!storagePath) {
        return {
          success: false,
          error: "Unsupported platform",
        } satisfies SyncResult;
      }

      const mainWorkspaceId = yield* computeWorkspaceId(mainRepoPath);

      const mainExists = yield* workspaceExists(mainWorkspaceId);
      if (!mainExists) {
        return {
          success: false,
          error:
            "Main repo workspace storage not found. Open main repo in VS Code first.",
        } satisfies SyncResult;
      }

      const worktreeWorkspaceId = yield* computeWorkspaceId(worktreePath);

      const alreadyExists = yield* workspaceExists(worktreeWorkspaceId);
      if (alreadyExists) {
        return {
          success: true,
          skipped: true,
          mainWorkspaceId,
          worktreeWorkspaceId,
        } satisfies SyncResult;
      }

      yield* copyWorkspaceStorage(mainWorkspaceId, worktreeWorkspaceId);
      yield* createWorkspaceJson(worktreeWorkspaceId, worktreePath);

      const dbFile = join(storagePath, worktreeWorkspaceId, "state.vscdb");
      if (yield* pathExists(dbFile)) {
        rewriteStatePaths(dbFile, mainRepoPath, worktreePath);
        yield* filterMissingEditors(dbFile, worktreePath);
        clearTerminalState(dbFile);
        clearExternalAgentSessions(dbFile);
      }

      const backupDbFile = join(
        storagePath,
        worktreeWorkspaceId,
        "state.vscdb.backup",
      );
      if (yield* pathExists(backupDbFile)) {
        rewriteStatePaths(backupDbFile, mainRepoPath, worktreePath);
        yield* filterMissingEditors(backupDbFile, worktreePath);
        clearTerminalState(backupDbFile);
        clearExternalAgentSessions(backupDbFile);
      }

      return {
        success: true,
        mainWorkspaceId,
        worktreeWorkspaceId,
      } satisfies SyncResult;
    }),
    (err) =>
      Effect.succeed({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies SyncResult),
  );
}

export const liveVSCodeWorkspaceService: VSCodeWorkspaceService =
  VSCodeWorkspaceService.of({
    syncWorkspaceState: (mainRepoPath, worktreePath) =>
      syncWorkspaceStateImpl(mainRepoPath, worktreePath),
  });

export function syncWorkspaceState(mainRepoPath: string, worktreePath: string) {
  return syncWorkspaceStateImpl(mainRepoPath, worktreePath);
}
