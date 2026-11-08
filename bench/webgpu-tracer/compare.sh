#!/usr/bin/env bash
# Alternates the two backends three times at 1920 by 1080 and 64 samples, each trace as its own gpu-lock job (a light job).
# The first pair runs in fresh Chrome profiles (cold shader caches), the later pairs reuse them (warm).
#   bash bench/webgpu-tracer/compare.sh <output directory>
set -u
# GPU_LOCK, when set, prefixes each trace, for example a queue that serialises jobs on a shared card.
OUT="${1:?output directory}"
rm -rf "$OUT/profile-webgl" "$OUT/profile-webgpu"
for RUN in 1 2 3; do
  for VARIANT in webgpu webgl; do
    ${GPU_LOCK:-} node bench/webgpu-tracer/run.mjs "$OUT" "$VARIANT" --label "run$RUN" 2>&1 | cut -c1-1500
  done
done
