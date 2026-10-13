#!/bin/sh

set -u

cat >/dev/null

trim_lines=100
tmp_dir=$(cd "${TMPDIR:-/tmp}" && pwd -P)
lint_log=$(mktemp "${tmp_dir%/}/codex-stop-lint.XXXXXX")
format_log=$(mktemp "${tmp_dir%/}/codex-stop-format.XXXXXX")
test_log=$(mktemp "${tmp_dir%/}/codex-stop-test.XXXXXX")

cleanup() {
  rm -f "${lint_log}" "${format_log}" "${test_log}"
}

emit_continue() {
  printf '%s\n' '{"continue":true}'
}

snapshot_files() {
  bun -e '
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

// Hook logs can live inside the repo when TMPDIR is project-local.
const logs = new Set(process.argv.slice(1).map(path => realpathSync(path)));
const root = realpathSync(".");

const files = Bun.spawnSync([
  "git", "ls-files", "--cached", "--others", "--exclude-standard", "-z",
], { stderr: "inherit" });
if (files.exitCode !== 0) process.exit(files.exitCode);
const paths = [...new Set(files.stdout.toString().split("\0").filter(Boolean))].sort();
const snapshot = new Bun.CryptoHasher("sha256");
for (const path of paths) {
  if (logs.has(resolve(root, path))) continue;
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
' "${lint_log}" "${format_log}" "${test_log}"
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

if ! before_fixes=$(snapshot_files 2>"${lint_log}"); then
  emit_block_with_log "Failed to snapshot files before lint/format fixes." "${lint_log}"
  exit 0
fi

if ! bun run lint:fix >"${lint_log}" 2>&1; then
  cat "${lint_log}" >&2
  emit_block_with_log \
    "Oxlint lint/type checks failed. Fix the reported issues, then rerun the relevant verification." \
    "${lint_log}"
  exit 0
fi

if ! bun run format >"${format_log}" 2>&1; then
  cat "${format_log}" >&2
  emit_block_with_log \
    "Oxfmt failed. Fix the reported issues, then rerun the relevant verification." \
    "${format_log}"
  exit 0
fi

if ! after_fixes=$(snapshot_files 2>>"${format_log}"); then
  emit_block_with_log "Failed to snapshot files after lint/format fixes." "${format_log}"
  exit 0
fi

if [ "${before_fixes}" != "${after_fixes}" ]; then
  emit_block_with_log \
    "Oxlint or Oxfmt modified files. Review and commit the lint/format fixes, then rerun verification." \
    "${format_log}"
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
