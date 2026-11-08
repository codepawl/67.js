#!/usr/bin/env bash
# Alternates the WebGL2 kernel and the two WebGPU kernels three times at 1920 by 1080 and 64 samples, each trace as its own gpu-lock job (a light job).
# The first pair runs in fresh Chrome profiles (cold shader caches), the later pairs reuse them (warm).
#   bash bench/webgpu-tracer/compare.sh <output directory>
set -u
GPU_LOCK="${GPU_LOCK:-gpu-lock.sh}"  # path of the machine GPU lock script
OUT="${1:?output directory}"
rm -rf "$OUT/profile-webgl" "$OUT/profile-wavefront" "$OUT/profile-megakernel"
for RUN in 1 2 3; do
  for VARIANT in wavefront megakernel webgl; do
    bash "$GPU_LOCK" node bench/webgpu-tracer/run.mjs "$OUT" "$VARIANT" --label "run$RUN" 2>&1 | cut -c1-1500
  done
done
