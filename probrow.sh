#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVOKE_CWD="$(pwd)"

# Activate the backend venv in this script process, then run probrow.
# Note: because this is an executable script (not sourced), it won't keep
# the venv active in your current terminal after it exits.
export PROBROW_BOOTSTRAP_QUIET="${PROBROW_BOOTSTRAP_QUIET:-1}"
source "${ROOT_DIR}/backend/bootstrap.sh"

# Ensure relative paths (genes/bigwig-folder) resolve from the user's current dir.
export PROBROW_INVOKE_CWD="$INVOKE_CWD"
cd "$INVOKE_CWD"
VENV_PROBROW="${ROOT_DIR}/backend/.venv/bin/probrow"
if [[ -x "${VENV_PROBROW}" ]]; then
  exec "${VENV_PROBROW}" "$@"
fi
if command -v probrow >/dev/null 2>&1; then
  exec probrow "$@"
fi

echo "Error: 'probrow' CLI not found (expected: ${VENV_PROBROW})." >&2
echo "Try: PROBROW_BOOTSTRAP_FORCE=1 ./probrow.sh --help" >&2
exit 127

