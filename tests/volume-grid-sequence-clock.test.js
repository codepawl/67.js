// A recipe whose only animation is a grid sequence still gets a clock (#1045): sampleMotion and the film timeline accept it, and two times give two frames.
import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { normalizeFilmTimeline, sampleFilmTimeline } from '../src/film-timeline.js';
import { encodeVolumeGrid, registerVolumeGrid } from '../src/volume-grid.js';
import { findVolumeGridSequence, volumeGridFrameIndex } from '../src/volume-grid-sequence.js';
import { bindLocalVolumeParts } from '../src/local-volume-parts.js';
import { resolveLocalVolumes } from '../src/local-volumes.js';

const FRAME_NAMES = ['clock-0', 'clock-1', 'clock-2', 'clock-3'];

function registerFrames() {
  FRAME_NAMES.forEach((name, index) => {
    registerVolumeGrid(name, encodeVolumeGrid({ resolution: [2, 2, 2], size: [1, 1, 1], channels: { density: new Float32Array(8).fill(index) } }));
  });
}

function gridOnlyRecipe(extra = {}) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'grey', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'block', geometry: 'box', material: 'grey' }],
    camera: { eye: [0, 1, 6], target: [0, 0, 0], fov: 40 },
    environment: { localVolumes: [{ shape: 'grid', frames: FRAME_NAMES, fps: 2, center: [0, 1, 0], size: [1, 1, 1] }] },
    ...extra,
  };
}

function frameAt(environment) {
  const [volume] = bindLocalVolumeParts(environment.localVolumes, [], { time: environment.volumeTime });
  return FRAME_NAMES.map(name => findVolumeGridSequence([name], 'volume')[0]).indexOf(volume.gridData);
}

test('sampleMotion takes a time on a recipe whose only animation is a grid sequence, and the environment carries it', () => {
  registerFrames();
  const scene = createAgentScene(gridOnlyRecipe());
  assert.equal(scene.sampleMotion(0), 0);
  assert.equal(frameAt(scene.environment), 0);
  assert.equal(scene.sampleMotion(1.2), 1.2);
  assert.equal(scene.environment.volumeTime, 1.2);
  assert.equal(frameAt(scene.environment), volumeGridFrameIndex(4, 2, 1.2));
  assert.equal(frameAt(scene.environment), 2);
});

test('a recipe with no animation at all still refuses a time and names grid frames among the things to add', () => {
  const recipe = gridOnlyRecipe();
  delete recipe.environment;
  const scene = createAgentScene(recipe);
  assert.throws(() => scene.sampleMotion(1), /no motion, physics, cloth, particles, placed asset clip or grid volume frames/);
});

test('the film timeline gives a grid-only recipe a motion time per shot, so a shot may start its own clock', () => {
  registerFrames();
  const recipe = gridOnlyRecipe();
  const timeline = normalizeFilmTimeline({ shots: [{ name: 'a', duration: 1 }, { name: 'b', duration: 2, motionStart: 0.5 }] }, recipe);
  const early = sampleFilmTimeline(timeline, recipe, 0.25);
  const late = sampleFilmTimeline(timeline, recipe, 2);
  assert.equal(early.motionTime, 0.25);
  assert.equal(late.motionTime, 0.5 + 1);
  assert.notEqual(volumeGridFrameIndex(4, 2, early.motionTime), volumeGridFrameIndex(4, 2, late.motionTime));
  const scene = createAgentScene(recipe);
  scene.sampleMotion(late.motionTime);
  assert.equal(frameAt(scene.environment), 3);
});

test('a recipe may list far more than 16 frames, and the scene keeps the whole list in its export', () => {
  const frames = Array.from({ length: 300 }, (unused, index) => `long-${index}.67vg`);
  const recipe = gridOnlyRecipe({ environment: { localVolumes: [{ shape: 'grid', frames, fps: 24, center: [0, 1, 0], size: [1, 1, 1] }] } });
  const exported = createAgentScene(recipe).exportRecipe();
  assert.deepEqual(exported.environment.localVolumes[0].frames, frames);
  recipe.environment.localVolumes[0].frames.push('too-many.67vg', ...frames.slice(0, 212));
  assert.throws(() => createAgentScene(recipe), /at most 512 entries/);
});

test('a resolved grid volume resolves again to the same volume, as a scene does when it rebuilds its look', () => {
  for (const volume of [{ shape: 'grid', grid: 'still', center: [0, 1, 0] }, { shape: 'grid', frames: ['a', 'b'], fps: 12, loop: false, center: [0, 1, 0] }]) {
    const once = resolveLocalVolumes([volume]);
    assert.deepEqual(resolveLocalVolumes(once), once);
  }
  assert.throws(() => resolveLocalVolumes([{ shape: 'grid', grid: 'still', center: [0, 1, 0], noiseAmount: 0.3 }]), /noiseAmount does not apply to a grid volume/);
});

test('frames that carry different channels are refused, with the converter run that fixes it', () => {
  registerVolumeGrid('channels-a', encodeVolumeGrid({ resolution: [2, 2, 2], size: [1, 1, 1], channels: { density: new Float32Array(8), flame: new Float32Array(8) } }));
  registerVolumeGrid('channels-b', encodeVolumeGrid({ resolution: [2, 2, 2], size: [1, 1, 1], channels: { density: new Float32Array(8) } }));
  assert.throws(() => findVolumeGridSequence(['channels-a', 'channels-b'], 'volume'), /frames\[1\] \("channels-b"\) has channels density but frame 0 has density, flame.*vdb-to-grid\.py --sequence/);
});
