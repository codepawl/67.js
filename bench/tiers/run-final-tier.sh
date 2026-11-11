#!/usr/bin/env bash
# The final tier: Cook (cpu, gpu, webgpu, native) against Cycles 5.3 OptiX on one scene, interleaved, three repetitions.
#   bash bench/tiers/run-final-tier.sh <work directory> [scene] [repetitions]
# Needs <work directory>/scenes/<scene>.json and the Cycles reference from render-references.sh. Light jobs go through gpu-lock one by one.
# Per repetition and sample count the engines run back to back (cpu, gpu, webgpu, native, cycles), so a drifting load hits all of them.
set -u
WORK_DIRECTORY="$1"
SCENE="${2:-lit-interior}"
REPETITIONS="${3:-3}"
BLENDER_BIN="${BLENDER_BIN:-C:/Program Files/Blender Foundation/Blender 5.3/blender.exe}"
GPU_LOCK="$HOME/.agents/tools/gpu-lock.sh"
SCENE_JSON="$WORK_DIRECTORY/scenes/$SCENE.json"
LADDER_DIRECTORY="$WORK_DIRECTORY/final-$SCENE"
mkdir -p "$LADDER_DIRECTORY"

run_cook() {
  local backend="$1" samples="$2" repetition="$3"
  [ -f "$LADDER_DIRECTORY/$SCENE-cook-$backend-s$samples-r$repetition.json" ] && return
  bash "$GPU_LOCK" node bench/tiers/run-cook.mjs "$LADDER_DIRECTORY" "$SCENE" --backend "$backend" --samples "$samples" --repetitions 1 --first-repetition "$repetition" 2>&1 | grep -v "^$" | tail -2
}

run_measured() {
  local prefix="$1"
  shift
  [ -f "$prefix.metrics.json" ] && return
  bash "$GPU_LOCK" uv run --no-project --with psutil python bench/cycles-parity/measure-gpu-run.py "$prefix.metrics.json" -- "$@" 2>&1 | tail -1 | cut -c1-200
}

run_native() {
  local samples="$1" repetition="$2"
  local prefix="$LADDER_DIRECTORY/$SCENE-native-s$samples-r$repetition"
  run_measured "$prefix" node bench/cycles-parity/trace-native.mjs "$SCENE_JSON" "$prefix" --samples "$samples" --bounces 8 --seed 1 --firefly-clamp 1000000000 --noise-threshold 0
}

run_cycles() {
  local samples="$1" repetition="$2"
  local prefix="$LADDER_DIRECTORY/$SCENE-cycles-s$samples-r$repetition"
  run_measured "$prefix" "$BLENDER_BIN" -b --factory-startup --python bench/cycles-parity/render-cycles.py -- "$SCENE_JSON" "$prefix" --samples "$samples" --bounces 8 --seed 1
}

for repetition in $(seq 1 "$REPETITIONS"); do
  for samples in 64 256 1024; do
    # Three repetitions at 256 samples, where the equal-error reading is taken; the other counts run once.
    [ "$repetition" -gt 1 ] && [ "$samples" -ne 256 ] && continue
    [ "$samples" -le 256 ] && run_cook cpu "$samples" "$repetition"
    run_cook gpu "$samples" "$repetition"
    run_cook webgpu "$samples" "$repetition"
    run_native "$samples" "$repetition"
    [ "$samples" -le 256 ] && run_cycles "$samples" "$repetition"
    [ "$samples" -eq 1024 ] && [ "$repetition" -eq 1 ] && run_cycles 1024 1
    echo "done rep $repetition samples $samples"
  done
done
# Higher sample counts, once: where the error of the GPU backends and the native tracer crosses the Cycles 256 sample error.
for samples in 2048 4096; do
  run_cook gpu "$samples" 1
  run_cook webgpu "$samples" 1
  run_native "$samples" 1
  echo "done extra samples $samples"
done
echo "all done"
