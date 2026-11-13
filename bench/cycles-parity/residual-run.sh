#!/usr/bin/env bash
# Splits the texture residuals of #1030 against Blender Cycles: cutout brightness, textured emitter light samples, brick-graph.
#   bash bench/cycles-parity/residual-run.sh <outputDirectory> [samples]
# Needs the built addon and Blender 5.3 (BLENDER_BIN, default ~/blender/blender). Prints one table per scene; run it on a GPU machine.
# Environment: SCENES (space separated, default all), SKIP_EXISTING=1 keeps a Cycles picture already in the output directory,
# TABLES_ONLY=1 renders nothing and only prints the tables of the pictures there, COOK_CHECKOUT is the checkout whose built addon
# and trace script render the Cook pictures (default: this one), to run the same scenes on another build.
set -uo pipefail

output_directory=$(mkdir -p "$1" && cd "$1" && pwd)
samples="${2:-1024}"
blender_binary="${BLENDER_BIN:-$HOME/blender/blender}"
scenes_directory="$output_directory/scenes"
scene_list="${SCENES:-mask-base mask-world-only mask-lights-only mask-binary-alpha mask-two-level-alpha mask-off-tie-ramp mask-all-holes tex-emit-floor brick-graph brick-no-normal-map brick-flat}"
cook_checkout=$(cd "${COOK_CHECKOUT:-.}" && pwd)
export PATH="$HOME/.local/bin:$PATH"

node bench/cycles-parity/residual-variants.mjs "$output_directory" > /dev/null || exit 2

render_cook() {
  local scene="$1" label="$2"
  shift 2
  [ -n "${TABLES_ONLY:-}" ] && return
  (cd "$cook_checkout" && node bench/cycles-parity/trace-native.mjs "$scenes_directory/$scene.json" "$output_directory/cook-$label" \
    --kernel cycles --samples "$samples" --seed 1 "$@") > "$output_directory/cook-$label.log" 2>&1 || echo "cook $label FAILED"
}

render_cycles() {
  local scene="$1" label="$2"
  shift 2
  [ -n "${TABLES_ONLY:-}" ] && return
  [ -n "${SKIP_EXISTING:-}" ] && [ -f "$output_directory/cycles-$label.npy" ] && return
  "$blender_binary" -b --factory-startup --python bench/cycles-parity/render-cycles.py -- \
    "$scenes_directory/$scene.json" "$output_directory/cycles-$label" --samples "$samples" --seed 1 "$@" \
    > "$output_directory/cycles-$label.log" 2>&1 || echo "cycles $label FAILED"
}

table() {
  uv run --no-project --with numpy python bench/cycles-parity/residual-table.py "$output_directory/cook-$1" "$output_directory/cycles-$2" "$3"
}

for scene in $scene_list; do
  render_cook "$scene" "$scene"
  render_cycles "$scene" "$scene"
  table "$scene" "$scene" "$scene"
done

case " $scene_list " in
  *" mask-base "*)
    # Transparent bounce limit raised on both sides.
    render_cook mask-base mask-base-t64 --transparent-bounces 64
    render_cycles mask-base mask-base-t64 --transparent-bounces 64
    table mask-base-t64 mask-base-t64 "mask-base transparent-bounces 64"
    # Cook with the cutoff nudged, against the unchanged Cycles picture of mask-base.
    for nudged in mask-cutoff-low mask-cutoff-high; do
      render_cook "$nudged" "$nudged"
      table "$nudged" mask-base "$nudged against Cycles mask-base"
    done
    # Does a gradient in the stored alpha move Cook and Cycles by the same amount? Each renderer's gradient picture over its binary one.
    for renderer in cook cycles; do
      uv run --no-project --with numpy python bench/cycles-parity/residual-table.py         "$output_directory/$renderer-mask-base" "$output_directory/$renderer-mask-binary-alpha" "$renderer: mask-base over mask-binary-alpha"
    done
    ;;
esac

case " $scene_list " in
  *" tex-emit-floor "*)
    # Light sampling alone and bounce rays alone on the textured emitter, each against the Cycles picture.
    render_cook tex-emit-floor floor-nee --direct-lighting nee-only
    render_cook tex-emit-floor floor-bsdf --direct-lighting bsdf-only
    table floor-nee tex-emit-floor "tex-emit-floor nee-only"
    table floor-bsdf tex-emit-floor "tex-emit-floor bsdf-only"
    ;;
esac
