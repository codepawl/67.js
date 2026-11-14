import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const report = JSON.parse(readFileSync(new URL('../bench/runtime/report.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const EXPECTED_SCENES = ['instanced-objects', 'large-mesh', 'large-outdoor', 'many-lights', 'many-materials', 'moving-shadows', 'skinned-characters', 'transparency'];
const REQUIRED_MEASURES = ['firstFrameMilliseconds', 'fullFrameMilliseconds', 'renderCpuMilliseconds', 'gpuMegabytes', 'drawCalls', 'triangles'];

test('the runtime report covers every scene in both engines on both backends', () => {
  for (const backend of ['gpu', 'cpu']) {
    assert.deepEqual(Object.keys(report.results[backend]).sort(), EXPECTED_SCENES);
    for (const [scene, engines] of Object.entries(report.results[backend])) {
      for (const engine of ['crucible', 'three']) {
        for (const measure of REQUIRED_MEASURES) {
          assert.ok(Number.isFinite(engines[engine][measure]), `${backend} ${scene} ${engine} ${measure}`);
        }
      }
    }
  }
});

test('each picture difference is recorded, and the three.js version matches the package', () => {
  assert.equal(report.threeVersion, manifest.devDependencies.three);
  for (const scene of EXPECTED_SCENES) assert.ok(report.pictureDifference[`gpu-${scene}`] >= 0, scene);
});

test('each Crucible result lists its render targets, and they fit in the GPU memory the counter saw', () => {
  for (const backend of ['gpu', 'cpu']) {
    for (const [scene, engines] of Object.entries(report.results[backend])) {
      const targetMegabytes = engines['crucible'].renderTargets.reduce((total, target) => total + target.bytes, 0) / 1048576;
      assert.ok(targetMegabytes > 0 && targetMegabytes <= engines['crucible'].gpuMegabytes, `${backend} ${scene}`);
    }
  }
});

test('the report names real hardware and a software renderer, and no local paths', () => {
  assert.doesNotMatch(report.graphics.gpu, /swiftshader/i);
  assert.match(report.graphics.cpu, /swiftshader/i);
  assert.doesNotMatch(JSON.stringify(report), /[A-Z]:[\\/]Users/);
});
