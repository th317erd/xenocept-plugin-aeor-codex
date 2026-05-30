#!/usr/bin/env bash
set -euo pipefail

DIRECTORY_ID="xenocept-plugin-aeor-codex"
SERVER_URL="${1:-http://127.0.0.1:9500}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INDEX_PATH="${SCRIPT_DIR}/index.mjs"
PACKAGE_PATH="${SCRIPT_DIR}/package.json"

for required in "${INDEX_PATH}" "${PACKAGE_PATH}"; do
  if [[ ! -f "${required}" ]]; then
    echo "Missing required file: ${required}" >&2
    exit 1
  fi
done

info="$(curl -fsS "${SERVER_URL}/api/v1/server/info" || true)"
if [[ -z "${info}" ]]; then
  echo "Cannot reach xenocept at ${SERVER_URL}. Is it running?" >&2
  exit 1
fi

allow_unsigned="$(echo "${info}" | jq -r '.allowUnsignedPlugins')"
if [[ "${allow_unsigned}" != "true" ]]; then
  echo "xenocept at ${SERVER_URL} is NOT running with --unsafe-allow-unsigned-plugins." >&2
  echo "Restart it as:" >&2
  echo "  xenocept --dev-mode --unsafe-allow-unsigned-plugins" >&2
  exit 1
fi

payload_path="$(mktemp)"
trap 'rm -f "${payload_path}"' EXIT

jq -n \
  --arg     name      "${DIRECTORY_ID}" \
  --rawfile index_mjs "${INDEX_PATH}" \
  --rawfile pkg       "${PACKAGE_PATH}" \
  '{
    name: $name,
    files: {
      "index.mjs": $index_mjs
    },
    package: $pkg
  }' \
  > "${payload_path}"

response="$(curl -sS -w '\n%{http_code}' \
  -X POST "${SERVER_URL}/api/v1/plugins/install-from-source" \
  -H 'Content-Type: application/json' \
  --data-binary "@${payload_path}")"

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "${status}" == "200" ]]; then
  echo "  OK  HTTP ${status}"
  echo "  ${body}"
else
  echo "  FAIL  HTTP ${status}" >&2
  echo "  ${body}" >&2
  exit 1
fi
