# JSON Output Format Design

## Goal

Add a `--json` global CLI flag that activates structured JSON output for programmatic consumption of `wct` commands. Start with data commands (`list`, `queue`), using an architecture that scales to all commands.

## Architecture

### Global Flag

A `GlobalFlag.setting("json")` on the root command. Effect CLI propagates it to all subcommands automatically via the service map.

```ts
// src/cli/json-flag.ts
export const JsonFlag = GlobalFlag.setting("json")({
  flag: Flag.boolean("json").pipe(
    Flag.withDescription("Output results as JSON"),
    Flag.withDefault(false),
  ),
});
```

Attached to root command via `Command.withGlobalFlags([JsonFlag])`.

Commands read the flag with `yield* JsonFlag` to get a boolean.

### Output Envelope

All JSON output uses a discriminated envelope:

```ts
// Success
{ "ok": true, "data": <command-specific payload> }

// Error
{ "ok": false, "error": { "code": "<wct error code>", "message": "<human-readable message>" } }
```

Success writes to stdout. Errors write to stderr. Non-zero exit code is always set on failure regardless of output mode.

### JSON Output Utilities

```ts
// src/utils/json-output.ts
jsonSuccess<T>(data: T)       // emit { ok: true, data } to stdout
jsonError(code, message)      // emit { ok: false, error } to stderr
isJsonMode                    // Effect that yields the boolean flag value
```

Output uses `JSON.stringify(value, null, 2)` for readability.

### Command Integration Pattern

Each command that supports JSON:

1. Reads the flag: `const json = yield* JsonFlag;`
2. Collects structured data (shared with human path where possible)
3. If `json`, calls `jsonSuccess(data)` and returns early
4. Otherwise, continues with existing human-readable output

Key principles:
- **Raw data in JSON mode** -- numbers not formatted strings, objects not display text
- **No ANSI codes** in JSON output
- **No logger calls** (`logger.info`, `logger.step`) in JSON mode
- **No recoverable warning logs** in JSON mode; commands should degrade values silently if needed
- **Existing human-readable code untouched**

### Error Handling

The error wrapper in `index.ts` checks `JsonFlag`:
- If JSON mode: emits `jsonError(code, message)` to stderr, sets exit code 1
- If normal mode: existing `process.stderr.write` behavior unchanged

CLI parse / validation failures under `--json` also use the JSON error envelope.

Bare `wct --json` preserves normal help output and exits 0 rather than returning a JSON envelope.

## Commands In Scope

### `list` (initial implementation)

```json
{
  "ok": true,
  "data": [
    {
      "branch": "main",
      "path": ".",
      "tmux": { "session": "wct-main", "attached": true },
      "changes": 3,
      "sync": { "ahead": 1, "behind": 0 }
    }
  ]
}
```

- `tmux`: `null` if no session, otherwise `{ session, attached }`
- `changes`: raw file count (number)
- `sync`: raw `{ ahead, behind }` object

### `queue` (initial implementation)

```json
{
  "ok": true,
  "data": [
    {
      "id": "abc123",
      "type": "permission_prompt",
      "project": "my-repo",
      "branch": "feature-x",
      "session": "my-repo-feature-x",
      "pane": "%1",
      "timestamp": 1712150400000,
      "message": "Claude needs permission"
    }
  ]
}
```

### Commands Not In Scope (future)

`open`, `close`, `up`, `down`, `switch`, `cd`, `init`, `hooks`, `notify`, `register`, `unregister`, `tui`.

These are action commands. When added, they will return a result object like `{ status: "ok", branch: "...", path: "..." }`. The architecture supports this -- they just need to `yield* JsonFlag` and branch.

Output strategy for action commands when added: silent execution, single JSON object at the end. No NDJSON streaming for now.

## Files Changed

| File | Change |
|------|--------|
| `src/cli/json-flag.ts` | **New** -- GlobalFlag setting definition |
| `src/utils/json-output.ts` | **New** -- jsonSuccess, jsonError, isJsonMode helpers |
| `src/cli/root-command.ts` | Add `Command.withGlobalFlags([JsonFlag])` to root |
| `src/commands/list.ts` | Add JSON output branch |
| `src/commands/queue.ts` | Add JSON output branch |
| `src/index.ts` | Update error handler for JSON error envelope |
