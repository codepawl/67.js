#!/usr/bin/env bash
# Alternates the native tracer and the browser WGSL kernel three times at 1920 by 1080 and 64 samples, each trace as its own
# gpu-lock job, then scores FLIP between each pair. It needs bench/webgpu-tracer from issue #625 (pull request #629).
#   bash bench/native-tracer/compare.sh <output directory>
set -u
# GPU_LOCK, when set, prefixes each trace, for example a queue that serialises jobs on a shared card.
OUT="${1:?output directory}"
for RUN in 1 2 3; do
  ${GPU_LOCK:-} node bench/native-tracer/run.mjs "$OUT" --label "run$RUN" 2>&1 | cut -c1-1500
  ${GPU_LOCK:-} node bench/webgpu-tracer/run.mjs "$OUT" webgpu --label "run$RUN" 2>&1 | cut -c1-1500
done
for RUN in 1 2 3; do
  echo "flip run$RUN native vs webgpu: $(uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/webgpu-tracer/flip.py "$OUT/webgpu-run$RUN.png" "$OUT/native-run$RUN.png")"
done
