#!/bin/bash
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$PACKAGE_DIR"

fail() { printf '%s\n' "$*" >&2; exit 1; }
MODE="${1:-setup}"
case "$MODE" in setup|--check) ;; *) fail "Usage: bash SETUP_MAC.command [--check]" ;; esac
[ "$#" -le 1 ] || fail "Usage: bash SETUP_MAC.command [--check]"
[ "$(uname -s)" = "Darwin" ] || fail "These launchers require macOS. No changes were made."
[ "${PACKAGE_DIR##*/}" = "PNJEX_MuJoCo_Physics" ] || fail "Keep the runtime folder name PNJEX_MuJoCo_Physics and run the launchers inside it."
for ITEM in simulate.py tendon_forces.py replay.py requirements_mac.txt models assets results parameters; do
    [ -e "$PACKAGE_DIR/$ITEM" ] || fail "Missing package item: $ITEM. Extract the complete archive first."
done

VENV_DIR="$PACKAGE_DIR/.venv"
VENV_PY="$VENV_DIR/bin/python"

validate_environment() {
    [ -x "$VENV_PY" ] || return 1
    [ -x "$VENV_DIR/bin/mjpython" ] || return 1
    "$VENV_PY" - <<'PY'
import importlib.metadata
import platform
import sys

if sys.implementation.name != 'cpython' or sys.version_info[:2] != (3, 12):
    raise SystemExit('This package requires CPython 3.12.x (not 3.11 or 3.13+).')
if sys.platform != 'darwin' or platform.machine() != 'arm64':
    raise SystemExit('Use native Apple Silicon arm64 Python; this pinned setup does not support Intel/Rosetta Python.')
if sys.prefix == sys.base_prefix:
    raise SystemExit('The .venv Python is not running as an isolated virtual environment.')
for name, expected in [('mujoco', '4.0.0'), ('mujoco-core', '4.0.0'),
                       ('mujoco-studio', '4.0.0'), ('numpy', '2.5.4')]:
    try:
        actual = importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        raise SystemExit(f'Missing dependency: {name}=={expected}')
    if actual != expected:
        raise SystemExit(f'Wrong dependency version: {name}=={actual}; expected {expected}.')
import mujoco
import numpy
import mujoco.viewer
if mujoco.__version__ != '4.0.0' or numpy.__version__ != '2.5.4':
    raise SystemExit('Imported package versions do not match the required environment.')
print('Environment verified: CPython 3.12 / arm64 / MuJoCo 4.0.0 / NumPy 2.5.4.')
PY
}

if [ -e "$VENV_DIR" ] || [ -L "$VENV_DIR" ]; then
    if validate_environment; then
        printf '%s\n' 'Using the existing .venv; nothing was installed or upgraded.'
        exit 0
    fi
    fail "The existing .venv is incomplete or incompatible. It was left unchanged. Rename it manually (for example .venv_backup), then run setup again."
fi

[ "$MODE" != "--check" ] || fail "Run bash SETUP_MAC.command once before opening a replay or starting a run."

PYTHON_BIN=""
for CANDIDATE in python3.12 python3; do
    if command -v "$CANDIDATE" >/dev/null 2>&1; then
        CANDIDATE_PATH="$(command -v "$CANDIDATE")"
        if "$CANDIDATE_PATH" -c 'import platform,sys; sys.exit(0 if sys.implementation.name == "cpython" and sys.version_info[:2] == (3,12) and sys.platform == "darwin" and platform.machine() == "arm64" else 1)'; then
            PYTHON_BIN="$CANDIDATE_PATH"
            break
        fi
    fi
done
[ -n "$PYTHON_BIN" ] || fail "Native Apple Silicon CPython 3.12 was not found as python3.12 or python3. Install Python 3.12 from python.org, open a native Terminal, and try again. Intel Macs are not supported by the reviewed MuJoCo 4.0.0 Mac wheels; no different version will be substituted."

printf '%s\n' 'Creating .venv in this package folder.'
"$PYTHON_BIN" -m venv "$VENV_DIR"
printf '%s\n' 'Installing the pinned packages and their dependencies from official PyPI. Internet access is required.'
if ! "$VENV_PY" -m pip --isolated --disable-pip-version-check install --index-url https://pypi.org/simple --only-binary=:all: -r "$PACKAGE_DIR/requirements_mac.txt"; then
    fail "Installation failed. The versions were not changed and no source build was attempted. Keep the error text; the partial .venv was left in place. Rename that folder manually before retrying setup."
fi
validate_environment || fail "Installation finished but verification failed. The .venv was left in place for inspection."
printf '%s\n' 'Setup complete. Next: bash REPLAY_CYLINDER_MAC.command'
