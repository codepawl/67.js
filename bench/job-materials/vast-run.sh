#!/usr/bin/env bash
# The checks of #1036 on a GPU box with Blender, Chrome and the Rust toolchain. Run from the repository root:
#   bash bench/job-materials/vast-run.sh <base branch> <stage...>
# Stages: build, tests, identity, parity, size. Outputs go to artifacts/job-materials/ (identity-<tree>/, parity/).
# The base branch is built in a second work tree next to this one, so one run compares real jobs of both.
set -uo pipefail
base_branch="${1#origin/}"
shift
out="artifacts/job-materials"
mkdir -p "$out"
here="$(pwd)"
base_tree="$here/../job-materials-base"
chrome_wrapper="/root/chrome-gpu.sh"
printf '#!/bin/sh\nexec "%s" --use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist --no-sandbox "$@"\n' "$CHROME_PATH" > "$chrome_wrapper"
chmod +x "$chrome_wrapper"

build_tree() {
  (cd "$1" && npm run build >/dev/null 2>&1 && (cd packages/render-native && node build.mjs 2>&1 | tail -2)) || echo "BUILD-FAILED $1"
}

for stage in "$@"; do
  echo "=== stage $stage"
  case "$stage" in
    build)
      if [ ! -d "$base_tree" ]; then
        git fetch -q origin "$base_branch" && git worktree add --force "$base_tree" FETCH_HEAD >/dev/null 2>&1
        ln -s "$here/node_modules" "$base_tree/node_modules"
      fi
      build_tree "$here"
      build_tree "$base_tree"
      ;;
    tests)
      node --test tests/native-job-materials.test.js tests/native-instancing-fallback.test.js tests/native-instancing-materials.test.js tests/native-instancing-transport.test.js tests/native-instancing-equivalence.test.js 2>&1 | grep -E "^(✖|ℹ (tests|pass|fail|skipped))|Error" | head -20
      ;;
    identity)
      for tree in "$here" "$base_tree"; do
        label="$(basename "$tree")"
        echo "--- $label"
        node bench/job-materials/job-run.mjs "$tree/bin/67js-mcp.mjs" "$out/identity-$label" 256 room textured shared glass --browser "$chrome_wrapper" 2>&1 | tail -12
      done
      ;;
    parity)
      folder="$out/parity"
      mkdir -p "$folder"
      node bench/job-materials/parity.mjs describe "$folder" 2>&1 | tail -3
      blender_binary="$( (command -v blender; ls -d /opt/blender*/blender /usr/local/blender*/blender /root/blender*/blender /usr/local/bin/blender* 2>/dev/null ; find / -maxdepth 4 -name blender -type f 2>/dev/null) | head -1)"
      echo "blender: ${blender_binary:-none}"
      for scene in blend sheen specular-tint anisotropy iridescence absorption composite; do
        "$blender_binary" -b --factory-startup --python bench/cycles-parity/render-cycles.py -- "$folder/$scene.json" "$folder/$scene-cycles" --samples 4096 --bounces 8 --seed 1 --width 192 --height 128 > "$folder/$scene-cycles.log" 2>&1 || tail -5 "$folder/$scene-cycles.log" | cut -c1-200
      done
      ls "$folder" | head -40
      node bench/job-materials/parity.mjs cook "$folder" 4096 2>&1 | tail -10
      node bench/job-materials/parity.mjs before "$folder" 4096 2>&1 | tail -10
      python_binary=python3
      python3 -c 'import numpy' 2>/dev/null || python_binary="$(find /root/blender -maxdepth 4 -path '*bin*' -name 'python3*' -type f 2>/dev/null | head -1)"
      echo "python: $python_binary"
      for scene in blend sheen specular-tint anisotropy iridescence absorption composite; do
        for variant in cook before; do
          "$python_binary" bench/cycles-parity/compare.py pair --no-flip --json-out "$folder/$scene-$variant-compare.json" "$folder/$scene-cycles.npy" "$folder/$scene-$variant.npy" >/dev/null 2>&1 || echo "COMPARE-FAILED $scene $variant"
        done
      done
      node bench/job-materials/figure.mjs "$folder" composite "$out/composite.jpg" 2>&1 | tail -2
      ;;
    size)
      npm run size > "$out/size.txt" 2>&1
      grep -n -E "scene:|entry:(core|render|path|agent)|Base|base|vs" "$out/size.txt" | head -40
      ;;
  esac
done
