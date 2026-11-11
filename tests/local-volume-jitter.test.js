// The start offset of a local volume's march (issue 855, owner report: smoke looks pixelated). A white-noise offset leaves clumps of
// error that read as grain at low step counts; interleaved gradient noise keeps neighbouring offsets apart. The shader repeats the
// formula below, so the test checks the shader source uses it and that the formula is the evenly spread one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fract = value => value - Math.floor(value);
const interleavedGradientNoise = (x, y) => fract(52.9829189 * fract(x * 0.06711056 + y * 0.00583715));
const whiteHash = (x, y) => fract(Math.sin(x * 127.1 + y * 311.7 + 74.7) * 43758.5453);

function blockMeanSpread(offsetAt, blockSize) {
  const size = 64;
  const means = [];
  for (let blockY = 0; blockY < size; blockY += blockSize) {
    for (let blockX = 0; blockX < size; blockX += blockSize) {
      let total = 0;
      for (let y = blockY; y < blockY + blockSize; y++) for (let x = blockX; x < blockX + blockSize; x++) total += offsetAt(x + 0.5, y + 0.5);
      means.push(total / (blockSize * blockSize));
    }
  }
  const average = means.reduce((sum, value) => sum + value, 0) / means.length;
  return Math.sqrt(means.reduce((sum, value) => sum + (value - average) ** 2, 0) / means.length);
}

test('interleaved gradient noise covers 0 to 1 evenly and clumps less than white noise in 4 by 4 blocks', () => {
  const values = [];
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) values.push(interleavedGradientNoise(x + 0.5, y + 0.5));
  assert.ok(values.every(value => value >= 0 && value < 1));
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(Math.abs(mean - 0.5) < 0.02, `mean ${mean}`);
  const gradientSpread = blockMeanSpread(interleavedGradientNoise, 4);
  const whiteSpread = blockMeanSpread(whiteHash, 4);
  assert.ok(gradientSpread < 0.5 * whiteSpread, `block spread ${gradientSpread} against white ${whiteSpread}`);
});

test('the local volume march starts from the interleaved gradient offset, not the sine hash', () => {
  const source = readFileSync(new URL('../src/fog-shader.js', import.meta.url), 'utf8');
  assert.match(source, /float localVolumeJitter\(\)[\s\S]*?52\.9829189[\s\S]*?0\.06711056, 0\.00583715/);
  assert.match(source, /float jitter = fract\(localVolumeJitter\(\) \+ float\(nearest\) \* 0\.618034\);/);
  assert.doesNotMatch(source, /hash\(vec3\(gl_FragCoord\.xy, float\(nearest\)/);
});
