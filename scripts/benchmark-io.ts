import { Database } from "bun:sqlite";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Stream } from "effect";
import { commandError } from "../src/errors";
import { copyFiles } from "../src/services/copy";
import { runMigrations } from "../src/services/db.ts";
import { RegistrationId } from "../src/services/identities";
import {
  sqlOwnedWrite,
  sqlPruneWorkspaces,
  sqlSetOpenPrs,
  sqlSetWorkspace,
} from "../src/services/pr-cache-service.ts";

// Run with Bun; fixtures and SQLite databases stay in an isolated temporary directory.
const [mode, root] = Bun.argv.slice(2);
if (mode && root) {
  const started = performance.now();
  const fs = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (mode === "buffer")
      yield* fs.writeFile(
        join(root, "target", "source"),
        yield* fs.readFile(join(root, "source")),
      );
    if (mode === "native")
      yield* fs.copyFile(join(root, "source"), join(root, "target", "source"));
    if (mode === "scoped") {
      const results = yield* copyFiles(["source"], root, join(root, "target"));
      if (results.some((result) => !result.success))
        return yield* commandError("worktree_error", "Benchmark copy failed");
    }
    if (mode === "stream")
      yield* Stream.run(
        fs.stream(join(root, "source"), { chunkSize: 1024 * 1024 }),
        fs.sink(join(root, "target", "source")),
      );
  });
  await Effect.runPromise(Effect.provide(fs, BunServices.layer));
  console.log(
    JSON.stringify({
      mode,
      ms: performance.now() - started,
      maxRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
} else {
  const dir = mkdtempSync(join(tmpdir(), "wct-303-bench-"));
  try {
    mkdirSync(join(dir, "target"));
    const chunk = new Uint8Array(1024 * 1024).fill(42);
    const writer = Bun.file(join(dir, "source")).writer();
    for (let i = 0; i < 256; i++) {
      await writer.write(chunk);
      await writer.flush();
    }
    await writer.end();
    for (let trial = 0; trial < 3; trial++)
      for (const mode of ["buffer", "native", "stream", "scoped"]) {
        rmSync(join(dir, "target", "source"), { force: true });
        const p = Bun.spawn([process.execPath, import.meta.path, mode, dir], {
          stdout: "pipe",
          stderr: "inherit",
        });
        console.log((await new Response(p.stdout).text()).trim());
        if (await p.exited) throw Error("worker failed");
      }
    for (const mode of ["buffer", "native", "stream", "scoped"])
      for (const existing of [false, true]) {
        rmSync(join(dir, "target", "source"), { force: true });
        if (existing) {
          writeFileSync(join(dir, "target", "source"), "old");
          chmodSync(join(dir, "target", "source"), 0o640);
        }
        chmodSync(join(dir, "source"), 0o600);
        utimesSync(join(dir, "source"), 946684800, 946684800);
        const p = Bun.spawn([process.execPath, import.meta.path, mode, dir], {
          stdout: "ignore",
          stderr: "inherit",
        });
        await p.exited;
        const st = statSync(join(dir, "target", "source"));
        console.log(
          JSON.stringify({
            mode,
            existing,
            permissions: (st.mode & 0o777).toString(8),
            mtime: st.mtime.toISOString(),
          }),
        );
      }
    for (const count of [10, 50])
      for (const batched of [false, true]) {
        const times: number[] = [];
        let connections = 0;
        const path = join(dir, `${count}-${batched}.db`);
        const open = () => {
          connections++;
          const db = new Database(path, { create: true });
          db.run("PRAGMA journal_mode=WAL");
          runMigrations(db);
          return db;
        };
        let db = open();
        db.run("INSERT INTO registry VALUES ('one','/repo','repo',0)");
        db.close();
        connections = 0;
        const branches = Array.from({ length: count }, (_, i) => `branch-${i}`);
        const entry = {
          pr: null,
          candidates: [],
          newerOpenPr: null,
          fetchedAt: 1,
          lastError: null,
        };
        for (let trial = 0; trial < 10; trial++) {
          const started = performance.now();
          const shared = batched ? open() : null;
          const write = (f: (db: Database) => void) => {
            const db = shared ?? open();
            try {
              sqlOwnedWrite(db, "/repo", RegistrationId("one"), () => f(db));
            } finally {
              if (!shared) db.close();
            }
          };
          try {
            write((db) => sqlSetOpenPrs(db, "/repo", []));
            for (const branch of branches)
              write((db) => sqlSetWorkspace(db, "/repo", branch, entry));
            write((db) => sqlPruneWorkspaces(db, "/repo", branches));
          } finally {
            shared?.close();
          }
          times.push(performance.now() - started);
        }
        times.sort((a, b) => a - b);
        console.log(
          JSON.stringify({
            count,
            batched,
            connectionsPerRefresh: connections / 10,
            medianMs: times[5],
          }),
        );
      }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
