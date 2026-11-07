#!/bin/bash
set -euo pipefail
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$PACKAGE_DIR"
bash "$PACKAGE_DIR/SETUP_MAC.command" --check
for ITEM in results/cylinder_sweep_w12_mu05.json results/cylinder_sweep_w12_mu05_trajectory.npz models/PNJEX_cylinder_replay_full.xml; do
    [ -f "$ITEM" ] || { printf 'Missing replay file: %s\n' "$ITEM" >&2; exit 1; }
done
printf '%s\n' 'Opening the recorded cylinder trajectory. This is a replay, not a new dynamics test. Close the viewer to stop.'
exec "$PACKAGE_DIR/.venv/bin/mjpython" "$PACKAGE_DIR/replay.py" --case cylinder_sweep_w12_mu05
