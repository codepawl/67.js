#!/usr/bin/env bash
# Splits the frame cost into pieces: bash bench/glaze-passes/variants.sh <out-directory> <scene-directory>[,<scene-directory>]
# Runs the plain frame and the same frame with a trivial colour fragment shader (experiment only), back to back so both see the same load.
set -e
OUT="$1"
SCENES="$2"
node bench/glaze-passes/run.mjs "$OUT/plain.json" "$SCENES" segmented '{"frames":100}'
node bench/glaze-passes/run.mjs "$OUT/trivial-fragment.json" "$SCENES" segmented '{"experiment":"trivial-fragment","frames":100}'
node bench/glaze-passes/run.mjs "$OUT/plain-again.json" "$SCENES" segmented '{"frames":100}'
