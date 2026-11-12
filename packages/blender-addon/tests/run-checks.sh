#!/usr/bin/env bash
# Runs the add-on checks on the GPU machine, from the repository root: the Python tests, the exporter test in Blender, and the
# Cook against Cycles comparison for the fixture scenes. Needs Blender (BLENDER, default ~/blender/blender), node, uv and a Vulkan GPU.
# Usage: bash packages/blender-addon/tests/run-checks.sh [samples]
set -u
export PATH="$HOME/.local/bin:$PATH"
BLENDER="${BLENDER:-$HOME/blender/blender}"
SAMPLES="${1:-256}"
OUT=artifacts/900
mkdir -p "$OUT"
status=0

(cd packages/render-native && node build.mjs) > "$OUT/build.log" 2>&1 || { tail -5 "$OUT/build.log"; echo "BUILD FAILED"; exit 1; }
export COOK_NATIVE_DIR="$PWD"

echo "== python tests"
uv run --no-project --with numpy python -m unittest discover -s packages/blender-addon/tests -p "test_blender_conversions.py" 2>&1 | tail -4 || status=1

echo "== exporter test in Blender"
"$BLENDER" -b --factory-startup --python-exit-code 1 --python packages/blender-addon/tests/test_exporter_in_blender.py 2>&1 | grep -E "^(PASS|FAILED|[0-9]+ checks passed|Error|Traceback|  File|[A-Za-z]*Error)" | tail -60
exporter_exit=${PIPESTATUS[0]}
echo "exporter test exit code: $exporter_exit"
[ "$exporter_exit" = "0" ] || status=1

# render_and_compare <fixture variant> <output name>: Cycles and Cook at the same settings, then the compare.py gates.
render_and_compare() {
  local variant="$1" name="$2" gpu_lock=""
  echo "== render $name"
  [ -f "$HOME/.agents/tools/gpu-lock.sh" ] && gpu_lock="bash $HOME/.agents/tools/gpu-lock.sh"
  $gpu_lock "$BLENDER" -b --factory-startup --python-exit-code 1 --python packages/blender-addon/tests/render_cook_and_cycles.py -- "$variant" "$OUT/$name" "$SAMPLES" > "$OUT/$name.log" 2>&1
  local render_exit=$?
  grep -E "^(COOK|RENDER_DONE)|Error|Traceback" "$OUT/$name.log" | head -40
  echo "render exit code: $render_exit"
  [ "$render_exit" = "0" ] || { status=1; return; }
  uv run --no-project --with numpy --with pillow --with flip-evaluator python bench/cycles-parity/compare.py pair --no-flip --json-out "$OUT/$name/compare.json" --summary "$OUT/$name/cycles.npy" "$OUT/$name/cook.npy" 2>&1 | tail -8 | grep "^cook.npy"
}

for variant in small maps maps-normal maps-roughness maps-alpha hdri hdri-patch; do
  render_and_compare "$variant" "$variant"
done

# The environment cap: 16 is the packer's default and clips the patch; the add-on exports no cap unless asked.
COOK_TEST_ENVIRONMENT_CAP=16 render_and_compare hdri-patch hdri-patch-cap16

COOK_EXPERIMENT_FLIP_GREEN=1 render_and_compare maps-normal maps-normal-flipgreen

uv run --no-project --with numpy --with pillow python packages/blender-addon/tests/make_side_by_side.py "$OUT/cook-blender-addon-900.jpg" small="$OUT/small" "environment image"="$OUT/hdri" 2>&1 | tail -2
exit $status
