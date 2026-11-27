#!/usr/bin/env bash
set -euo pipefail

# Token-efficient Flagsmith CLI audit script.
# Fetches ONLY {name, enabled, value} via --json --jq to minimize LLM context tokens.
# Supports custom Flagsmith Management API base URLs via FLAGSMITH_API_URL (without /api/v1/).

if ! command -v flagsmith >/dev/null 2>&1; then
  echo 'Error: flagsmith CLI not found. Install via: npm install -g @flagsmith/cli' >&2
  exit 1
fi

# Safely load FLAGSMITH_* variables from .env.local if not already set in environment
if [ -z "${FLAGSMITH_API_KEY:-}" ] && [ -f ".env.local" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      FLAGSMITH_API_KEY|FLAGSMITH_API_URL|FLAGSMITH_ENVIRONMENT|FLAGSMITH_PROJECT|FLAGSMITH_SDK_API_URL)
        if [ -z "${!key:-}" ] && [ -n "$value" ]; then
          export "$key=${value%$'\r'}"
        fi
        ;;
    esac
  done < <(grep -v '^[[:space:]]*#' .env.local | grep '=')
fi

EXTRA_ARGS=()
if [ -n "${FLAGSMITH_API_URL:-}" ]; then
  EXTRA_ARGS+=(--api-url "$FLAGSMITH_API_URL")
fi

JQ_FILTER='[.[] | {name: .feature, enabled, value}]'

STDERR_FILE="$(mktemp)"
trap 'rm -f "$STDERR_FILE"' EXIT

set +e
RAW_OUT="$(flagsmith flag list "${EXTRA_ARGS[@]}" --json --jq "$JQ_FILTER" 2>"$STDERR_FILE")"
CLI_EXIT=$?
set -e

STDERR_OUT="$(cat "$STDERR_FILE")"

if [ "$CLI_EXIT" -ne 0 ]; then
  echo "Error: flagsmith flag list failed with exit code ${CLI_EXIT}." >&2
  [ -n "$STDERR_OUT" ] && echo "$STDERR_OUT" >&2
  [ -n "$RAW_OUT" ] && echo "$RAW_OUT" >&2
  exit 1
fi

# Guard against @flagsmith/cli v2.0.0 npm wrapper exiting 0 on failure:
# treat empty stdout, non-JSON output, or non-array JSON as a hard error.
TRIMMED="$(printf '%s' "$RAW_OUT" | tr -d '[:space:]')"
if [ -z "$TRIMMED" ]; then
  echo "Error: flagsmith flag list returned empty stdout (CLI wrapper may have exited 0 on failure)." >&2
  [ -n "$STDERR_OUT" ] && echo "$STDERR_OUT" >&2
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  if ! printf '%s' "$RAW_OUT" | node -e '
    const fs = require("node:fs");
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) process.exit(2);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { process.exit(3); }
    if (!Array.isArray(parsed)) process.exit(4);
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.name !== "string" || typeof item.enabled !== "boolean") {
        process.exit(5);
      }
    }
  '; then
    echo "Error: flagsmith flag list returned invalid or non-array JSON." >&2
    [ -n "$STDERR_OUT" ] && echo "$STDERR_OUT" >&2
    echo "Output was: $RAW_OUT" >&2
    exit 1
  fi
elif command -v jq >/dev/null 2>&1; then
  if ! printf '%s' "$RAW_OUT" | jq -e 'type == "array" and all(.[]; type == "object" and (.name | type == "string") and (.enabled | type == "boolean"))' >/dev/null 2>&1; then
    echo "Error: flagsmith flag list returned invalid or non-array JSON." >&2
    [ -n "$STDERR_OUT" ] && echo "$STDERR_OUT" >&2
    echo "Output was: $RAW_OUT" >&2
    exit 1
  fi
fi

printf '%s\n' "$RAW_OUT"
