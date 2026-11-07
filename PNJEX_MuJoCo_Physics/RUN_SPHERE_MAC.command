#!/bin/bash
set -euo pipefail
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$PACKAGE_DIR"
bash "$PACKAGE_DIR/SETUP_MAC.command" --check
for ITEM in parameters/sphere_baseline_z60.json models/PNJEX_sphere_replay_full.xml models/PNJEX_sphere_replay_full.json; do
    [ -f "$ITEM" ] || { printf 'Missing run file: %s\n' "$ITEM" >&2; exit 1; }
done
RUN_DIR="$PACKAGE_DIR/reruns/$(date +%Y%m%d_%H%M%S)_sphere_$$"
printf 'Starting a new 8-second sphere simulation. Loading/integration can take longer than 8 seconds.\nResults will be saved in: %s\n' "$RUN_DIR"
exec "$PACKAGE_DIR/.venv/bin/mjpython" "$PACKAGE_DIR/simulate.py" \
    --model "$PACKAGE_DIR/models/PNJEX_sphere_replay_full.xml" \
    --parameters "$PACKAGE_DIR/parameters/sphere_baseline_z60.json" \
    --name sphere_repeat_100g --record --view --output "$RUN_DIR"
