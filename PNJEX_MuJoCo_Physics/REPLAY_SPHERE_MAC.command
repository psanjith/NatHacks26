#!/bin/bash
set -euo pipefail
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$PACKAGE_DIR"
bash "$PACKAGE_DIR/SETUP_MAC.command" --check
for ITEM in results/sphere_baseline_z60.json results/sphere_baseline_z60_trajectory.npz models/PNJEX_sphere_replay_full.xml; do
    [ -f "$ITEM" ] || { printf 'Missing replay file: %s\n' "$ITEM" >&2; exit 1; }
done
printf '%s\n' 'Opening the recorded sphere trajectory. This is a replay, not a new dynamics test. Close the viewer to stop.'
exec "$PACKAGE_DIR/.venv/bin/mjpython" "$PACKAGE_DIR/replay.py" --case sphere_baseline_z60
