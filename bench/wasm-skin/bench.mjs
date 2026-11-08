// Compares the per-frame skin kernel in JavaScript (src/skinning.js) with the same kernel in Rust compiled to WebAssembly.
// Build first: cargo build --release --target wasm32-unknown-unknown (in bench/wasm-skin). Then: node bench/wasm-skin/bench.mjs
// It records joint matrices from 8 animated RobotExpressive characters (the runtime benchmark's skinned-characters load),
// runs both kernels on the same frames, checks that the palettes match bit for bit, and prints medians.
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { parseGltf } from '../../src/gltf.js';
import { createSkinPose, skinInfluenceSets, updateSkinPose, validateSkinPose, matrixDeterminant } from '../../src/skinning.js';

const CHARACTERS = 8;
const RECORDED_FRAMES = 240;
const ROUNDS = 7;
const repository = new URL('../../', import.meta.url);

const fixture = await readFile(new URL('tests/fixtures/RobotExpressive.glb', repository));
const skinnedParts = [];
const frames = [];
for (let character = 0; character < CHARACTERS; character++) {
  const asset = await parseGltf(fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength), { maxVertices: 500000 });
  const parts = asset.parts.filter(part => part.skin);
  for (const part of parts) skinnedParts.push({ asset, character, part });
}
for (let frame = 0; frame < RECORDED_FRAMES; frame++) {
  const time = frame / 60;
  const assets = new Set(skinnedParts.map(entry => entry.asset));
  [...assets].forEach((asset, index) => asset.applyAnimation(time + index * 0.37, 0));
  frames.push(skinnedParts.map(({ part }) => ({ jointWorld: Float32Array.from(part.skin.jointWorldMatrices), meshWorld: Float32Array.from(part.matrix) })));
}
const jobs = skinnedParts.map(({ part }) => {
  const sets = skinInfluenceSets(part.geometry);
  return {
    part, count: part.skin.jointMatrices.length / 16, inverseBind: part.skin.inverseBindMatrices, bind: Float32Array.from(part.skin.bindMatrix),
    sets, setCount: sets.joints.length / 4, jsPose: createSkinPose(part.skin.jointMatrices.length / 16),
  };
});
const skinnedVertices = jobs.reduce((sum, job) => sum + job.part.geometry.skinWeights.length / 4, 0);
const distinctSets = jobs.reduce((sum, job) => sum + job.setCount, 0);

// JavaScript kernel: the calls prepareSkinBinding makes per skinned part per frame.
function javascriptFrame(frame) {
  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index];
    const input = frame[index];
    updateSkinPose(job.jsPose, input.jointWorld, job.inverseBind, input.meshWorld, job.bind);
    validateSkinPose(job.jsPose, job.part.geometry, input.meshWorld);
  }
}

// WebAssembly kernel: same work, plus copying the frame's matrices in and the palette out.
const wasmBytes = await readFile(new URL('bench/wasm-skin/target/wasm32-unknown-unknown/release/skin_kernel.wasm', repository));
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const kernel = instance.exports;
const floats = () => new Float32Array(kernel.memory.buffer);
const integers = () => new Int32Array(kernel.memory.buffer);
for (const job of jobs) {
  job.jointWorldPointer = kernel.allocate(job.count * 64);
  job.inverseBindPointer = kernel.allocate(job.count * 64);
  job.meshWorldPointer = kernel.allocate(64);
  job.bindPointer = kernel.allocate(64);
  job.palettePointer = kernel.allocate(job.count * 64);
  job.jointsPointer = kernel.allocate(job.setCount * 16);
  job.weightsPointer = kernel.allocate(job.setCount * 16);
  job.wasmPalette = new Float32Array(job.count * 16);
}
for (const job of jobs) {
  floats().set(job.inverseBind, job.inverseBindPointer / 4);
  floats().set(job.bind, job.bindPointer / 4);
  integers().set(job.sets.joints, job.jointsPointer / 4);
  floats().set(job.sets.weights, job.weightsPointer / 4);
}
function wasmFrame(frame) {
  const memory = floats();
  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index];
    const input = frame[index];
    memory.set(input.jointWorld, job.jointWorldPointer / 4);
    memory.set(input.meshWorld, job.meshWorldPointer / 4);
    let status = kernel.skin_update(job.count, job.jointWorldPointer, job.inverseBindPointer, job.meshWorldPointer, job.bindPointer, job.palettePointer);
    if (status === 0) status = kernel.skin_validate(job.palettePointer, job.count, job.jointsPointer, job.weightsPointer, job.setCount, matrixDeterminant(input.meshWorld, 0), 1);
    if (status !== 0) throw new Error(`WebAssembly kernel status ${status}`);
    job.wasmPalette.set(memory.subarray(job.palettePointer / 4, job.palettePointer / 4 + job.count * 16));
  }
}

// Same palettes, bit for bit, on every recorded frame.
let mismatches = 0;
for (const frame of frames) {
  javascriptFrame(frame);
  wasmFrame(frame);
  for (const job of jobs) {
    const left = new Uint32Array(job.jsPose.jointMatrices.buffer, job.jsPose.jointMatrices.byteOffset, job.count * 16);
    const right = new Uint32Array(job.wasmPalette.buffer);
    for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) mismatches++;
  }
}

function measure(runFrame) {
  const perFrame = [];
  for (let round = 0; round < ROUNDS; round++) {
    const started = performance.now();
    for (const frame of frames) runFrame(frame);
    perFrame.push((performance.now() - started) / frames.length);
  }
  perFrame.sort((a, b) => a - b);
  return perFrame;
}
// Warm both paths, then alternate the order so neither always runs on a hotter or colder machine.
measure(javascriptFrame);
measure(wasmFrame);
const javascriptTimes = [];
const wasmTimes = [];
for (let pass = 0; pass < 3; pass++) {
  if (pass % 2 === 0) { javascriptTimes.push(...measure(javascriptFrame)); wasmTimes.push(...measure(wasmFrame)); }
  else { wasmTimes.push(...measure(wasmFrame)); javascriptTimes.push(...measure(javascriptFrame)); }
}
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
const range = values => `${Math.min(...values).toFixed(4)} to ${Math.max(...values).toFixed(4)}`;
console.log(JSON.stringify({
  characters: CHARACTERS, skinnedParts: jobs.length, jointsPerPart: jobs[0].count, skinnedVertices, distinctInfluenceSets: distinctSets,
  wasmBytes: wasmBytes.length, paletteMismatches: mismatches,
  javascriptMsPerFrame: Number(median(javascriptTimes).toFixed(4)), javascriptRange: range(javascriptTimes),
  wasmMsPerFrame: Number(median(wasmTimes).toFixed(4)), wasmRange: range(wasmTimes),
  speedup: Number((median(javascriptTimes) / median(wasmTimes)).toFixed(2)),
}, null, 2));
