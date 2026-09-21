#!/usr/bin/env bash
set -Eeuo pipefail

# Migration-only compatibility entrypoint. The canonical staging continuity
# smoke is scripts/ops/openclaw-staging-smoke.sh and uses systemId=openclaw.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${SCRIPT_DIR}/openclaw-staging-smoke.sh" "$@"
