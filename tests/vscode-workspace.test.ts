import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeWorkspaceId,
  copyWorkspaceStorage,
  createWorkspaceJson,
  getVSCodeStoragePath,
  rewriteStatePaths,
  syncWorkspaceState,
  workspaceExists,
} from "../src/services/vscode-workspace";

describe("hash algorithm", () => {
  test("MD5 test vector matches VS Code", () => {
    const hash = createHash("md5")
      .update("/hello/test")
      .update("1611312115129")
      .digest("hex");
    expect(hash).toBe("1d726b3d516dc2a6d343abf4797eaaef");
  });
});

describe("getVSCodeStoragePath", () => {
  test("returns a path containing workspaceStorage", () => {
    const path = getVSCodeStoragePath();
    // On macOS/Linux this should return a path; on other platforms null
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(path).not.toBeNull();
      expect(path as string).toContain("workspaceStorage");
    }
  });

  test("returns correct platform-specific path", () => {
    const path = getVSCodeStoragePath();
    if (process.platform === "darwin") {
      expect(path as string).toContain("Library/Application Support/Code");
    } else if (process.platform === "linux") {
      expect(path as string).toContain(".config/Code");
    }
  });
});

describe("computeWorkspaceId", () => {
  test("returns 32-char hex string", async () => {
    const id = await computeWorkspaceId(tmpdir());
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  test("is deterministic for same folder", async () => {
    const id1 = await computeWorkspaceId(tmpdir());
    const id2 = await computeWorkspaceId(tmpdir());
    expect(id1).toBe(id2);
  });

  test("differs for different folders", async () => {
    const dir1 = join(tmpdir(), `wct-test-a-${Date.now()}`);
    const dir2 = join(tmpdir(), `wct-test-b-${Date.now()}`);
    await mkdir(dir1, { recursive: true });
    await mkdir(dir2, { recursive: true });
    try {
      const id1 = await computeWorkspaceId(dir1);
      const id2 = await computeWorkspaceId(dir2);
      expect(id1).not.toBe(id2);
    } finally {
      await rm(dir1, { recursive: true, force: true });
      await rm(dir2, { recursive: true, force: true });
    }
  });

  test("throws for nonexistent path", async () => {
    expect(
      computeWorkspaceId("/nonexistent/path/that/does/not/exist"),
    ).rejects.toThrow();
  });
});

describe("workspaceExists", () => {
  test("returns false for nonexistent workspace", async () => {
    const exists = await workspaceExists("nonexistent-workspace-id-12345");
    expect(exists).toBe(false);
  });

  test("returns true for existing workspace dir", async () => {
    const storagePath = getVSCodeStoragePath();
    if (!storagePath) return; // skip on unsupported platform

    const testId = `wct-test-${Date.now()}`;
    const testDir = join(storagePath, testId);
    await mkdir(testDir, { recursive: true });
    try {
      const exists = await workspaceExists(testId);
      expect(exists).toBe(true);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});

describe("copyWorkspaceStorage", () => {
  const testSourceId = `wct-test-source-${Date.now()}`;
  const testTargetId = `wct-test-target-${Date.now()}`;
  let storagePath: string | null;

  afterEach(async () => {
    storagePath = getVSCodeStoragePath();
    if (!storagePath) return;
    await rm(join(storagePath, testSourceId), {
      recursive: true,
      force: true,
    });
    await rm(join(storagePath, testTargetId), {
      recursive: true,
      force: true,
    });
  });

  test("copies state.vscdb and skips workspace.json", async () => {
    storagePath = getVSCodeStoragePath();
    if (!storagePath) return;

    const sourceDir = join(storagePath, testSourceId);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "state.vscdb"), "fake-db-content");
    await writeFile(
      join(sourceDir, "workspace.json"),
      '{"folder":"file:///old"}',
    );

    await copyWorkspaceStorage(testSourceId, testTargetId);

    const targetDir = join(storagePath, testTargetId);
    const stateFile = Bun.file(join(targetDir, "state.vscdb"));
    expect(await stateFile.exists()).toBe(true);
    expect(await stateFile.text()).toBe("fake-db-content");

    const wsJsonFile = Bun.file(join(targetDir, "workspace.json"));
    expect(await wsJsonFile.exists()).toBe(false);
  });
});

describe("createWorkspaceJson", () => {
  const testId = `wct-test-wsjson-${Date.now()}`;
  let storagePath: string | null;

  afterEach(async () => {
    storagePath = getVSCodeStoragePath();
    if (!storagePath) return;
    await rm(join(storagePath, testId), { recursive: true, force: true });
  });

  test("writes correct folder URI format", async () => {
    storagePath = getVSCodeStoragePath();
    if (!storagePath) return;

    await mkdir(join(storagePath, testId), { recursive: true });
    await createWorkspaceJson(testId, "/Users/test/my-worktree");

    const content = await Bun.file(
      join(storagePath, testId, "workspace.json"),
    ).json();
    expect(content).toEqual({ folder: "file:///Users/test/my-worktree" });
  });
});

describe("rewriteStatePaths", () => {
  let dbPath: string;

  function createTestDb(rows: { key: string; value: string }[]): void {
    const db = new Database(dbPath);
    db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    const insert = db.prepare(
      "INSERT INTO ItemTable (key, value) VALUES (?, ?)",
    );
    for (const row of rows) {
      insert.run(row.key, row.value);
    }
    db.close();
  }

  function readAllRows(): { key: string; value: string }[] {
    const db = new Database(dbPath);
    const rows = db.query("SELECT key, value FROM ItemTable").all() as {
      key: string;
      value: string;
    }[];
    db.close();
    return rows;
  }

  afterEach(async () => {
    if (dbPath) {
      await rm(dbPath, { force: true });
    }
  });

  test("rewrites plain paths", () => {
    dbPath = join(tmpdir(), `wct-test-rewrite-${Date.now()}.vscdb`);
    createTestDb([
      { key: "editor.state", value: '{"uri":"file:///old/repo/src/index.ts"}' },
    ]);

    const count = rewriteStatePaths(dbPath, "/old/repo", "/new/worktree");

    expect(count).toBe(1);
    const rows = readAllRows();
    expect(rows[0].value).toBe('{"uri":"file:///new/worktree/src/index.ts"}');
  });

  test("rewrites URL-encoded paths", () => {
    dbPath = join(tmpdir(), `wct-test-rewrite-enc-${Date.now()}.vscdb`);
    createTestDb([
      {
        key: "git.state",
        value: "git:?path=%2Fold%2Frepo%2Ffile.ts",
      },
    ]);

    const count = rewriteStatePaths(dbPath, "/old/repo", "/new/worktree");

    expect(count).toBe(1);
    const rows = readAllRows();
    expect(rows[0].value).toBe("git:?path=%2Fnew%2Fworktree%2Ffile.ts");
  });

  test("leaves unrelated rows untouched", () => {
    dbPath = join(tmpdir(), `wct-test-rewrite-skip-${Date.now()}.vscdb`);
    createTestDb([{ key: "unrelated", value: '{"setting":"value"}' }]);

    const count = rewriteStatePaths(dbPath, "/old/repo", "/new/worktree");

    expect(count).toBe(0);
    const rows = readAllRows();
    expect(rows[0].value).toBe('{"setting":"value"}');
  });

  test("returns correct count of modified rows", () => {
    dbPath = join(tmpdir(), `wct-test-rewrite-count-${Date.now()}.vscdb`);
    createTestDb([
      { key: "a", value: "file:///old/repo/one.ts" },
      { key: "b", value: "no match here" },
      { key: "c", value: "file:///old/repo/two.ts" },
    ]);

    const count = rewriteStatePaths(dbPath, "/old/repo", "/new/worktree");

    expect(count).toBe(2);
  });
});

describe("syncWorkspaceState", () => {
  test("returns error when main workspace not found", async () => {
    const tmpDir = join(tmpdir(), `wct-test-sync-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    try {
      const result = await syncWorkspaceState(tmpDir, tmpDir);
      // Main workspace won't exist in VS Code storage for a temp dir
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("rewriteStatePaths error handling", () => {
  test("returns 0 for corrupted database file", () => {
    const corruptedDbPath = join(
      tmpdir(),
      `wct-test-corrupt-${Date.now()}.vscdb`,
    );
    // Create a non-database file
    require("node:fs").writeFileSync(
      corruptedDbPath,
      "not a valid sqlite database",
    );

    try {
      const count = rewriteStatePaths(
        corruptedDbPath,
        "/old/path",
        "/new/path",
      );
      expect(count).toBe(0); // Should return 0 instead of throwing
    } finally {
      require("node:fs").unlinkSync(corruptedDbPath);
    }
  });

  test("returns 0 for nonexistent database file", () => {
    const nonexistentPath = join(tmpdir(), `nonexistent-${Date.now()}.vscdb`);
    const count = rewriteStatePaths(nonexistentPath, "/old/path", "/new/path");
    expect(count).toBe(0); // Should return 0 instead of throwing
  });
});
