import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runBunPromise } from "../../src/effect/runtime";
import { execShell } from "../../src/services/process";
import {
  CurrentWorkspaceLease,
  makeWorkspaceCoordinationService,
} from "../../src/services/workspace-coordination";
import {
  liveWorkspaceJournalSync,
  publishWorkspaceJournal,
} from "../../src/services/workspace-journal";
import { fullSyncWorkspaceFile } from "../../src/services/workspace-lock";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

describe(
  "Workspace journal persistence barriers",
  { concurrent: false },
  () => {
    let directory: string;
    let path: string;
    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), "wct-journal-"));
      path = join(directory, "journal.json");
      writeFileSync(path, "previous");
    });
    afterEach(() => {
      vi.restoreAllMocks();
      rmSync(directory, { recursive: true, force: true });
    });

    test("the native regular-file media flush succeeds on this filesystem", () => {
      const fd = openSync(path, "r+");
      try {
        writeFileSync(fd, "native flush");
        fullSyncWorkspaceFile(fd);
      } finally {
        closeSync(fd);
      }
      expect(readFileSync(path, "utf8")).toBe("native flush");
    });

    test("publication retains the flushed file through rename and drains directory writes before return", () => {
      const events: string[] = [];
      const files: number[] = [];
      publishWorkspaceJournal(path, "replacement", {
        file: (fd) => {
          expect(fstatSync(fd).isFile()).toBe(true);
          files.push(fd);
          events.push(`file:${readFileSync(path, "utf8")}`);
          fullSyncWorkspaceFile(fd);
        },
        directory: (fd) => {
          expect(fstatSync(fd).isDirectory()).toBe(true);
          const retained = files[0];
          if (retained === undefined)
            throw new Error("Missing pre-publication file descriptor");
          expect(fstatSync(retained).isFile()).toBe(true);
          events.push(`directory:${readFileSync(path, "utf8")}`);
          fsyncSync(fd);
        },
      });
      expect(events).toEqual([
        "file:previous",
        "directory:replacement",
        "file:replacement",
      ]);
      expect(files).toEqual([files[0], files[0]]);
      expect(readFileSync(path, "utf8")).toBe("replacement");
      expect(readdirSync(directory)).toEqual(["journal.json"]);
    });

    test("a required pre-publication media flush failure preserves the previous journal", () => {
      const failure = new Error("full media flush unsupported");
      expect(() =>
        publishWorkspaceJournal(path, "replacement", {
          file: () => {
            throw failure;
          },
          directory: () => {
            throw new Error("Directory barrier must not run");
          },
        }),
      ).toThrow(failure);
      expect(readFileSync(path, "utf8")).toBe("previous");
      expect(readdirSync(directory)).toEqual(["journal.json"]);
    });

    test.each(["data", "directory", "post-rename media"])(
      "failed %s barrier fences the operation without executing user code",
      async (stage) => {
        const coordination = await runBunPromise(
          makeWorkspaceCoordinationService({
            root: join(directory, "ownership"),
          }),
        );
        const target = { mainRepoPath: directory, branch: "durability" };
        const marker = join(directory, "escaped");
        await runBunPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const lease = yield* coordination.acquire(target);
              yield* Effect.sync(() => {
                let calls = 0;
                vi.spyOn(liveWorkspaceJournalSync, "file").mockImplementation(
                  (fd) => {
                    calls++;
                    if (
                      (stage === "data" && calls === 1) ||
                      (stage === "post-rename media" && calls === 2)
                    )
                      throw new Error("Required file media flush failed");
                    fullSyncWorkspaceFile(fd);
                  },
                );
                if (stage === "directory")
                  vi.spyOn(
                    liveWorkspaceJournalSync,
                    "directory",
                  ).mockImplementation(() => {
                    throw new Error("Required directory fsync failed");
                  });
              });
              const failure = yield* Effect.flip(
                execShell(`echo escaped > ${quote(marker)}`).pipe(
                  Effect.provideService(CurrentWorkspaceLease, lease),
                ),
              );
              expect(failure).toMatchObject({
                code: "workspace_coordination_error",
              });
            }),
          ),
        );
        expect(readdirSync(directory)).not.toContain("escaped");
        expect((await runBunPromise(coordination.inspect(target))).status).toBe(
          "outcome-unknown",
        );
      },
    );
  },
);
