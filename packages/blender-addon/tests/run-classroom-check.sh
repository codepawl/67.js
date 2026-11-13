# Runs the Classroom demo through the add-on engine, then the Classroom parity driver, on the GPU machine (repository root).
# Usage: bash packages/blender-addon/tests/run-classroom-check.sh [samples]
export PATH=$HOME/.local/bin:$PATH
SAMPLES="${1:-256}"
export COOK_NATIVE_DIR=$PWD
mkdir -p artifacts/900/classroom-addon artifacts/classroom
(cd packages/render-native && node build.mjs) > artifacts/900/build3.log 2>&1
BLEND=$(ls $HOME/cook-data/classroom/*.blend $HOME/cook-data/classroom/*/*.blend 2>/dev/null | head -1)
echo "classroom blend on the box: ${BLEND:-none}"
if [ -z "$BLEND" ]; then
  mkdir -p $HOME/cook-data/classroom && (cd $HOME/cook-data/classroom && curl -sL -o classroom.zip https://download.blender.org/demo/test/classroom.zip && unzip -oq classroom.zip)
  BLEND=$(ls $HOME/cook-data/classroom/*.blend $HOME/cook-data/classroom/*/*.blend 2>/dev/null | head -1)
  echo "classroom blend after download: ${BLEND:-none}"
fi
echo "== classroom through the add-on engine (real materials, not grey)"
timeout 420 ~/blender/blender -b --factory-startup --disable-autoexec --python-exit-code 1 --python packages/blender-addon/tests/render_cook_and_cycles.py -- "blend:$BLEND" artifacts/900/classroom-addon 128 960 540 > artifacts/900/classroom-addon.log 2>&1
echo "addon render exit: $?"
grep -E "^(COOK|RENDER_DONE)|Error|Traceback" artifacts/900/classroom-addon.log | cut -c1-300 | head -60
uv run --no-project --with numpy --with pillow --with flip-evaluator python bench/cycles-parity/compare.py pair --no-flip --summary artifacts/900/classroom-addon/cycles.npy artifacts/900/classroom-addon/cook.npy 2>&1 | tail -3 | cut -c1-400
echo "== classroom parity driver (grey diffuse, shared scene reading)"
timeout 540 bash bench/cycles-parity/run-classroom-parity.sh --samples "$SAMPLES" 2>&1 | tail -60 | cut -c1-300
echo "driver exit: $?"
uv run --no-project python -c "
import json
s=json.load(open('artifacts/classroom/summary.json'))
print(json.dumps({k:s.get(k) for k in ('samples','errors','gates','parityGates','depth','blender')}, default=str)[:3000])" 2>&1 | head -20
