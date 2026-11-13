// Animated grid volumes (#1045): the frame list, its byte budget, the time to frame mapping and the guarantee that a render at one time draws one frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeVolumeGrid, registerVolumeGrid } from '../src/volume-grid.js';
import { findVolumeGridSequence, volumeGridFrameIndex, volumeGridBytes, VOLUME_GRID_SEQUENCE_MAX_BYTES, VOLUME_GRID_SEQUENCE_MAX_FRAMES } from '../src/volume-grid-sequence.js';
import { resolveLocalVolumes } from '../src/local-volumes.js';
import { bindLocalVolumeParts } from '../src/local-volume-parts.js';
import { renderPathTracedImage } from '../src/path-tracer.js';

const RESOLUTION = [2, 2, 2];
const IMAGE = { width: 16, height: 16, denoise: false, threads: 1, bounces: 1, samples: 1 };
const LOOKING_DOWN = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };
const CENTER_PIXEL = (8 * 16 + 8) * 3;

function registerUniformFrame(name, density, resolution = RESOLUTION) {
  const voxels = resolution[0] * resolution[1] * resolution[2];
  registerVolumeGrid(name, encodeVolumeGrid({ resolution, size: [20, 1, 20], channels: { density: new Float32Array(voxels).fill(density) } }));
}

test('time picks the frame: floor(time * fps), wrapped when it loops and held on the last frame when it does not', () => {
  assert.equal(volumeGridFrameIndex(4, 2, 0), 0);
  assert.equal(volumeGridFrameIndex(4, 2, 0.49), 0);
  assert.equal(volumeGridFrameIndex(4, 2, 0.5), 1);
  assert.equal(volumeGridFrameIndex(4, 2, 1.5), 3);
  assert.equal(volumeGridFrameIndex(4, 2, 2), 0, 'loops back to the first frame');
  assert.equal(volumeGridFrameIndex(4, 2, 2, false), 3, 'holds the last frame without a loop');
  assert.equal(volumeGridFrameIndex(4, 24, -3), 0, 'before 0 reads the first frame');
  assert.equal(volumeGridFrameIndex(4, 24, Number.NaN), 0);
  assert.equal(volumeGridFrameIndex(30, 30, 0.1 * 3, true), 9, 'a time that lands on a frame boundary does not fall back one frame to rounding');
});

test('a volume takes grid or frames with fps and loop, and says which it needs', () => {
  const [volume] = resolveLocalVolumes([{ shape: 'grid', frames: ['a', 'b'], center: [0, 1, 0], fps: 12 }]);
  assert.deepEqual(volume.frames, ['a', 'b']);
  assert.equal(volume.fps, 12);
  assert.equal(volume.loop, true);
  assert.equal(volume.grid, undefined);
  assert.equal(resolveLocalVolumes([{ shape: 'grid', frames: ['a'], center: [0, 0, 0] }])[0].fps, 24);
  assert.throws(() => resolveLocalVolumes([{ shape: 'grid', grid: 'a', frames: ['a'], center: [0, 0, 0] }]), /either grid.*or frames/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'grid', grid: 'a', fps: 12, center: [0, 0, 0] }]), /fps belongs to a grid volume with frames/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'grid', frames: [], center: [0, 0, 0] }]), /frames must be a list of 1 to 512 grid names/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'grid', frames: ['a', 3], center: [0, 0, 0] }]), /frames\[1\] must be the name of a grid file/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'grid', frames: ['a'], fps: 0, center: [0, 0, 0] }]), /fps must be between/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'grid', frames: ['a'], loop: 'yes', center: [0, 0, 0] }]), /loop must be true or false/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'box', frames: ['a'], center: [0, 0, 0], size: [1, 1, 1] }]), /frames belongs to shape "grid"/);
  assert.equal(VOLUME_GRID_SEQUENCE_MAX_FRAMES, 512);
});

test('a sequence needs one resolution and one size, and names the frame that differs', () => {
  registerUniformFrame('same-0', 0);
  registerUniformFrame('same-1', 1);
  registerUniformFrame('other-res', 1, [3, 2, 2]);
  assert.equal(findVolumeGridSequence(['same-0', 'same-1'], 'volume').length, 2);
  assert.throws(() => findVolumeGridSequence(['same-0', 'other-res'], 'volume'), /frames\[1\] \("other-res"\) is 3x2x2 but frame 0 is 2x2x2/);
  assert.throws(() => findVolumeGridSequence(['same-0', 'never-loaded'], 'volume'), /frames\[1\]\.grid "never-loaded" is not loaded/);
});

test('a sequence over the byte budget is refused with its size and the limit, before it is all loaded', () => {
  const resolution = [256, 256, 256];
  const frame = { resolution, channels: { density: new Uint16Array(1) } };
  assert.equal(volumeGridBytes(frame), 256 ** 3 * 2, 'one channel at 256 cubed is 32 MiB');
  assert.equal(VOLUME_GRID_SEQUENCE_MAX_BYTES, 256 * 1024 * 1024);
  // The decoded grid is shared by reference: nine of 32 MiB cross 256 MiB at the ninth.
  const shared = { resolution, size: null, channels: { density: new Uint16Array(256 ** 3) } };
  registerVolumeGrid('big', shared);
  const names = Array.from({ length: 9 }, () => 'big');
  assert.throws(() => findVolumeGridSequence(names, 'environment.localVolumes[0]'), /environment\.localVolumes\[0\]\.frames hold 301989888 bytes by frame 9 of 9, over the 268435456 byte limit/);
  assert.equal(findVolumeGridSequence(names.slice(0, 8), 'volume').length, 8, 'eight frames are exactly at the limit');
});

test('binding picks the frame for the time, and the same time binds the same grid every time', () => {
  for (let index = 0; index < 4; index++) registerUniformFrame(`bind-${index}`, index);
  const resolved = resolveLocalVolumes([{ shape: 'grid', frames: ['bind-0', 'bind-1', 'bind-2', 'bind-3'], center: [0, 0, 0], fps: 2 }]);
  const boundAt = time => bindLocalVolumeParts(resolved, [], { time })[0].gridData;
  assert.equal(boundAt(0), boundAt(0.4));
  assert.notEqual(boundAt(0), boundAt(0.5));
  assert.equal(boundAt(1.5), boundAt(1.5));
  assert.equal(boundAt(2), boundAt(0), 'the loop returns to frame 0');
  assert.equal(bindLocalVolumeParts(resolved, [])[0].gridData, boundAt(0), 'without a time the first frame binds');
});

function ground() {
  const half = 20;
  const geometry = {
    positions: new Float32Array([-half, 0, half, half, 0, half, half, 0, -half, -half, 0, -half]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  return [{ name: 'ground', geometry, material: { tag: 'surface', metallic: 0, roughness: 1, color: [0, 0, 0], ior: 1, emission: 1, emissiveColor: [1, 1, 1] } }];
}

async function tracedAt(volumeTime) {
  const localVolumes = [{ shape: 'grid', frames: ['trace-0', 'trace-1', 'trace-2'], fps: 2, loop: false, center: [0, 1.5, 0], size: [20, 1, 20], steps: 16 }];
  const { linear } = await renderPathTracedImage({ parts: ground(), environment: { localVolumes, volumeTime }, camera: LOOKING_DOWN }, IMAGE);
  return Array.from(linear);
}

test('the CPU path tracer draws the frame its time selects, the same pixels every time, and holds the last frame', async () => {
  registerUniformFrame('trace-0', 0);
  registerUniformFrame('trace-1', 1);
  registerUniformFrame('trace-2', 2);
  const first = await tracedAt(0);
  const second = await tracedAt(0.5);
  const third = await tracedAt(1);
  assert.ok(Math.abs(first[CENTER_PIXEL] - 1) < 2e-3, `frame 0 is clear: ${first[CENTER_PIXEL]}`);
  assert.ok(Math.abs(second[CENTER_PIXEL] - Math.exp(-1)) < 2e-3, `frame 1 transmits e^-1: ${second[CENTER_PIXEL]}`);
  assert.ok(Math.abs(third[CENTER_PIXEL] - Math.exp(-2)) < 2e-3, `frame 2 transmits e^-2: ${third[CENTER_PIXEL]}`);
  assert.deepEqual(await tracedAt(0.5), second, 'one time, one image');
  assert.deepEqual(await tracedAt(9), third, 'past the end the last frame stays');
});
