#!/usr/bin/env bash
# Runs the Classroom parity driver on the GPU machine from the repository root: build the addon, then the driver.
# Usage: bash bench/cycles-parity/run-classroom-parity.sh [driver options]
set -u
export PATH="$HOME/.local/bin:$PATH"
mkdir -p artifacts/classroom
npm run cook:build > artifacts/classroom/build.log 2>&1
tail -1 artifacts/classroom/build.log
if ! command -v uv > /dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | sh > artifacts/classroom/uv-install.log 2>&1
fi
uv run --no-project --with numpy --with pillow --with flip-evaluator python bench/cycles-parity/run-classroom-parity.py "$@" 2>&1 | tail -150
