#!/usr/bin/env bash
# Mean radiance of Cook against Cycles on the metal scene over many seeds, and the splits that find where a gap comes from (#959).
#   bash bench/cycles-parity/metal-mean-suite.sh <dataDirectory> <stage>...
# Stages: build, main, relmse, splits, direct (the zero-bounce split alone). Needs a GPU box with Blender 5.3 (BLENDER_BIN, default ~/blender/blender) and the built addon.
# Every image is <dataDirectory>/<side>-<tag>-s<seed>.npy; existing images are kept, so a stage can be repeated.
set -uo pipefail

repository=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
data=$(mkdir -p "$1" && cd "$1" && pwd)
shift
blender_binary=${BLENDER_BIN:-$HOME/blender/blender}
uv_binary=${UV_BIN:-$HOME/.local/bin/uv}
scene="$data/scenes/metal.json"
seed_count=${SEED_COUNT:-24}
cd "$repository"

render_cycles() { # tag samples seed extra...
  local tag=$1 samples=$2 seed=$3
  shift 3
  local prefix="$data/cycles-$tag-s$seed"
  [ -f "$prefix.npy" ] && return 0
  "$blender_binary" -b --factory-startup --python bench/cycles-parity/render-cycles.py -- "$scene" "$prefix" --samples "$samples" --seed "$seed" "$@" > "$prefix.log" 2>&1 || echo "cycles $tag $seed failed" >&2
}

render_cook() { # kernel tag samples seed extra...
  local kernel=$1 tag=$2 samples=$3 seed=$4
  shift 4
  local prefix="$data/cook$kernel-$tag-s$seed"
  [ -f "$prefix.npy" ] && return 0
  node bench/cycles-parity/trace-native.mjs "$scene" "$prefix" --kernel "$kernel" --samples "$samples" --seed "$seed" "$@" > "$prefix.log" 2>&1 || echo "cook $kernel $tag $seed failed" >&2
}

report() { # label referenceGlob candidateGlob extra...
  local label=$1 reference=$2 candidate=$3
  shift 3
  "$uv_binary" run --no-project --with numpy python bench/cycles-parity/mean-ratio-seeds.py --label "$label" --reference "$reference" --candidate "$candidate" "$@" | grep -av '^JSON'
}

stage_build() {
  npm run cook:build 2>&1 | tail -2
  mkdir -p "$data/scenes"
  node bench/cycles-parity/export-scene.mjs "$data" --scene metal 2>&1 | tail -2
  ls "$data/scenes" 2>&1
  "$blender_binary" --version | head -1
}

stage_main() {
  for seed in $(seq 1 "$seed_count"); do
    render_cycles m1024 1024 "$seed"
    render_cook cycles m1024 1024 "$seed"
    render_cook legacy m1024 1024 "$seed"
  done
  render_cycles parts4096 4096 1 --part-ids --keep-exr
  report "metal 1024 spp x$seed_count seeds, cycles kernel" "$data/cycles-m1024-s*.npy" "$data/cookcycles-m1024-s*.npy" --parts "$data/cycles-parts4096-s1"
  report "metal 1024 spp x$seed_count seeds, legacy kernel" "$data/cycles-m1024-s*.npy" "$data/cooklegacy-m1024-s*.npy" --parts "$data/cycles-parts4096-s1"
  report "control: Cycles seeds 1-6 against seeds 7-12" "$data/cycles-m1024-s[789].npy,$data/cycles-m1024-s1[012].npy" "$data/cycles-m1024-s[123456].npy" 2>&1 || true
}

stage_relmse() {
  render_cycles ref4096 4096 1
  render_cycles ref4096 4096 2
  for seed in 1 2 3 4; do
    render_cycles r256 256 "$seed"
    render_cook cycles r256 256 "$seed"
    render_cook legacy r256 256 "$seed"
  done
  local reference="$data/cycles-ref4096-s1.npy"
  report "256 spp relMSE vs Cycles 4096 seed 1, cycles kernel" "$data/cycles-r256-s[234].npy" "$data/cookcycles-r256-s*.npy" --rel-mse-reference "$reference" --rel-mse-skip-worst 100
  report "256 spp relMSE vs Cycles 4096 seed 1, legacy kernel" "$data/cycles-r256-s[234].npy" "$data/cooklegacy-r256-s*.npy" --rel-mse-reference "$reference" --rel-mse-skip-worst 100
  report "4096 spp seed 2 against seed 1 (noise floor of the reference)" "$data/cycles-ref4096-s1.npy" "$data/cycles-ref4096-s2.npy" --rel-mse-reference "$data/cycles-ref4096-s1.npy" --rel-mse-skip-worst 100
}

split_pair() { # tag samples seeds cookFlags -- cyclesFlags
  local tag=$1 samples=$2 seeds=$3
  shift 3
  local cook_flags=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do cook_flags+=("$1"); shift; done
  shift
  for seed in $(seq 1 "$seeds"); do
    render_cycles "$tag" "$samples" "$seed" "$@"
    render_cook cycles "$tag" "$samples" "$seed" "${cook_flags[@]}"
  done
  report "split $tag" "$data/cycles-$tag-s*.npy" "$data/cookcycles-$tag-s*.npy" --parts "$data/cycles-parts4096-s1"
}

stage_direct() {
  render_cycles parts4096 4096 1 --part-ids
  split_pair b0 512 6 --bounces 0 -- --bounces 0
}

stage_splits() {
  split_pair b0 512 6 --bounces 0 -- --bounces 0
  split_pair b1 512 6 --bounces 1 -- --bounces 1
  split_pair b2 512 6 --bounces 2 -- --bounces 2
  split_pair b4 512 6 --bounces 4 -- --bounces 4
  split_pair clamp10 512 6 --clamp-indirect 10 --clamp-direct 10 -- --cycles-property sample_clamp_indirect=10 --cycles-property sample_clamp_direct=10
}

for stage in "$@"; do
  echo "== stage $stage"
  "stage_$stage"
done
