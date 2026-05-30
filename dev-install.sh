#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:9500}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

payload="$(mktemp)"
cleanup() {
  rm -f "$payload"
}
trap cleanup EXIT

python3 - "$ROOT" > "$payload" <<'PY'
import base64
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
files = []
for name in ("index.mjs", "package.json", "README.md", "LICENSE"):
    data = (root / name).read_bytes()
    files.append({
        "path": name,
        "content_base64": base64.b64encode(data).decode("ascii"),
    })

print(json.dumps({
    "name": "xenocept-plugin-aeor-codex",
    "files": files,
}))
PY

curl -fsS -X PUT \
  -H 'Content-Type: application/json' \
  --data-binary "@$payload" \
  "$BASE_URL/api/v1/plugins/npm/xenocept-plugin-aeor-codex"

printf '\nInstalled xenocept-plugin-aeor-codex into %s\n' "$BASE_URL"
