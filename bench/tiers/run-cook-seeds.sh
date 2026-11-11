#!/usr/bin/env bash
# Cook traces of 256 samples with seeds 2 to 8, for the gpu and webgpu backends, interleaved; score-tiers.py averages them with the seed 1 trace
# into 512 to 2048 samples, because one Cook trace is limited in size.
#   bash bench/tiers/run-cook-seeds.sh <work directory> [scene] [last seed]
set -u
WORK_DIRECTORY="$1"
SCENE="${2:-lit-interior}"
LAST_SEED="${3:-8}"
GPU_LOCK="$HOME/.agents/tools/gpu-lock.sh"
for seed in $(seq 2 "$LAST_SEED"); do
  for backend in gpu webgpu; do
    [ -f "$WORK_DIRECTORY/final-$SCENE/$SCENE-cook-$backend-s256-seed$seed.json" ] && continue
    bash "$GPU_LOCK" node bench/tiers/run-cook.mjs "$WORK_DIRECTORY/final-$SCENE" "$SCENE" --backend "$backend" --samples 256 --repetitions 1 --seed "$seed" 2>&1 | tail -1
  done
done
echo "seeds done"
