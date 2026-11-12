#!/usr/bin/env bash
# Where does the metal floor's direct-light offset between Cook and Cycles come from? (#1104)
#   bash bench/cycles-parity/floor-direct-light-suite.sh <dataDirectory> [render|probe|report]...
# render: floor-only variants of the metal scene (sun, flat sky, constant sky, the real sky, both; straight down and from the metal
#   camera) with zero bounces on a Lambert floor, on both renderers.
# probe: the sky seen directly (no lighting), and the sky floor under other sampling choices, to say what Cycles does differently.
# report: each mean over its closed form, Cook over Cycles, the sky lookup fits.
# Needs a GPU box with Blender 5.3 (BLENDER_BIN, default ~/blender/blender) and the built addon. Existing images are kept.
set -uo pipefail

repository=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
data=$(mkdir -p "$1" && cd "$1" && pwd)
shift
blender_binary=${BLENDER_BIN:-$HOME/blender/blender}
uv_binary=${UV_BIN:-$HOME/.local/bin/uv}
width=256
height=144
samples=${SAMPLES:-256}
cd "$repository"

# A tag is <scene>[@<variant>]; the variant picks extra flags for one side.
cycles_flags_for() { # tag
  case "${1#*@}" in
    nosample) echo '--world-property sampling_method="NONE"' ;;
    res4096) echo '--world-property sample_map_resolution=4096' ;;
    nosun) echo '--world-property sun_threshold=0' ;;
    capafter) echo '--radiance-cap after-lookup' ;;
  esac
}

cook_flags_for() { # tag
  case "${1#*@}" in
  esac
}

render_cycles() { # tag seed samples extra...
  local tag=$1 seed=$2 spp=$3
  shift 3
  local prefix="$data/cycles-$tag-s$seed"
  [ -f "$prefix.npy" ] && return 0
  # shellcheck disable=SC2046
  "$blender_binary" -b --factory-startup --python bench/cycles-parity/render-cycles.py -- "$data/scenes/floor-${tag%%@*}.json" "$prefix" \
    --samples "$spp" --seed "$seed" --bounces 0 --width "$width" --height "$height" --grey-diffuse $(cycles_flags_for "$tag") "$@" > "$prefix.log" 2>&1 || echo "cycles $tag $seed failed" >&2
}

render_cook() { # tag seed samples extra...
  local tag=$1 seed=$2 spp=$3
  shift 3
  local prefix="$data/cookcycles-$tag-s$seed"
  [ -f "$prefix.npy" ] && return 0
  # shellcheck disable=SC2046
  node bench/cycles-parity/trace-native.mjs "$data/scenes/floor-${tag%%@*}.json" "$prefix" \
    --kernel cycles --samples "$spp" --seed "$seed" --bounces 0 --width "$width" --height "$height" --grey-diffuse $(cook_flags_for "$tag") "$@" > "$prefix.log" 2>&1 || echo "cook $tag $seed failed" >&2
}

render_variants() { # side entry...   entry = tag:seeds
  local side=$1 entry tag seed
  shift
  for entry in "$@"; do
    tag=${entry%%:*}
    for seed in $(seq 1 "${entry##*:}"); do
      "render_$side" "$tag" "$seed" "$samples"
    done
  done
}

both_sides() { # entry...
  render_variants cook "$@" &
  local cook_job=$!
  render_variants cycles "$@"
  wait "$cook_job"
}

stage_render() {
  mkdir -p "$data/scenes" "$data/hdri"
  [ -f "$data/scenes/metal.json" ] || node bench/cycles-parity/export-scene.mjs "$data" --scene metal | tail -1
  "$uv_binary" run --no-project python bench/cycles-parity/make-floor-scenes.py "$data"
  "$blender_binary" --version | head -1
  both_sides td-sun:4 td-flat-a:4 td-flat-b:4 td-const:4 td-sky:8 td-both:8 ob-sun:4 ob-sky:8 ob-both:8
  # Accumulation precision: the same sun-only picture at 32 and at 4096 samples.
  local spp
  for spp in 32 4096; do
    for seed in 1 2; do
      render_cook "td-sun@spp$spp" "$seed" "$spp"
      render_cycles "td-sun@spp$spp" "$seed" "$spp"
    done
  done
  local tag
  for tag in ob-sun ob-sky ob-both; do
    render_cycles "$tag@parts" 1 64 --part-ids
  done
}

stage_probe() {
  # The sky floor in Cycles with the sky found by BSDF sampling only, with a bigger importance map, and with its sun extraction off, and with the radiance limit applied after the lookup (what the script did before #1104).
  render_variants cycles td-sky@nosample:8 td-sky@res4096:8 td-sky@nosun:8 td-both@nosun:8 td-sky@capafter:8 td-both@capafter:8

  # The sky itself: 512 x 288 pictures of the background from level, 45 degrees up and straight up.
  width=512
  height=288
  both_sides sk-h:2 sk-45:2 sk-up:2
  render_variants cycles sk-45@capafter:2
}

fit_sky() { # label cyclesTag cookTag rows
  "$uv_binary" run --no-project --with numpy python bench/cycles-parity/sky-lookup-shift.py --label "$1" \
    --reference "$data/cycles-$2-s*.npy" --candidate "$data/cookcycles-${3}-s*.npy" --sky-rows "$4"
}

stage_report() {
  local tags="td-sun,td-flat-a,td-flat-b,td-const,td-sky,td-both,td-sky@nosample,td-sky@res4096,td-sky@nosun,td-both@nosun,td-sky@capafter,td-both@capafter"
  "$uv_binary" run --no-project --with numpy python bench/cycles-parity/floor-closed-form.py "$data" --tags "$tags"
  local tag
  for tag in ob-sun ob-sky ob-both; do
    "$uv_binary" run --no-project --with numpy python bench/cycles-parity/mean-ratio-seeds.py --label "oblique $tag, floor pixels" \
      --reference "$data/cycles-$tag-s*.npy" --candidate "$data/cookcycles-$tag-s*.npy" --parts "$data/cycles-$tag@parts-s1" | grep -av '^JSON'
  done
  local spp
  for spp in 32 4096; do
    "$uv_binary" run --no-project --with numpy python bench/cycles-parity/mean-ratio-seeds.py --label "td-sun at $spp spp" \
      --reference "$data/cycles-td-sun@spp$spp-s*.npy" --candidate "$data/cookcycles-td-sun@spp$spp-s*.npy" | grep -av '^JSON'
  done
  fit_sky "sky seen from the metal camera (rows above the horizon)" ob-sky ob-sky 18
  fit_sky "sky level, upper half" sk-h sk-h 130
  fit_sky "sky 45 degrees up" sk-45 sk-45 288
  fit_sky "sky 45 degrees up, Cycles with the old cap after the lookup" sk-45@capafter sk-45 288
  fit_sky "sky straight up" sk-up sk-up 288
}

if [ $# -eq 0 ]; then set -- render report; fi
for stage in "$@"; do
  echo "== stage $stage"
  "stage_$stage"
done
