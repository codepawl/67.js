#!/usr/bin/env bash
# Renders scenes in Blender 5.3 EEVEE (default and lowest presets), timing the first frame and ten more, three repetitions, alternating the preset order.
#   bash bench/tiers/run-eevee.sh <work directory> <scene,scene,...> [width] [repetitions]
# Needs <work directory>/scenes/<scene>.json. Output: <work directory>/eevee/<scene>-<preset>-<width>-r<n>.{npy,json,metrics.json}
set -u
WORK_DIRECTORY="$1"
SCENE_LIST="$2"
WIDTH="${3:-960}"
REPETITIONS="${4:-3}"
HEIGHT=$((WIDTH * 9 / 16))
BLENDER_BIN="${BLENDER_BIN:-C:/Program Files/Blender Foundation/Blender 5.3/blender.exe}"
GPU_LOCK="${GPU_LOCK:-}"  # set to a job queue command, for example GPU_LOCK="bash path/to/gpu-lock.sh", to share the card
mkdir -p "$WORK_DIRECTORY/eevee"
IFS=',' read -ra SCENES <<< "$SCENE_LIST"
for repetition in $(seq 1 "$REPETITIONS"); do
  if [ $((repetition % 2)) -eq 1 ]; then PRESETS="lowest default"; else PRESETS="default lowest"; fi
  for scene in "${SCENES[@]}"; do
    for preset in $PRESETS; do
      prefix="$WORK_DIRECTORY/eevee/$scene-$preset-$WIDTH-r$repetition"
      [ -f "$prefix.metrics.json" ] && continue
      $GPU_LOCK uv run --no-project --with psutil python bench/cycles-parity/measure-gpu-run.py "$prefix.metrics.json" -- \
        "$BLENDER_BIN" -b --factory-startup --python bench/tiers/render-eevee.py -- "$WORK_DIRECTORY/scenes/$scene.json" "$prefix" \
        --preset "$preset" --width "$WIDTH" --height "$HEIGHT" --frames 10 2>&1 | grep "EEVEE_TIMING" | cut -c1-160
    done
  done
done
echo "eevee done"
