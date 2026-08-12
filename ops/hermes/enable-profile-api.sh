#!/usr/bin/env bash
# enable-profile-api.sh
#
# Enable the OpenAI-compatible API server on a non-default Hermes profile.
#
# Context
# -------
# Only ~/.hermes/.env (the default profile) currently defines the
# API_SERVER_* variable group. The gemma / lynn / xixi profiles define none
# of them, so starting their gateways does not open an OpenAI-compatible
# endpoint at all. That is why GET /v1/models on port 8642 returns exactly
# one model ("hermes-agent") and why Chat V2 cannot reach Gemma.
#
# This script appends the API_SERVER_* block to one profile's .env, reusing
# the API key from the default profile (Chat V2 holds a single key, so every
# profile must share it) and assigning a distinct port.
#
# The key is never printed.
#
# Usage
#   bash ops/hermes/enable-profile-api.sh gemma 8643
#   bash ops/hermes/enable-profile-api.sh lynn  8644
#   bash ops/hermes/enable-profile-api.sh xixi  8645
#
# Idempotent: re-running on an already-configured profile exits 0 without
# writing anything.

set -euo pipefail

PROFILE="${1:-}"
PORT="${2:-}"

if [[ -z "$PROFILE" || -z "$PORT" ]]; then
  echo "usage: $0 <profile> <port>" >&2
  echo "example: $0 gemma 8643" >&2
  exit 2
fi

if [[ "$PROFILE" == "default" ]]; then
  echo "refusing to modify the default profile" >&2
  exit 2
fi

DEFAULT_ENV="$HOME/.hermes/.env"
PROFILE_ENV="$HOME/.hermes/profiles/$PROFILE/.env"

if [[ ! -f "$DEFAULT_ENV" ]]; then
  echo "missing $DEFAULT_ENV" >&2
  exit 1
fi

if [[ ! -f "$PROFILE_ENV" ]]; then
  echo "missing $PROFILE_ENV" >&2
  echo "known profiles:" >&2
  ls -1 "$HOME/.hermes/profiles" >&2 || true
  exit 1
fi

if grep -qE '^API_SERVER_ENABLED' "$PROFILE_ENV"; then
  echo "[skip] $PROFILE already defines API_SERVER_ENABLED; nothing to do"
  grep -oE '^API_SERVER_[A-Z_]*' "$PROFILE_ENV" | sort
  exit 0
fi

# Read the shared key without echoing it.
set -a
# shellcheck disable=SC1090
. "$DEFAULT_ENV"
set +a

if [[ -z "${API_SERVER_KEY:-}" ]]; then
  echo "API_SERVER_KEY is not set in the default profile" >&2
  exit 1
fi

HOST_VALUE="${API_SERVER_HOST:-172.17.0.1}"

BACKUP="$PROFILE_ENV.bak.$(date +%Y%m%d_%H%M%S)"
cp "$PROFILE_ENV" "$BACKUP"
echo "[backup] $BACKUP"

{
  echo
  echo "# --- OpenAI-compatible API server (added by ops/hermes/enable-profile-api.sh) ---"
  echo "API_SERVER_ENABLED=true"
  echo "API_SERVER_HOST=$HOST_VALUE"
  echo "API_SERVER_PORT=$PORT"
  echo "API_SERVER_KEY=$API_SERVER_KEY"
  echo "API_SERVER_MODEL_NAME=$PROFILE"
} >> "$PROFILE_ENV"

echo "[write] appended API_SERVER_* to $PROFILE_ENV"
echo "[verify] keys present (values hidden):"
grep -oE '^API_SERVER_[A-Z_]*' "$PROFILE_ENV" | sort

echo
echo "Next: start the gateway for this profile, then verify with"
echo "  curl -s http://$HOST_VALUE:$PORT/v1/models -H \"Authorization: Bearer \$API_SERVER_KEY\""
echo "Expected: a single entry whose id is \"$PROFILE\"."
