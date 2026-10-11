#!/bin/sh

set -u

cat >/dev/null

trim_lines=100
tmp_dir="${TMPDIR:-/tmp}"
biome_log=$(mktemp "${tmp_dir%/}/codex-stop-biome.XXXXXX")
typecheck_log=$(mktemp "${tmp_dir%/}/codex-stop-typecheck.XXXXXX")
test_log=$(mktemp "${tmp_dir%/}/codex-stop-test.XXXXXX")

cleanup() {
  rm -f "${biome_log}" "${typecheck_log}" "${test_log}"
}

emit_continue() {
  printf '%s\n' '{"continue":true}'
}

snapshot_files() {
  bun -e '
import { lstatSync, readFileSync, readlinkSync } from "node:fs";

const files = Bun.spawnSync([
  "git", "ls-files", "--cached", "--others", "--exclude-standard", "-z",
], { stderr: "inherit" });
if (files.exitCode !== 0) process.exit(files.exitCode);
const paths = [...new Set(files.stdout.toString().split("\0").filter(Boolean))].sort();
const snapshot = new Bun.CryptoHasher("sha256");
for (const path of paths) {
  snapshot.update(path + "\0");
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) snapshot.update("link\0" + readlinkSync(path));
    else if (stat.isFile()) {
      const hash = new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
      snapshot.update("file\0" + hash);
    } else snapshot.update("directory\0");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    snapshot.update("missing\0");
  }
}
console.log(snapshot.digest("hex"));
'
}

emit_block_with_log() {
  prefix="$1"
  log_file="$2"
  reason=$(
    bun -e '
const [prefix, logFile, trimLines] = process.argv.slice(1);
const content = await Bun.file(logFile).text();
const snippet = content.trimEnd().split(/\r?\n/).slice(-Number(trimLines)).join("\n").trim();
console.log(JSON.stringify(snippet ? prefix + "\n\n" + snippet : prefix));
' "${prefix}" "${log_file}" "${trim_lines}"
  )
  printf '{"decision":"block","reason":%s}\n' "${reason}"
}

trap cleanup EXIT

repo_root=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "${repo_root}" ]; then
  echo "Failed to resolve repository root." >&2
  emit_continue
  exit 0
fi

cd "${repo_root}" || {
  echo "Failed to enter repository root." >&2
  emit_continue
  exit 0
}

if ! before_biome=$(snapshot_files 2>"${biome_log}"); then
  emit_block_with_log "Failed to snapshot files before Biome." "${biome_log}"
  exit 0
fi

if ! bunx biome check --write --error-on-warnings . >"${biome_log}" 2>&1; then
  cat "${biome_log}" >&2
  emit_block_with_log \
    "Biome checks failed. Fix the reported issues, then rerun the relevant verification." \
    "${biome_log}"
  exit 0
fi

if ! after_biome=$(snapshot_files 2>>"${biome_log}"); then
  emit_block_with_log "Failed to snapshot files after Biome." "${biome_log}"
  exit 0
fi

if [ "${before_biome}" != "${after_biome}" ]; then
  emit_block_with_log \
    "Biome modified files. Review and commit the lint/format fixes, then rerun verification." \
    "${biome_log}"
  exit 0
fi

if ! bun run typecheck >"${typecheck_log}" 2>&1; then
  cat "${typecheck_log}" >&2
  emit_block_with_log \
    "Typecheck failed. Fix the reported TypeScript errors, then rerun the relevant verification." \
    "${typecheck_log}"
  exit 0
fi

if ! bun run test -- --reporter=agent >"${test_log}" 2>&1; then
  cat "${test_log}" >&2
  emit_block_with_log \
    "Tests failed. Investigate the failing tests, fix them, and rerun the relevant verification." \
    "${test_log}"
  exit 0
fi

emit_continue
