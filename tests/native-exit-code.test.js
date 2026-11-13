import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cookInstalled, cookModule, cookTest } from './support/cook.js';

const { findNativeAddon } = (await cookModule()) ?? {};
const skipWithoutAddon = !cookInstalled || findNativeAddon() === null ? 'the native addon is not built' : false;
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNS = 8;

// Renders once in a fresh process and lets it end on its own. Issue #1136: with the NVIDIA Vulkan driver the process used
// to die with SIGSEGV inside exit() because the GPU device was still open when the driver unloaded its libraries.
const RENDER_THEN_EXIT = `
import { buildNativeInputV2, traceNative } from '@codepawlhq/cook';
import { createCamera } from './src/path-tracer.js';
const quad = {
  positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  colors: new Float32Array(12).fill(1),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
const options = { width: 24, height: 16, samples: 16, bounces: 3, seed: 11 };
const scene = {
  materials: [{ color: [0.6, 0.6, 0.6], roughness: 0.8 }],
  instances: [{ geometry: quad, matrix: [8, 0, 0, 0, 0, 0, -8, 0, 0, 8, 0, 0, 0, 0, 0, 1], materialIndex: 0 }],
};
const camera = createCamera({ eye: [0, 2.2, 6], target: [0, 0.5, 0], fov: 45 }, options.width, options.height);
traceNative(buildNativeInputV2(scene, camera, options), { ...options, kernel: 'cycles' });
console.log('rendered');
`;

function runRenderThenExit() {
  return spawnSync(process.execPath, ['--input-type=module', '-e', RENDER_THEN_EXIT], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
}

cookTest('a process that rendered with the native addon exits with code 0', { skip: skipWithoutAddon }, (context) => {
  const probe = runRenderThenExit();
  if (probe.status !== 0 && /No Vulkan adapter|ray quer/i.test(probe.stderr)) {
    context.skip('this machine has no Vulkan adapter with ray queries');
    return;
  }
  const exitCodes = [probe.status];
  for (let run = 1; run < RUNS; run += 1) exitCodes.push(runRenderThenExit().status);
  assert.deepEqual(exitCodes, new Array(RUNS).fill(0), `exit codes of ${RUNS} render-and-exit runs`);
});
