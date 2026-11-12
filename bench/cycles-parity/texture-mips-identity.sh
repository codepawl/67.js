#!/usr/bin/env bash
# Are the pictures of the existing scenes unchanged by the mip level support? (#896)
#   bash bench/cycles-parity/texture-mips-identity.sh <baselineCheckout> <outputDirectory>
#
# Traces five scenes on both kernels with this checkout and with a checkout of the commit this branch was cut from, each with its
# own built addon, and compares the SHA-256 of the float pictures. Mip levels are off in all of them (the default). Prints one
# line per picture, then "identical" or "DIFFERENT" and exits 1 for a difference. Run it on a machine with a GPU.
set -uo pipefail

baseline_checkout=$(cd "$1" && pwd)
output_directory=$(mkdir -p "$2" && cd "$2" && pwd)
candidate_checkout=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
scenes_directory="$output_directory/scenes"
mkdir -p "$scenes_directory"

(cd "$candidate_checkout" && node bench/cycles-parity/texture-scenes.mjs "$output_directory" > /dev/null) || exit 2
for reference_scene in lit-interior glass brick-graph; do
  (cd "$candidate_checkout" && node bench/cycles-parity/export-scene.mjs "$output_directory" --scene "$reference_scene" > /dev/null) || exit 2
done

picture_hashes() {
  local checkout="$1"
  local label="$2"
  local scene
  local kernel
  for scene in lit-interior glass brick-graph tex-repeat tex-wraps; do
    for kernel in legacy cycles; do
      local prefix="$output_directory/$label-$scene-$kernel"
      if (cd "$checkout" && node bench/cycles-parity/trace-native.mjs "$scenes_directory/$scene.json" "$prefix" \
          --kernel "$kernel" --samples 16 --width 160 --height 90 --seed 1 > "$prefix.log" 2>&1); then
        echo "$scene $kernel $(sha256sum "$prefix.npy" | cut -d' ' -f1)"
      else
        echo "$scene $kernel FAILED"
      fi
    done
  done
}

picture_hashes "$baseline_checkout" baseline > "$output_directory/baseline.sha256"
picture_hashes "$candidate_checkout" candidate > "$output_directory/candidate.sha256"
paste -d'|' "$output_directory/baseline.sha256" "$output_directory/candidate.sha256" | tee "$output_directory/identity-table.txt"
if cmp -s "$output_directory/baseline.sha256" "$output_directory/candidate.sha256" && ! grep -q FAILED "$output_directory/candidate.sha256"; then
  echo identical
else
  echo DIFFERENT
  exit 1
fi
