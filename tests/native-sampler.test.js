import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  findNativeAddon,
  probeCyclesLobe,
  traceNative,
} from '../packages/render-native/index.mjs';
import { KERNEL_FLAG_WHITE_NOISE_SAMPLER, validatePackOptions } from '../packages/render-native/pack-input-v2.mjs';

const referencePath = new URL('../bench/cycles-parity/sampler-reference.json', import.meta.url);
const reference = JSON.parse(readFileSync(referencePath, 'utf8'));
const hasAddon = findNativeAddon() !== null;
const skipWithoutAddon = hasAddon ? false : 'the native addon is not built';
const FLOAT_TOLERANCE = 2e-7;

function probeSampler({ dimensionSet, sampleOffset, count }) {
  const planes = probeCyclesLobe({
    width: count,
    height: 1,
    mode: 100,
    seed: dimensionSet,
    sampleOffset,
  });
  const bits = new Uint32Array(planes.buffer, planes.byteOffset, planes.length);
  const planeStride = count * 4;
  const read = (plane, slot, component) => planes[plane * planeStride + slot * 4 + component];
  const readBits = (plane, slot, component) => bits[plane * planeStride + slot * 4 + component];
  return { read, readBits };
}

function assertClose(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= FLOAT_TOLERANCE, `${label}: got ${actual}, expected ${expected}`);
}

test('the sampler options are validated with a message that names the accepted values', () => {
  assert.doesNotThrow(() => validatePackOptions({ sampler: 'sobol-burley' }, 'test'));
  assert.doesNotThrow(() => validatePackOptions({ sampler: 'white' }, 'test'));
  assert.throws(() => validatePackOptions({ sampler: 'halton' }, 'test'), /"sobol-burley" \(default\) or "white"/);
  assert.equal(KERNEL_FLAG_WHITE_NOISE_SAMPLER, 64);
});

test('the first points of every dimension set match the independent port of the Cycles functions', { skip: skipWithoutAddon }, () => {
  let compared = 0;
  for (const dimensionSet of reference.dimensionSets) {
    for (const sampleOffset of reference.blockStarts) {
      const probe = probeSampler({ dimensionSet, sampleOffset, count: reference.blockLength });
      const entries = reference.entries.filter(
        (entry) => entry.dimensionSet === dimensionSet
          && entry.index >= sampleOffset
          && entry.index < sampleOffset + reference.blockLength,
      );
      assert.equal(entries.length, reference.blockLength);
      for (const entry of entries) {
        const slot = entry.index - sampleOffset;
        const label = `set ${dimensionSet} index ${entry.index}`;
        entry.sample4.forEach((expected, component) => assertClose(probe.read(0, slot, component), expected, `${label} 4D[${component}]`));
        assertClose(probe.read(1, slot, 0), entry.sample1[0], `${label} 1D`);
        assertClose(probe.read(1, slot, 1), entry.sample2[0], `${label} 2D[0]`);
        assertClose(probe.read(1, slot, 2), entry.sample2[1], `${label} 2D[1]`);
        assertClose(probe.read(1, slot, 3), entry.sample3[0], `${label} 3D[0]`);
        assertClose(probe.read(3, slot, 0), entry.sample3[1], `${label} 3D[1]`);
        assertClose(probe.read(3, slot, 1), entry.sample3[2], `${label} 3D[2]`);
        assert.equal(probe.readBits(2, slot, 0), entry.hashUint, `${label} hash_uint`);
        assert.equal(probe.readBits(2, slot, 1), entry.morton, `${label} morton2d`);
        assert.equal(probe.readBits(2, slot, 2), entry.nestedBase4, `${label} nested_uniform_scramble_base4`);
        assert.equal(probe.readBits(2, slot, 3), entry.hashHp, `${label} hash_hp_uint`);
        compared += 1;
      }
    }
  }
  assert.ok(compared >= 500, `compared only ${compared} points`);
});

test('aligned blocks of the sequence are stratified and the mean and variance are uniform', { skip: skipWithoutAddon }, () => {
  const count = 4096;
  const probe = probeSampler({ dimensionSet: 3, sampleOffset: 0, count });
  const blockLength = 256;
  for (let blockStart = 0; blockStart < count; blockStart += blockLength) {
    const oneDimensionalStrata = new Set();
    const twoDimensionalCells = new Set();
    for (let slot = blockStart; slot < blockStart + blockLength; slot += 1) {
      oneDimensionalStrata.add(Math.floor(probe.read(1, slot, 0) * blockLength));
      const cellX = Math.floor(probe.read(1, slot, 1) * 16);
      const cellY = Math.floor(probe.read(1, slot, 2) * 16);
      twoDimensionalCells.add(cellX * 16 + cellY);
    }
    assert.equal(oneDimensionalStrata.size, blockLength, `1D block at ${blockStart} misses a stratum`);
    assert.equal(twoDimensionalCells.size, blockLength, `2D block at ${blockStart} misses a 16x16 cell`);
  }

  for (let component = 0; component < 4; component += 1) {
    let sum = 0;
    let sumOfSquares = 0;
    for (let slot = 0; slot < count; slot += 1) {
      const value = probe.read(0, slot, component);
      assert.ok(value >= 0 && value < 1, `4D[${component}] left [0, 1): ${value}`);
      sum += value;
      sumOfSquares += value * value;
    }
    const mean = sum / count;
    const variance = sumOfSquares / count - mean * mean;
    assert.ok(Math.abs(mean - 0.5) < 0.002, `4D[${component}] mean ${mean}`);
    assert.ok(Math.abs(variance - 1 / 12) < 0.002, `4D[${component}] variance ${variance}`);
  }
});

test('traceNative rejects an unknown sampler before it reaches the GPU', () => {
  assert.throws(
    () => traceNative({}, { width: 16, height: 16, samples: 1, kernel: 'cycles', sampler: 'halton' }),
    /"sobol-burley" \(default\) or "white"/,
  );
});
