import { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearExternalAgentSessions,
  clearTerminalState,
  computeWorkspaceId,
  copyWorkspaceStorage,
  createWorkspaceJson,
  filterMissingEditors,
  getVSCodeStoragePath,
  rewriteStatePaths,
  syncWorkspaceState,
  workspaceExists,
} from "../src/services/vscode-workspace";
import { createTestDb, readAllKeys } from "./helpers/sqlite-test-utils";

const testStoragePath = join(tmpdir(), `wct-test-storage-${Date.now()}`);

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
    await expect(
      computeWorkspaceId("/nonexistent/path/that/does/not/exist"),
    ).rejects.toThrow();
  });
});

describe("workspaceExists", () => {
  beforeAll(async () => {
    await mkdir(testStoragePath, { recursive: true });
    process.env.WCT_VSCODE_STORAGE_PATH = testStoragePath;
  });

  afterAll(async () => {
    delete process.env.WCT_VSCODE_STORAGE_PATH;
    await rm(testStoragePath, { recursive: true, force: true });
  });

  test("returns false for nonexistent workspace", async () => {
    const exists = await workspaceExists("nonexistent-workspace-id-12345");
    expect(exists).toBe(false);
  });

  test("returns true for existing workspace dir", async () => {
    const testId = `wct-test-${Date.now()}`;
    const testDir = join(testStoragePath, testId);
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
  const copyStoragePath = join(tmpdir(), `wct-test-copy-storage-${Date.now()}`);
  const testSourceId = `wct-test-source-${Date.now()}`;
  const testTargetId = `wct-test-target-${Date.now()}`;

  beforeAll(async () => {
    await mkdir(copyStoragePath, { recursive: true });
    process.env.WCT_VSCODE_STORAGE_PATH = copyStoragePath;
  });

  afterAll(async () => {
    delete process.env.WCT_VSCODE_STORAGE_PATH;
    await rm(copyStoragePath, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(join(copyStoragePath, testSourceId), {
      recursive: true,
      force: true,
    });
    await rm(join(copyStoragePath, testTargetId), {
      recursive: true,
      force: true,
    });
  });

  test("copies state.vscdb and skips workspace.json", async () => {
    const sourceDir = join(copyStoragePath, testSourceId);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "state.vscdb"), "fake-db-content");
    await writeFile(
      join(sourceDir, "workspace.json"),
      '{"folder":"file:///old"}',
    );

    await copyWorkspaceStorage(testSourceId, testTargetId);

    const targetDir = join(copyStoragePath, testTargetId);
    const stateFile = Bun.file(join(targetDir, "state.vscdb"));
    expect(await stateFile.exists()).toBe(true);
    expect(await stateFile.text()).toBe("fake-db-content");

    const wsJsonFile = Bun.file(join(targetDir, "workspace.json"));
    expect(await wsJsonFile.exists()).toBe(false);
  });
});

describe("createWorkspaceJson", () => {
  const wsJsonStoragePath = join(
    tmpdir(),
    `wct-test-wsjson-storage-${Date.now()}`,
  );
  const testId = `wct-test-wsjson-${Date.now()}`;

  beforeAll(async () => {
    await mkdir(wsJsonStoragePath, { recursive: true });
    process.env.WCT_VSCODE_STORAGE_PATH = wsJsonStoragePath;
  });

  afterAll(async () => {
    delete process.env.WCT_VSCODE_STORAGE_PATH;
    await rm(wsJsonStoragePath, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(join(wsJsonStoragePath, testId), { recursive: true, force: true });
  });

  test("writes correct folder URI format", async () => {
    await mkdir(join(wsJsonStoragePath, testId), { recursive: true });
    await createWorkspaceJson(testId, "/Users/test/my-worktree");

    const content = await Bun.file(
      join(wsJsonStoragePath, testId, "workspace.json"),
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
    writeFileSync(corruptedDbPath, "not a valid sqlite database");

    try {
      const count = rewriteStatePaths(
        corruptedDbPath,
        "/old/path",
        "/new/path",
      );
      expect(count).toBe(0); // Should return 0 instead of throwing
    } finally {
      unlinkSync(corruptedDbPath);
    }
  });

  test("returns 0 for nonexistent database file", () => {
    const nonexistentPath = join(tmpdir(), `nonexistent-${Date.now()}.vscdb`);
    const count = rewriteStatePaths(nonexistentPath, "/old/path", "/new/path");
    expect(count).toBe(0); // Should return 0 instead of throwing
  });
});

describe("filterMissingEditors", () => {
  let dbPath: string;

  function makeFileEditor(filePath: string): { id: string; value: string } {
    return {
      id: "workbench.editors.files.fileEditorInput",
      value: JSON.stringify({ resourceJSON: { path: filePath } }),
    };
  }

  function makeNonFileEditor(): { id: string; value: string } {
    return {
      id: "workbench.editors.git.gitEditor",
      value: JSON.stringify({ some: "data" }),
    };
  }

  function makeLeafState(
    editors: { id: string; value: string }[],
    mru?: number[],
    preview?: number,
    sticky?: number,
  ): object {
    const group: Record<string, unknown> = {
      id: 1,
      editors,
      mru: mru ?? editors.map((_, i) => i),
    };
    if (preview !== undefined) group.preview = preview;
    if (sticky !== undefined) group.sticky = sticky;
    return {
      serializedGrid: {
        root: { type: "leaf", data: group, size: 1 },
        width: 800,
        height: 600,
        orientation: 0,
      },
      activeGroup: 1,
      mostRecentActiveGroups: [1],
    };
  }

  function createEditorPartDb(state: object): void {
    const db = new Database(dbPath);
    db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "editorpart.state",
      JSON.stringify(state),
    );
    db.close();
  }

  function readEditorPartState(): Record<string, unknown> {
    const db = new Database(dbPath);
    const row = db
      .query("SELECT value FROM ItemTable WHERE key = ?")
      .get("editorpart.state") as { value: string };
    db.close();
    return JSON.parse(row.value);
  }

  afterEach(async () => {
    if (dbPath) {
      await rm(dbPath, { force: true });
    }
  });

  test("keeps editors whose files exist", async () => {
    dbPath = join(tmpdir(), `wct-filter-exist-${Date.now()}.vscdb`);
    const tmpFile = join(tmpdir(), `wct-test-exist-${Date.now()}.ts`);
    await writeFile(tmpFile, "");
    try {
      createEditorPartDb(makeLeafState([makeFileEditor(tmpFile)]));
      const count = await filterMissingEditors(dbPath, "/worktree");
      expect(count).toBe(0);
      const state = readEditorPartState();
      const root = (state.serializedGrid as Record<string, unknown>)
        .root as Record<string, unknown>;
      const group = root.data as Record<string, unknown>;
      expect((group.editors as unknown[]).length).toBe(1);
    } finally {
      await rm(tmpFile, { force: true });
    }
  });

  test("removes editors whose files don't exist", async () => {
    dbPath = join(tmpdir(), `wct-filter-missing-${Date.now()}.vscdb`);
    createEditorPartDb(makeLeafState([makeFileEditor("/nonexistent/file.ts")]));
    const count = await filterMissingEditors(dbPath, "/worktree");
    expect(count).toBe(1);
    const state = readEditorPartState();
    const root = (state.serializedGrid as Record<string, unknown>)
      .root as Record<string, unknown>;
    const group = root.data as Record<string, unknown>;
    expect((group.editors as unknown[]).length).toBe(0);
  });

  test("remaps mru indices correctly", async () => {
    dbPath = join(tmpdir(), `wct-filter-mru-${Date.now()}.vscdb`);
    const tmpFile0 = join(tmpdir(), `wct-mru0-${Date.now()}.ts`);
    const tmpFile2 = join(tmpdir(), `wct-mru2-${Date.now()}.ts`);
    await writeFile(tmpFile0, "");
    await writeFile(tmpFile2, "");
    try {
      // Editors: [0=exists, 1=missing, 2=exists]; mru=[2,0,1]
      // After removing index 1: oldToNew={0->0, 2->1}; mru=[1,0]
      createEditorPartDb(
        makeLeafState(
          [
            makeFileEditor(tmpFile0),
            makeFileEditor("/missing.ts"),
            makeFileEditor(tmpFile2),
          ],
          [2, 0, 1],
        ),
      );
      await filterMissingEditors(dbPath, "/worktree");
      const state = readEditorPartState();
      const root = (state.serializedGrid as Record<string, unknown>)
        .root as Record<string, unknown>;
      const group = root.data as Record<string, unknown>;
      expect((group.editors as unknown[]).length).toBe(2);
      expect(group.mru).toEqual([1, 0]);
    } finally {
      await rm(tmpFile0, { force: true });
      await rm(tmpFile2, { force: true });
    }
  });

  test("sets preview to undefined when its editor is removed", async () => {
    dbPath = join(tmpdir(), `wct-filter-prev-rm-${Date.now()}.vscdb`);
    const tmpFile = join(tmpdir(), `wct-prev-rm-${Date.now()}.ts`);
    await writeFile(tmpFile, "");
    try {
      // preview = 1 (the missing file)
      createEditorPartDb(
        makeLeafState(
          [makeFileEditor(tmpFile), makeFileEditor("/missing.ts")],
          [1, 0],
          1,
        ),
      );
      await filterMissingEditors(dbPath, "/worktree");
      const state = readEditorPartState();
      const root = (state.serializedGrid as Record<string, unknown>)
        .root as Record<string, unknown>;
      const group = root.data as Record<string, unknown>;
      expect(group.preview).toBeUndefined();
    } finally {
      await rm(tmpFile, { force: true });
    }
  });

  test("remaps preview index when its editor is kept", async () => {
    dbPath = join(tmpdir(), `wct-filter-prev-remap-${Date.now()}.vscdb`);
    const tmpFile = join(tmpdir(), `wct-prev-remap-${Date.now()}.ts`);
    await writeFile(tmpFile, "");
    try {
      // Editors: [0=missing, 1=missing, 2=kept]; preview=2 → remaps to 0
      createEditorPartDb(
        makeLeafState(
          [
            makeFileEditor("/missing0.ts"),
            makeFileEditor("/missing1.ts"),
            makeFileEditor(tmpFile),
          ],
          [2, 1, 0],
          2,
        ),
      );
      await filterMissingEditors(dbPath, "/worktree");
      const state = readEditorPartState();
      const root = (state.serializedGrid as Record<string, unknown>)
        .root as Record<string, unknown>;
      const group = root.data as Record<string, unknown>;
      expect(group.preview).toBe(0);
    } finally {
      await rm(tmpFile, { force: true });
    }
  });

  test("adjusts sticky count when sticky editors are removed", async () => {
    dbPath = join(tmpdir(), `wct-filter-sticky-${Date.now()}.vscdb`);
    const tmpFile = join(tmpdir(), `wct-sticky-${Date.now()}.ts`);
    await writeFile(tmpFile, "");
    try {
      // sticky=2: editors [0=missing, 1=kept]; first sticky editor removed → sticky=1
      const leafState = makeLeafState(
        [makeFileEditor("/missing.ts"), makeFileEditor(tmpFile)],
        [1, 0],
      ) as Record<string, unknown>;
      const grid = leafState.serializedGrid as Record<string, unknown>;
      const root = grid.root as Record<string, unknown>;
      const group = root.data as Record<string, unknown>;
      group.sticky = 2;
      createEditorPartDb(leafState);
      await filterMissingEditors(dbPath, "/worktree");
      const state = readEditorPartState();
      const resultRoot = (state.serializedGrid as Record<string, unknown>)
        .root as Record<string, unknown>;
      const resultGroup = resultRoot.data as Record<string, unknown>;
      expect(resultGroup.sticky).toBe(1);
    } finally {
      await rm(tmpFile, { force: true });
    }
  });

  test("leaves non-file editors untouched", async () => {
    dbPath = join(tmpdir(), `wct-filter-nonfile-${Date.now()}.vscdb`);
    createEditorPartDb(makeLeafState([makeNonFileEditor()]));
    const count = await filterMissingEditors(dbPath, "/worktree");
    expect(count).toBe(0);
    const state = readEditorPartState();
    const root = (state.serializedGrid as Record<string, unknown>)
      .root as Record<string, unknown>;
    const group = root.data as Record<string, unknown>;
    expect((group.editors as unknown[]).length).toBe(1);
  });

  test("handles split panes (branch node)", async () => {
    dbPath = join(tmpdir(), `wct-filter-branch-${Date.now()}.vscdb`);
    const tmpFile = join(tmpdir(), `wct-branch-${Date.now()}.ts`);
    await writeFile(tmpFile, "");
    try {
      const branchState = {
        serializedGrid: {
          root: {
            type: "branch",
            data: [
              {
                type: "leaf",
                data: { id: 1, editors: [makeFileEditor(tmpFile)], mru: [0] },
                size: 0.5,
              },
              {
                type: "leaf",
                data: {
                  id: 2,
                  editors: [makeFileEditor("/missing.ts")],
                  mru: [0],
                },
                size: 0.5,
              },
            ],
            size: 1,
          },
          width: 800,
          height: 600,
          orientation: 0,
        },
        activeGroup: 1,
        mostRecentActiveGroups: [1, 2],
      };
      createEditorPartDb(branchState);
      const count = await filterMissingEditors(dbPath, "/worktree");
      expect(count).toBe(1);
      const state = readEditorPartState();
      const root = (state.serializedGrid as Record<string, unknown>)
        .root as Record<string, unknown>;
      const leaves = root.data as Record<string, unknown>[];
      expect(
        ((leaves[0].data as Record<string, unknown>).editors as unknown[])
          .length,
      ).toBe(1);
      expect(
        ((leaves[1].data as Record<string, unknown>).editors as unknown[])
          .length,
      ).toBe(0);
    } finally {
      await rm(tmpFile, { force: true });
    }
  });

  test("returns 0 on corrupted database file", async () => {
    dbPath = join(tmpdir(), `wct-filter-corrupt-${Date.now()}.vscdb`);
    await writeFile(dbPath, "not valid sqlite");
    const count = await filterMissingEditors(dbPath, "/worktree");
    expect(count).toBe(0);
  });

  test("returns 0 when no editorpart.state key exists", async () => {
    dbPath = join(tmpdir(), `wct-filter-nokey-${Date.now()}.vscdb`);
    const db = new Database(dbPath);
    db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    db.close();
    const count = await filterMissingEditors(dbPath, "/worktree");
    expect(count).toBe(0);
  });

  test("reads editor state from memento/workbench.parts.editor", async () => {
    dbPath = join(tmpdir(), `wct-filter-memento-${Date.now()}.vscdb`);
    const memento = {
      "editorpart.state": makeLeafState([
        makeFileEditor("/nonexistent/file.ts"),
      ]),
    };
    const db = new Database(dbPath);
    db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "memento/workbench.parts.editor",
      JSON.stringify(memento),
    );
    db.close();

    const count = await filterMissingEditors(dbPath, "/worktree");
    expect(count).toBe(1);

    const db2 = new Database(dbPath);
    const row = db2
      .query("SELECT value FROM ItemTable WHERE key = ?")
      .get("memento/workbench.parts.editor") as { value: string };
    db2.close();
    const result = JSON.parse(row.value);
    const root = result["editorpart.state"].serializedGrid.root;
    expect(root.type).toBe("leaf");
    expect(root.data.editors.length).toBe(0);
  });

  test("filters missing file editors from memento split panes", async () => {
    dbPath = join(tmpdir(), `wct-filter-memento-branch-${Date.now()}.vscdb`);
    const tmpFile = join(tmpdir(), `wct-memento-branch-${Date.now()}.ts`);
    await writeFile(tmpFile, "");
    try {
      const memento = {
        "editorpart.state": {
          serializedGrid: {
            root: {
              type: "branch",
              data: [
                {
                  type: "leaf",
                  data: {
                    id: 1,
                    editors: [
                      makeFileEditor(tmpFile),
                      makeFileEditor("/missing-a.ts"),
                    ],
                    mru: [0, 1],
                  },
                  size: 0.5,
                },
                {
                  type: "leaf",
                  data: {
                    id: 2,
                    editors: [makeFileEditor("/missing-b.ts")],
                    mru: [0],
                  },
                  size: 0.5,
                },
              ],
              size: 1,
            },
            width: 800,
            height: 600,
            orientation: 0,
          },
          activeGroup: 1,
          mostRecentActiveGroups: [1, 2],
        },
      };
      const db = new Database(dbPath);
      db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
      db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
        "memento/workbench.parts.editor",
        JSON.stringify(memento),
      );
      db.close();

      const count = await filterMissingEditors(dbPath, "/worktree");
      expect(count).toBe(2);

      const db2 = new Database(dbPath);
      const row = db2
        .query("SELECT value FROM ItemTable WHERE key = ?")
        .get("memento/workbench.parts.editor") as { value: string };
      db2.close();
      const result = JSON.parse(row.value);
      const root = result["editorpart.state"].serializedGrid.root;
      // Branch structure preserved, editors filtered within each leaf
      expect(root.type).toBe("branch");
      expect(root.data[0].data.editors.length).toBe(1);
      expect(root.data[1].data.editors.length).toBe(0);
    } finally {
      await rm(tmpFile, { force: true });
    }
  });
});

describe("clearTerminalState", () => {
  let dbPath: string;

  afterEach(async () => {
    if (dbPath) {
      await rm(dbPath, { force: true });
    }
  });

  test("deletes terminal layout keys", () => {
    dbPath = join(tmpdir(), `wct-term-clear-${Date.now()}.vscdb`);
    createTestDb(
      [
        {
          key: "terminal",
          value: '{"terminal":{"collapsed":false,"isHidden":true}}',
        },
        {
          key: "terminal.integrated.layoutInfo",
          value: '{"tabs":[{"activePersistentProcessId":5}]}',
        },
        {
          key: "terminal.numberOfVisibleViews",
          value: "1",
        },
      ],
      dbPath,
    );

    const count = clearTerminalState(dbPath);

    expect(count).toBe(3);
    expect(readAllKeys(dbPath)).toEqual([]);
  });

  test("preserves unrelated keys", () => {
    dbPath = join(tmpdir(), `wct-term-preserve-${Date.now()}.vscdb`);
    createTestDb(
      [
        {
          key: "terminal.integrated.environmentVariableCollectionsV2",
          value: '{"some":"env-data"}',
        },
        { key: "editorpart.state", value: '{"some":"editor-data"}' },
      ],
      dbPath,
    );

    const count = clearTerminalState(dbPath);

    expect(count).toBe(0);
    expect(readAllKeys(dbPath).sort()).toEqual([
      "editorpart.state",
      "terminal.integrated.environmentVariableCollectionsV2",
    ]);
  });

  test("returns 0 on corrupted database file", async () => {
    dbPath = join(tmpdir(), `wct-term-corrupt-${Date.now()}.vscdb`);
    await writeFile(dbPath, "not valid sqlite");

    const count = clearTerminalState(dbPath);

    expect(count).toBe(0);
  });

  test("returns 0 when no terminal keys exist", () => {
    dbPath = join(tmpdir(), `wct-term-empty-${Date.now()}.vscdb`);
    const db = new Database(dbPath);
    db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    db.close();

    const count = clearTerminalState(dbPath);

    expect(count).toBe(0);
  });
});

describe("clearExternalAgentSessions", () => {
  let dbPath: string;

  function readJson(key: string): unknown {
    const db = new Database(dbPath);
    const row = db
      .query("SELECT value FROM ItemTable WHERE key = ?")
      .get(key) as { value: string } | null;
    db.close();
    return row ? JSON.parse(row.value) : null;
  }

  afterEach(async () => {
    if (dbPath) {
      await rm(dbPath, { force: true });
    }
  });

  test("deletes agent session state keys", () => {
    dbPath = join(tmpdir(), `wct-agent-clear-${Date.now()}.vscdb`);
    createTestDb(
      [
        {
          key: "agentSessions.state.cache",
          value: '[{"resource":"claude-code:/abc","read":123}]',
        },
        { key: "agentSessions.readDateBaseline2", value: "1234567890" },
        { key: "unrelated.key", value: "keep" },
      ],
      dbPath,
    );

    clearExternalAgentSessions(dbPath);

    expect(readAllKeys(dbPath).sort()).toEqual(["unrelated.key"]);
  });

  test("removes external sessions from chat session index", () => {
    dbPath = join(tmpdir(), `wct-agent-chat-${Date.now()}.vscdb`);
    const sessionIndex = {
      version: 1,
      entries: {
        "copilot-session": {
          sessionId: "copilot-session",
          title: "Copilot Chat",
          isExternal: false,
        },
        "claude-code:/abc": {
          sessionId: "claude-code:/abc",
          title: "Claude Session",
          isExternal: true,
        },
        "claude-code:/def": {
          sessionId: "claude-code:/def",
          title: "Another Claude Session",
          isExternal: true,
        },
      },
    };
    createTestDb(
      [
        {
          key: "chat.ChatSessionStore.index",
          value: JSON.stringify(sessionIndex),
        },
      ],
      dbPath,
    );

    clearExternalAgentSessions(dbPath);

    const result = readJson("chat.ChatSessionStore.index") as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(result.entries)).toEqual(["copilot-session"]);
  });

  test("preserves chat index when no external sessions", () => {
    dbPath = join(tmpdir(), `wct-agent-noext-${Date.now()}.vscdb`);
    const sessionIndex = {
      version: 1,
      entries: {
        "copilot-session": {
          sessionId: "copilot-session",
          isExternal: false,
        },
      },
    };
    createTestDb(
      [
        {
          key: "chat.ChatSessionStore.index",
          value: JSON.stringify(sessionIndex),
        },
      ],
      dbPath,
    );

    clearExternalAgentSessions(dbPath);

    const result = readJson("chat.ChatSessionStore.index") as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(result.entries)).toEqual(["copilot-session"]);
  });

  test("returns 0 on corrupted database file", async () => {
    dbPath = join(tmpdir(), `wct-agent-corrupt-${Date.now()}.vscdb`);
    await writeFile(dbPath, "not valid sqlite");

    const count = clearExternalAgentSessions(dbPath);

    expect(count).toBe(0);
  });
});
