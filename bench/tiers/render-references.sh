#!/usr/bin/env bash
# Renders the Cycles 5.3 OptiX references the tier benchmark scores against (no denoiser, Box filter 1.0, clamps off, 8 bounces).
#   bash bench/tiers/render-references.sh <work directory> [scene,scene,...]
# Needs <work directory>/scenes/<scene>.json from bench/cycles-parity/export-scene.mjs. Each render goes through gpu-lock as a heavy job.
set -u
WORK_DIRECTORY="$1"
SCENE_LIST="${2:-lit-interior,spot-area,light-linking,metal,glass,outdoor-hdri}"
BLENDER_BIN="${BLENDER_BIN:-C:/Program Files/Blender Foundation/Blender 5.3/blender.exe}"
GPU_LOCK="$HOME/.agents/tools/gpu-lock.sh"
REFERENCE_SAMPLES="${REFERENCE_SAMPLES:-4096}"
mkdir -p "$WORK_DIRECTORY/reference"
IFS=',' read -ra SCENES <<< "$SCENE_LIST"
for SCENE in "${SCENES[@]}"; do
  PREFIX="$WORK_DIRECTORY/reference/$SCENE-cycles-$REFERENCE_SAMPLES-seed1"
  if [ -f "$PREFIX.json" ]; then
    echo "skip $SCENE"
    continue
  fi
  GPU_LOCK_WEIGHT=heavy bash "$GPU_LOCK" "$BLENDER_BIN" -b --factory-startup --python bench/cycles-parity/render-cycles.py -- \
    "$WORK_DIRECTORY/scenes/$SCENE.json" "$PREFIX" --samples "$REFERENCE_SAMPLES" --bounces 8 --seed 1 > "$WORK_DIRECTORY/reference/$SCENE.log" 2>&1
  echo "done $SCENE exit $?"
done
