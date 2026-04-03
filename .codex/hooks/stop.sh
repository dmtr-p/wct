#!/bin/sh

set -u

cat >/dev/null

trim_lines=100
tmp_dir="${TMPDIR:-/tmp}"
biome_log=$(mktemp "${tmp_dir%/}/codex-stop-biome.XXXXXX")
test_log=$(mktemp "${tmp_dir%/}/codex-stop-test.XXXXXX")

cleanup() {
  rm -f "${biome_log}" "${test_log}"
}

emit_continue() {
  printf '%s\n' '{"continue":true}'
}

emit_block_with_log() {
  prefix="$1"
  log_file="$2"
  reason=$(
    /usr/bin/python3 - "${prefix}" "${log_file}" "${trim_lines}" <<'PY'
import json
import pathlib
import sys

prefix = sys.argv[1]
path = pathlib.Path(sys.argv[2])
trim_lines = int(sys.argv[3])

content = path.read_text(errors="replace").splitlines()
snippet = "\n".join(content[-trim_lines:]).strip()
if snippet:
    message = f"{prefix}\n\n{snippet}"
else:
    message = prefix

print(json.dumps(message))
PY
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

if ! bunx biome check --write --error-on-warnings . >"${biome_log}" 2>&1; then
  cat "${biome_log}" >&2
  emit_block_with_log \
    "Biome checks failed. Fix the reported issues, then rerun the relevant verification." \
    "${biome_log}"
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
