# JSON Output Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--json` global CLI flag that outputs structured JSON envelopes for programmatic consumption, starting with `list` and `queue` commands.

**Architecture:** A `GlobalFlag.setting("json")` on the root command propagates a boolean to all subcommands via Effect's service map. Commands that support JSON check the flag, collect raw data, and emit a `{ ok: true, data }` envelope. Errors emit `{ ok: false, error: { code, message } }`. Two utility functions (`jsonSuccess`, `jsonError`) handle serialization.

**Post-implementation notes:** Follow-up hardening added JSON envelopes for CLI parse/validation failures, preserved normal help output for bare `wct --json` / `-h`, and suppressed recoverable warning logs in `list --json` so stdout remains a single JSON document.

**Tech Stack:** Effect v4 (`GlobalFlag`, `Flag`, `Console`), Bun, Vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/cli/json-flag.ts` | **New.** Defines `JsonFlag` global setting |
| `src/utils/json-output.ts` | **New.** `jsonSuccess`, `jsonError` helpers |
| `src/cli/root-command.ts` | **Modify.** Attach `JsonFlag` via `Command.withGlobalFlags` |
| `src/commands/list.ts` | **Modify.** Add JSON output branch |
| `src/commands/queue.ts` | **Modify.** Add JSON output branch |
| `src/index.ts` | **Modify.** JSON-aware error handler |
| `tests/helpers/services.ts` | **Modify.** Add `JsonFlag` provisioning for tests |
| `tests/json-output.test.ts` | **New.** Tests for `jsonSuccess`/`jsonError` |
| `tests/list.test.ts` | **Modify.** Add JSON output tests |
| `tests/queue-command.test.ts` | **Modify.** Add JSON output tests |

---

### Task 1: Create JsonFlag Global Setting

**Files:**
- Create: `src/cli/json-flag.ts`

- [ ] **Step 1: Create the JsonFlag module**

```ts
// src/cli/json-flag.ts
import { Flag, GlobalFlag } from "../effect/cli";

export const JsonFlag = GlobalFlag.setting("json")({
  flag: Flag.boolean("json").pipe(
    Flag.withDescription("Output results as JSON"),
    Flag.withDefault(false),
  ),
});
```

- [ ] **Step 2: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/cli/json-flag.ts
git commit -m "feat: add JsonFlag global setting"
```

---

### Task 2: Create JSON Output Utilities + Tests

**Files:**
- Create: `src/utils/json-output.ts`
- Create: `tests/json-output.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/json-output.test.ts
import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";
import { jsonError, jsonSuccess } from "../src/utils/json-output";

describe("jsonSuccess", () => {
  test("writes JSON envelope with ok:true to stdout", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await Effect.runPromise(jsonSuccess({ branch: "main", changes: 3 }));
      expect(spy).toHaveBeenCalledOnce();
      const output = JSON.parse(spy.mock.calls[0]![0] as string);
      expect(output).toEqual({
        ok: true,
        data: { branch: "main", changes: 3 },
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("outputs valid JSON for arrays", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await Effect.runPromise(jsonSuccess([1, 2, 3]));
      const output = JSON.parse(spy.mock.calls[0]![0] as string);
      expect(output).toEqual({ ok: true, data: [1, 2, 3] });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("jsonError", () => {
  test("writes JSON envelope with ok:false to stderr", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await Effect.runPromise(jsonError("worktree_error", "Not found"));
      expect(spy).toHaveBeenCalledOnce();
      const output = JSON.parse(spy.mock.calls[0]![0] as string);
      expect(output).toEqual({
        ok: false,
        error: { code: "worktree_error", message: "Not found" },
      });
    } finally {
      spy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test tests/json-output.test.ts`
Expected: FAIL — module `../src/utils/json-output` not found

- [ ] **Step 3: Implement json-output utilities**

```ts
// src/utils/json-output.ts
import { Console, Effect } from "effect";
import { JsonFlag } from "../cli/json-flag";

export function jsonSuccess<T>(data: T) {
  return Console.log(JSON.stringify({ ok: true, data }, null, 2));
}

export function jsonError(code: string, message: string) {
  return Console.error(JSON.stringify({ ok: false, error: { code, message } }, null, 2));
}

export const isJsonMode = Effect.gen(function* () {
  return yield* JsonFlag;
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test tests/json-output.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/json-output.ts tests/json-output.test.ts
git commit -m "feat: add jsonSuccess and jsonError output utilities"
```

---

### Task 3: Wire JsonFlag to Root Command

**Files:**
- Modify: `src/cli/root-command.ts`

- [ ] **Step 1: Add JsonFlag import and attach to root command**

In `src/cli/root-command.ts`, add import:

```ts
import { JsonFlag } from "./json-flag";
```

Change the root command definition to include `withGlobalFlags`:

```ts
export const rootCommand = Command.make("wct").pipe(
  Command.withDescription("Git worktree workflow automation"),
  Command.withGlobalFlags([JsonFlag]),
  Command.withExamples([
    // ... existing examples unchanged ...
  ]),
  Command.withSubcommands([
    // ... existing subcommands unchanged ...
  ]),
);
```

- [ ] **Step 2: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Verify --json appears in help**

Run: `bun run src/index.ts --help`
Expected: output includes `--json` in the global flags section

- [ ] **Step 4: Commit**

```bash
git add src/cli/root-command.ts
git commit -m "feat: wire JsonFlag to root command"
```

---

### Task 4: Add JsonFlag Provisioning to Test Helpers

**Files:**
- Modify: `tests/helpers/services.ts`

Tests that call commands reading `JsonFlag` need it provided. Since `GlobalFlag.setting` creates an Effect service, tests must provide it. The default is `false` (non-JSON mode), so existing tests keep working. Tests that want JSON mode provide `true`.

- [ ] **Step 1: Update withTestServices to provide JsonFlag**

In `tests/helpers/services.ts`, add the import and a new override field:

```ts
import { JsonFlag } from "../../src/cli/json-flag";
```

Add to the `ServiceOverrides` interface:

```ts
export interface ServiceOverrides {
  // ... existing fields ...
  json?: boolean;
}
```

Add at the end of `withTestServices`, before the return:

```ts
provided = Effect.provideService(
  provided,
  JsonFlag,
  overrides.json ?? false,
);
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `bun run test`
Expected: all existing tests pass (JsonFlag defaults to false)

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/services.ts
git commit -m "feat: add JsonFlag provisioning to test helpers"
```

---

### Task 5: Add JSON Output to `list` Command

**Files:**
- Modify: `src/commands/list.ts`
- Modify: `tests/list.test.ts`

- [ ] **Step 1: Write the failing test for list JSON output**

Add to `tests/list.test.ts`, inside the `listCommand integration` describe block:

```ts
test("--json outputs structured JSON envelope", async () => {
  process.chdir(repoDir);
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]));
    });

  try {
    await runBunPromise(
      provideWctServices(
        Effect.provideService(listCommand({ short: false }), JsonFlag, true),
      ),
    );
    expect(lines).toHaveLength(1);
    const output = JSON.parse(lines[0]!);
    expect(output.ok).toBe(true);
    expect(Array.isArray(output.data)).toBe(true);

    // Check structure of a worktree entry
    const featureEntry = output.data.find(
      (e: { branch: string }) => e.branch === "feature-test",
    );
    expect(featureEntry).toBeDefined();
    expect(featureEntry.path).toBeDefined();
    expect(typeof featureEntry.changes).toBe("number");
    expect(featureEntry.changes).toBe(2);
    expect(featureEntry.sync).toEqual({ ahead: 0, behind: 3 });
    expect(featureEntry.tmux).toBeNull();
  } finally {
    spy.mockRestore();
    process.chdir(originalDir);
  }
});
```

Also add the `JsonFlag` import at the top of the test file:

```ts
import { JsonFlag } from "../src/cli/json-flag";
```

And update the `import { Effect } from "effect";` — add `Effect` if not already imported. (The existing file imports `$` from `bun` and test utilities from `vitest`, but not `Effect` directly. Add it.)

```ts
import { Effect } from "effect";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test tests/list.test.ts`
Expected: FAIL — `listCommand` doesn't read `JsonFlag` yet

- [ ] **Step 3: Implement JSON output in listCommand**

In `src/commands/list.ts`, add imports:

```ts
import { JsonFlag } from "../cli/json-flag";
import { jsonSuccess } from "../utils/json-output";
```

Modify `listCommand` to read the flag and branch early. The key change is: after collecting `nonBareWorktrees`, read `JsonFlag`. If JSON mode, collect raw data and emit via `jsonSuccess`. The raw data collection shares the existing `Effect.forEach` logic but captures numeric/object values instead of formatted strings.

Replace the `listCommand` function body with:

```ts
export function listCommand(opts?: {
  short?: boolean;
}): Effect.Effect<void, WctError, WctServices> {
  return Effect.gen(function* () {
    const json = yield* JsonFlag;
    const worktrees = yield* WorktreeService.use((service) =>
      service.listWorktrees(),
    );
    const nonBareWorktrees = worktrees.filter((wt) => !wt.isBare);

    if (nonBareWorktrees.length === 0) {
      if (json) {
        yield* jsonSuccess([]);
        return;
      }
      yield* logger.info("No worktrees found");
      return;
    }

    if (!json && opts?.short) {
      for (const wt of nonBareWorktrees) {
        yield* Console.log(wt.branch || "(unknown)");
      }
      return;
    }

    const [sessionsList, mainRepoPath] = yield* Effect.all([
      TmuxService.use((service) => service.listSessions()),
      WorktreeService.use((service) => service.getMainWorktreePath()),
    ]);
    const sessions = sessionsList ?? [];
    const defaultBranch = mainRepoPath
      ? yield* Effect.mapError(getDefaultBranch(mainRepoPath), (error) =>
          commandError(
            "worktree_error",
            "Failed to determine the default branch",
            error,
          ),
        )
      : null;

    const cwd = process.cwd();

    if (json) {
      const data = yield* Effect.mapError(
        Effect.forEach(nonBareWorktrees, (wt) =>
          Effect.gen(function* () {
            const branch = wt.branch || "(unknown)";
            const sessionName = formatSessionName(basename(wt.path));
            const session = sessions.find((s) => s.name === sessionName);
            const [changesCount, syncStatus] = yield* Effect.all([
              getChangedFilesCount(wt.path),
              getAheadBehind(wt.path, defaultBranch),
            ]);

            return {
              branch,
              path: relative(cwd, wt.path) || ".",
              tmux: session
                ? { session: sessionName, attached: !!session.attached }
                : null,
              changes: changesCount,
              sync: syncStatus,
            };
          }),
        ),
        (error) =>
          commandError(
            "worktree_error",
            "Failed to collect worktree status",
            error,
          ),
      );
      yield* jsonSuccess(data);
      return;
    }

    const rows = yield* Effect.mapError(
      Effect.forEach(nonBareWorktrees, (wt) =>
        Effect.gen(function* () {
          const branch = wt.branch || "(unknown)";
          const sessionName = formatSessionName(basename(wt.path));
          const session = sessions.find((s) => s.name === sessionName);
          const [changesCount, syncStatus] = yield* Effect.all([
            getChangedFilesCount(wt.path),
            getAheadBehind(wt.path, defaultBranch),
          ]);

          let tmux = "";
          let tmuxRaw = "";
          if (session) {
            if (session.attached) {
              tmuxRaw = `* ${sessionName}`;
              tmux = logger.green(tmuxRaw);
            } else {
              tmuxRaw = `  ${sessionName}`;
              tmux = tmuxRaw;
            }
          }

          return {
            branch,
            path: relative(cwd, wt.path) || ".",
            tmux,
            tmuxRaw,
            changes: formatChanges(changesCount),
            sync: formatSync(syncStatus),
          };
        }),
      ),
      (error) =>
        commandError(
          "worktree_error",
          "Failed to collect worktree status",
          error,
        ),
    );

    const headers = ["BRANCH", "PATH", "TMUX", "CHANGES", "SYNC"] as const;
    const colWidths = [
      Math.max(headers[0].length, ...rows.map((row) => row.branch.length)),
      Math.max(headers[1].length, ...rows.map((row) => row.path.length)),
      Math.max(headers[2].length, ...rows.map((row) => row.tmuxRaw.length)),
      Math.max(headers[3].length, ...rows.map((row) => row.changes.length)),
      Math.max(headers[4].length, ...rows.map((row) => row.sync.length)),
    ] as const;

    const headerLine = headers
      .map((header, index) => header.padEnd(colWidths[index] as number))
      .join("  ");
    yield* Console.log(logger.bold(headerLine));

    for (const row of rows) {
      const tmuxPadded =
        row.tmux + " ".repeat(Math.max(0, colWidths[2] - row.tmuxRaw.length));

      const line = [
        row.branch.padEnd(colWidths[0]),
        row.path.padEnd(colWidths[1]),
        tmuxPadded,
        row.changes.padEnd(colWidths[3]),
        row.sync.padEnd(colWidths[4]),
      ].join("  ");
      yield* Console.log(line);
    }
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test tests/list.test.ts`
Expected: all tests pass (existing + new JSON test)

- [ ] **Step 5: Commit**

```bash
git add src/commands/list.ts tests/list.test.ts
git commit -m "feat: add --json output to list command"
```

---

### Task 6: Add JSON Output to `queue` Command

**Files:**
- Modify: `src/commands/queue.ts`
- Modify: `tests/queue-command.test.ts`

- [ ] **Step 1: Write the failing tests for queue JSON output**

Add to `tests/queue-command.test.ts`, inside the `queueCommand` describe block:

```ts
test("default with items in --json mode outputs structured JSON", async () => {
  const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const now = Date.now();
  queueStorage = {
    ...queueStorage,
    listItems: () =>
      Effect.succeed([
        makeItem("test-1", {
          branch: "feature-x",
          project: "myapp",
          type: "permission_prompt",
          message: "Allow?",
          session: "myapp-feature-x",
          pane: "%1",
          timestamp: now - 90_000,
        }),
        makeItem("test-2", {
          branch: "feature-y",
          project: "myapp",
          type: "idle_prompt",
          message: "Done",
          session: "myapp-feature-y",
          pane: "%2",
          timestamp: now - 5000,
        }),
      ]),
  };

  try {
    await runBunPromise(
      withTestServices(queueCommand({}), { queueStorage, json: true }),
    );
    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.ok).toBe(true);
    expect(output.data).toHaveLength(2);
    expect(output.data[0]).toEqual({
      id: "test-1",
      type: "permission_prompt",
      project: "myapp",
      branch: "feature-x",
      session: "myapp-feature-x",
      pane: "%1",
      timestamp: now - 90_000,
      message: "Allow?",
    });
    expect(output.data[1].id).toBe("test-2");
  } finally {
    consoleSpy.mockRestore();
  }
});

test("default with no items in --json mode outputs empty array", async () => {
  const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  try {
    await runBunPromise(
      withTestServices(queueCommand({}), { queueStorage, json: true }),
    );
    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output).toEqual({ ok: true, data: [] });
  } finally {
    consoleSpy.mockRestore();
  }
});
```

Also add `import { Effect } from "effect";` at the top if not already imported. (The existing file imports `Effect` from the queue module re-exports — check: yes, `Effect` is imported on line 1.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test tests/queue-command.test.ts`
Expected: FAIL — `queueCommand` doesn't read `JsonFlag` yet, and `withTestServices` needs to provide it

- [ ] **Step 3: Implement JSON output in queueCommand**

In `src/commands/queue.ts`, add imports:

```ts
import { JsonFlag } from "../cli/json-flag";
import { jsonSuccess } from "../utils/json-output";
```

Modify the `queueCommand` function. The JSON branch only applies to the default listing mode (no `--jump`, `--dismiss`, or `--clear`). Replace the listing section (the final `else` block starting at the `const items = yield* listQueueItems(...)` line) with a JSON-aware version:

Replace this block in the `Effect.gen` (after the `if (options.clear)` block):

```ts
      const items = yield* listQueueItems(queueStorage);
      const json = yield* JsonFlag;

      if (items.length === 0) {
        if (json) {
          yield* jsonSuccess([]);
          return;
        }
        yield* logger.info("No pending notifications");
        return;
      }

      if (json) {
        yield* jsonSuccess(
          items.map((item) => ({
            id: item.id,
            type: item.type,
            project: item.project,
            branch: item.branch,
            session: item.session,
            pane: item.pane,
            timestamp: item.timestamp,
            message: item.message,
          })),
        );
        return;
      }

      for (const item of items) {
        const type = `[${formatType(item.type)}]`.padEnd(14);
        const branch = item.branch.padEnd(20);
        const age = formatAge(item.timestamp);
        yield* Console.log(
          `  ${item.id}  ${type}${branch}${age}  ${item.message}`,
        );
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test tests/queue-command.test.ts`
Expected: all tests pass (existing + new JSON tests)

- [ ] **Step 5: Commit**

```bash
git add src/commands/queue.ts tests/queue-command.test.ts
git commit -m "feat: add --json output to queue command"
```

---

### Task 7: JSON-Aware Error Handler in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update the error handler**

In `src/index.ts`, add imports:

```ts
import { JsonFlag } from "./cli/json-flag";
import { jsonError } from "./utils/json-output";
```

Replace the error handling block:

```ts
const program = provideBunServices(
  provideWctServices(
    Effect.catch(Command.run(rootCommand, { version: VERSION }), (error) => {
      const wctError = toWctError(error);
      return Effect.gen(function* () {
        let json = false;
        try {
          json = yield* JsonFlag;
        } catch {
          // JsonFlag may not be in context if CLI parsing failed
        }
        if (json) {
          yield* jsonError(wctError.code, wctError.message);
        } else {
          process.stderr.write(`${wctError.message}\n`);
        }
        process.exitCode = 1;
      });
    }),
  ),
);
```

Note: The `try/catch` around `yield* JsonFlag` handles the edge case where CLI parsing itself fails before the global flag is resolved. In that case, fall back to plain text error output.

- [ ] **Step 2: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Manual smoke test — JSON error output**

Run: `bun run src/index.ts --json list` from a non-git directory.
Expected: JSON error envelope on stderr with `code: "worktree_error"` or similar, exit code 1.

Run: `bun run src/index.ts --json list` from the project root.
Expected: JSON success envelope on stdout with worktree data.

- [ ] **Step 4: Manual smoke test — normal error output still works**

Run: `bun run src/index.ts list` from a non-git directory.
Expected: plain text error on stderr (unchanged behavior).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: add JSON-aware error handler"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `bun run test`
Expected: all tests pass

- [ ] **Step 2: Run linter**

Run: `bunx biome check --write`
Expected: no errors

- [ ] **Step 3: End-to-end smoke tests**

```bash
# JSON list output
bun run src/index.ts --json list

# JSON list output piped through jq
bun run src/index.ts --json list | jq '.data[].branch'

# JSON queue output (empty)
bun run src/index.ts --json queue

# Normal output unchanged
bun run src/index.ts list

# Help still works
bun run src/index.ts --help
```

- [ ] **Step 4: Commit any formatting changes**

```bash
git add -A
git commit -m "chore: formatting cleanup"
```
