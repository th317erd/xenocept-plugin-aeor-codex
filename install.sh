#!/usr/bin/env bash
#
# Install the Codex plugin into Xenocept by submitting its files,
# package.json, and signed `.xenocept-sig` envelope to the signed
# side-load endpoint. Because the payload is signed by an Aeor-trusted
# key, this works in production mode without --dev-mode / --unsafe flags.
#
# IMPORTANT: `.xenocept-sig` must be regenerated whenever index.mjs or
# main.lua changes. The v2 manifest hashes every file declared in files[].
#
# Usage: ./install.sh [server_url]
#   server_url defaults to http://127.0.0.1:9500

set -euo pipefail

DIRECTORY_ID="xenocept-plugin-aeor-codex"
SERVER_URL="${1:-http://127.0.0.1:9500}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

INDEX_PATH="${SCRIPT_DIR}/index.mjs"
LUA_PATH="${SCRIPT_DIR}/main.lua"
PACKAGE_PATH="${SCRIPT_DIR}/package.json"
SIG_PATH="${SCRIPT_DIR}/.xenocept-sig"

for required in "${INDEX_PATH}" "${LUA_PATH}" "${PACKAGE_PATH}" "${SIG_PATH}"; do
  if [[ ! -f "${required}" ]]; then
    echo "Missing required file: ${required}" >&2
    if [[ "${required}" == "${SIG_PATH}" ]]; then
      echo "Run aeor-sign against the offline private key to produce .xenocept-sig." >&2
    fi
    exit 1
  fi
done

echo "Installing ${DIRECTORY_ID} (signed, multi-file) to ${SERVER_URL}..."

PAYLOAD_PATH="$(mktemp)"
trap 'rm -f "${PAYLOAD_PATH}"' EXIT

jq -n \
  --arg     name      "${DIRECTORY_ID}" \
  --rawfile index_mjs "${INDEX_PATH}" \
  --rawfile main_lua  "${LUA_PATH}" \
  --rawfile pkg       "${PACKAGE_PATH}" \
  --rawfile sig       "${SIG_PATH}" \
  '{
    name: $name,
    files: {
      "index.mjs": $index_mjs,
      "main.lua":  $main_lua
    },
    package: $pkg,
    signature: $sig
  }' \
  > "${PAYLOAD_PATH}"

response="$(curl -sS -w '\n%{http_code}' \
  -X POST "${SERVER_URL}/api/v1/plugins/install-from-source" \
  -H 'Content-Type: application/json' \
  --data-binary "@${PAYLOAD_PATH}")"

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "${status}" == "200" ]]; then
  echo "  OK  HTTP ${status}"
  echo "  ${body}"
  echo "Reload the Xenocept client (Plugins tab -> refresh) to pick up the plugin."
else
  echo "  FAIL  HTTP ${status}" >&2
  echo "  ${body}" >&2
  exit 1
fi
