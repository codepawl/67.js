#!/usr/bin/env bash
# Everything the texture mip levels of #896 are checked with, in one run on a machine with a GPU, Rust and Node:
#   bash bench/cycles-parity/texture-mips-run-all.sh <outputDirectory>
# 1. builds the Cook addon of this checkout, and of a second Cook checkout for the baseline (COOK_BASE_DIR, its own cargo target);
# 2. cargo test of Cook (it lives in https://github.com/codepawl/cook, so it runs in COOK_DIR), then the node tests of the textures (the ones that need a GPU run, not skip);
# 3. the byte identity of five existing scenes on both kernels against the base build;
# 4. the error of a minified and a magnified checker with and without levels (texture-mips-bench.mjs).
# Each step keeps going after a failure and the last lines say which steps failed.
# COOK_DIR is the Cook checkout under test (default: the installed package), COOK_BASE_DIR the Cook checkout to compare against.
set -uo pipefail

output_directory=$(mkdir -p "$1" && cd "$1" && pwd)
candidate_checkout=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
baseline_checkout="${candidate_checkout}-base"
cook_directory="${COOK_DIR:-$candidate_checkout/node_modules/@codepawlhq/cook}"
: "${COOK_BASE_DIR:?set COOK_BASE_DIR to the Cook checkout to compare against}"
export COOK_DIR="$cook_directory" COOK_BASE_DIR
failed_steps=()

run_step() {
  local step_name="$1"
  shift
  echo "=== $step_name"
  if ! "$@" > "$output_directory/$step_name.log" 2>&1; then
    failed_steps+=("$step_name")
    echo "FAILED $step_name (tail of $output_directory/$step_name.log follows)"
    tail -n 40 "$output_directory/$step_name.log"
  fi
}

prepare_baseline_checkout() {
  rm -rf "$baseline_checkout"
  git -C "$candidate_checkout" worktree prune
  local base_commit="${BASELINE_REF:-$(git -C "$candidate_checkout" merge-base HEAD origin/main 2>/dev/null || echo 27ea525b)}"
  git -C "$candidate_checkout" worktree add --detach "$baseline_checkout" "$base_commit" \
    && ln -s "$candidate_checkout/node_modules" "$baseline_checkout/node_modules"
}

build_addon() {
  (cd "$1" && CARGO_TARGET_DIR="$2" node build.mjs)
}

run_step build-candidate build_addon "$cook_directory" "${CARGO_TARGET_DIR:-/root/cargo-target/candidate}"
run_step prepare-baseline prepare_baseline_checkout
run_step build-baseline build_addon "$COOK_BASE_DIR" /root/cargo-target/baseline
run_step cargo-test bash -c "set -o pipefail; cd '$cook_directory' && cargo test 2>&1 | tail -n 80"
run_step node-tests bash -c "cd '$candidate_checkout' && node --test tests/native-texture-mips.test.js tests/native-texture-sampler.test.js tests/native-pack-v2.test.js tests/native-job-materials.test.js"
run_step identity bash "$candidate_checkout/bench/cycles-parity/texture-mips-identity.sh" "$baseline_checkout" "$output_directory/identity"
run_step mips-bench node "$candidate_checkout/bench/cycles-parity/texture-mips-bench.mjs" "$output_directory/bench"

echo "=== summary"
grep -hE "^# (tests|pass|fail|skipped)|^ℹ (tests|pass|fail|skipped)|test result" "$output_directory"/cargo-test.log "$output_directory"/node-tests.log || true
tail -n 1 "$output_directory/identity.log" || true
if [ "${#failed_steps[@]}" -gt 0 ]; then
  echo "failed steps: ${failed_steps[*]}"
  exit 1
fi
echo "all steps passed"
