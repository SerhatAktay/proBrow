#!/usr/bin/env bash
set -euo pipefail

# When this script is sourced, $0 refers to the parent shell/script.
# Use BASH_SOURCE to reliably locate this file.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

QUIET="${PROBROW_BOOTSTRAP_QUIET:-1}"
FORCE="${PROBROW_BOOTSTRAP_FORCE:-0}"

# If the venv was moved (e.g. repo renamed), the generated console scripts may
# still point at the old absolute python path. Detect that and recreate.
if [[ -f ".venv/bin/probrow" ]]; then
  PROBROW_SHEBANG_PY="$(python3 -c "import pathlib,re; p=pathlib.Path('.venv/bin/probrow'); line=p.read_text(errors='ignore').splitlines()[0] if p.exists() else ''; m=re.match(r'^#!(.*)$', line); print(m.group(1).strip() if m else '')")"
  if [[ -n "${PROBROW_SHEBANG_PY}" && ! -x "${PROBROW_SHEBANG_PY}" ]]; then
    FORCE="1"
    chmod -R u+w ".venv" 2>/dev/null || true
    rm -rf ".venv" 2>/dev/null || true
  fi
fi

if [[ -d ".venv" && ! -f ".venv/bin/activate" ]]; then
  # Broken/partial venv (e.g. interrupted rm or crash). Recreate cleanly.
  chmod -R u+w ".venv" 2>/dev/null || true
  rm -rf ".venv" 2>/dev/null || true
fi
if [[ ! -f ".venv/bin/activate" ]]; then
  python3 -m venv ".venv"
fi
# shellcheck disable=SC1091
source ".venv/bin/activate"

# Upgrading pip inside a venv created from some Conda Python builds can segfault on macOS.
# Keep the default path simple and stable; users can opt-in to upgrading.
if [[ "${PROBROW_UPGRADE_PIP:-0}" == "1" ]]; then
  python -m pip install --upgrade pip
fi

STAMP=".venv/.probrow_bootstrap_stamp"
SRC_STAMP="$(python -c "from pathlib import Path; p=Path('pyproject.toml'); print(int(p.stat().st_mtime) if p.exists() else 0)")"
HAVE_STAMP="0"
if [[ -f "${STAMP}" ]]; then
  if [[ "$(cat "${STAMP}")" == "${SRC_STAMP}" ]]; then
    HAVE_STAMP="1"
  fi
fi
VENV_PROBROW_BIN=".venv/bin/probrow"

# If the venv exists but the console script is missing (partial/failed install),
# force a reinstall.
if [[ ! -x "${VENV_PROBROW_BIN}" ]]; then
  FORCE="1"
fi

if [[ "${FORCE}" == "1" || "${HAVE_STAMP}" != "1" ]]; then
  if [[ "${QUIET}" != "1" ]]; then
    echo "Installing/updating proBrow in venv…"
  fi
  # Editable installs update/create *.egg-info; if the repo was moved or a previous
  # install left stale metadata, timestamp updates can fail. Remove them first.
  shopt -s nullglob
  rm -rf ./*.egg-info 2>/dev/null || true
  shopt -u nullglob
  python -m pip --disable-pip-version-check install -e . -q
  echo "${SRC_STAMP}" > "${STAMP}"
else
  if [[ "${QUIET}" != "1" ]]; then
    echo "proBrow venv already up to date."
  fi
fi

