// Grid volumes (#1045): the grid file, its limits, the volume fields, the CPU path tracer's march and the guarantee that local volumes
// without a grid keep their bytes. The rasterizer's march is checked in tests/volume-grid-raster.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encodeVolumeGrid, decodeVolumeGrid, registerVolumeGrid, setVolumeGridLoader, findVolumeGrid, volumeGridFloats, sampleVolumeGrid, blackbodyRadiance, halfToFloat, floatToHalf, VOLUME_GRID_MAX_AXIS, VOLUME_GRID_MAX_BYTES } from '../src/volume-grid.js';
import { resolveLocalVolumes, createLocalVolumeBuffers, packLocalVolumes, localVolumeProfile } from '../src/local-volumes.js';
import { bindLocalVolumeParts } from '../src/local-volume-parts.js';
import { createLocalVolumeCrossing } from '../src/path-tracer-volume.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { normalizeAgentLook } from '../src/agent-look.js';

function uniformGrid(resolution, channels) {
  const voxels = resolution[0] * resolution[1] * resolution[2];
  return Object.fromEntries(Object.entries(channels).map(([name, value]) => [name, new Float32Array(voxels).fill(value)]));
}

test('half floats round trip the values a simulation stores', () => {
  for (const value of [0, 1, 0.5, 0.0038471222, 1536, 65504, -2.5, 6.17578125]) {
    const back = halfToFloat(floatToHalf(value));
    assert.ok(Math.abs(back - value) <= Math.abs(value) / 1024 + 1e-7, `${value} came back as ${back}`);
  }
  assert.equal(floatToHalf(1e9), 0x7c00, 'past the range is infinity');
});

test('a grid file encodes and decodes with its channels, resolution and size', () => {
  const resolution = [4, 3, 2];
  const bytes = encodeVolumeGrid({ resolution, size: [2, 1.5, 1], channels: uniformGrid(resolution, { density: 0.75, flame: 2 }) });
  const grid = decodeVolumeGrid(bytes);
  assert.deepEqual(grid.resolution, resolution);
  assert.deepEqual(grid.size, [2, 1.5, 1]);
  assert.deepEqual(Object.keys(grid.channels), ['density', 'flame']);
  assert.equal(volumeGridFloats(grid).density[5], 0.75);
  assert.equal(volumeGridFloats(grid).flame[23], 2);
});

test('a grid file that is wrong or too big is refused with what to pass instead', () => {
  const small = encodeVolumeGrid({ resolution: [2, 2, 2], channels: uniformGrid([2, 2, 2], { density: 1 }) });
  assert.throws(() => decodeVolumeGrid(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), /not a 67js grid file.*vdb-to-grid\.py/);
  assert.throws(() => decodeVolumeGrid(small.subarray(0, small.length - 2)), /bytes of data, expected 16 for 2x2x2/);
  assert.throws(() => encodeVolumeGrid({ resolution: [VOLUME_GRID_MAX_AXIS + 1, 2, 2], channels: { density: new Float32Array(1) } }), /each axis is an integer from 1 to 256.*--max-resolution 256/);
  assert.throws(() => encodeVolumeGrid({ resolution: [256, 256, 256], channels: { density: new Float32Array(1), temperature: new Float32Array(1), flame: new Float32Array(1) } }), /100663296 bytes, over the 67108864 byte limit/);
  assert.equal(VOLUME_GRID_MAX_BYTES, 64 * 1024 * 1024);
  assert.throws(() => encodeVolumeGrid({ resolution: [2, 2, 2], channels: { flame: new Float32Array(8) } }), /needs a "density" channel/);
});

test('sampling is trilinear between texel centres and clamps at the edges', () => {
  const resolution = [2, 1, 1];
  const grid = decodeVolumeGrid(encodeVolumeGrid({ resolution, channels: { density: Float32Array.of(0, 1) } }));
  const out = [0, 0, 0];
  const floats = volumeGridFloats(grid);
  assert.equal(sampleVolumeGrid(floats, resolution, 0.25, 0.5, 0.5, out)[0], 0);
  assert.equal(sampleVolumeGrid(floats, resolution, 0.5, 0.5, 0.5, out)[0], 0.5);
  assert.equal(sampleVolumeGrid(floats, resolution, 0.75, 0.5, 0.5, out)[0], 1);
  assert.equal(sampleVolumeGrid(floats, resolution, 1, 0.5, 0.5, out)[0], 1);
  assert.equal(out[2], out[0], 'without a flame channel the flame reads the density');
});

test('blackbody radiance is dark when cold, red then white as it heats, and brighter with the fourth power', () => {
  const cold = blackbodyRadiance(0, [1, 1, 1]);
  assert.deepEqual(Array.from(cold), [0, 0, 0]);
  const ember = blackbodyRadiance(1500, [0, 0, 0]);
  const flame = blackbodyRadiance(3000, [0, 0, 0]);
  assert.ok(ember[0] > ember[1] && ember[1] > ember[2], 'an ember is red');
  assert.ok(flame[2] / flame[0] > ember[2] / ember[0], 'a hotter body is whiter');
  assert.ok(flame[0] > ember[0] * 15, 'brightness grows with (kelvin / 1500)^4');
});

test('a grid volume resolves with its fields and refuses what only the other shapes take', () => {
  const [volume] = resolveLocalVolumes([{ shape: 'grid', grid: 'blast', center: [0, 1, 0], size: [2, 2, 2], temperatureScale: 1000, blackbodyIntensity: 0.5, anisotropy: 0.3 }]);
  assert.equal(volume.grid, 'blast');
  assert.equal(volume.steps, 64);
  assert.equal(volume.falloff, 0);
  assert.equal(volume.blackbodyIntensity, 0.5);
  assert.throws(() => resolveLocalVolumes([{ shape: 'grid', center: [0, 0, 0] }]), /localVolumes\[0\]\.grid must be the name of a registered grid.*vdb-to-grid\.py/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'grid', grid: 'x', center: [0, 0, 0], falloff: 0.2 }]), /falloff does not apply to a grid volume/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'grid', grid: 'x', center: [0, 0, 0], steps: 200 }]), /steps must be between 4 and 128/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'box', center: [0, 0, 0], size: [1, 1, 1], anisotropy: 0.2 }]), /anisotropy belongs to shape "grid"/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'grid', grid: 'x', center: [0, 0, 0], anisotropy: 2 }]), /anisotropy must be between -0\.9 and 0\.9/);
});

test('a volume whose grid is not loaded names the field and the call to make; a loader can supply it', () => {
  const [volume] = resolveLocalVolumes([{ shape: 'grid', grid: 'missing-grid', center: [0, 0, 0], size: [1, 1, 1] }]);
  assert.throws(() => bindLocalVolumeParts([volume], []), /localVolumes\[0\]\.grid "missing-grid" is not loaded: call registerVolumeGrid/);
  setVolumeGridLoader(name => (name === 'missing-grid' ? encodeVolumeGrid({ resolution: [2, 2, 2], size: [4, 4, 4], channels: uniformGrid([2, 2, 2], { density: 1 }) }) : null));
  try {
    const [bound] = bindLocalVolumeParts([{ ...volume, size: undefined }], []);
    assert.deepEqual(bound.size, [4, 4, 4], 'the size comes from the grid file when the volume names none');
    assert.equal(findVolumeGrid('missing-grid', 'x'), bound.gridData);
  } finally {
    setVolumeGridLoader(null);
  }
});

test('the agent look accepts a grid volume and keeps its fields', () => {
  const look = normalizeAgentLook({ environment: { localVolumes: [{ shape: 'grid', grid: 'blast', center: [0, 1, 0], size: [2, 2, 2], blackbodyIntensity: 1 }] } });
  assert.equal(look.environment.localVolumes[0].grid, 'blast');
  assert.equal(look.environment.localVolumes[0].blackbodyIntensity, 1);
});

test('only one grid volume is packed, and its row tells the shader the temperature scale and blackbody gain', () => {
  registerVolumeGrid('pack-test', decodeVolumeGrid(encodeVolumeGrid({ resolution: [2, 2, 2], channels: uniformGrid([2, 2, 2], { density: 1 }) })));
  const grid = { shape: 'grid', grid: 'pack-test', center: [0, 0, 0], size: [1, 1, 1], temperatureScale: 500, blackbodyIntensity: 0.5, emissionStrength: 4, anisotropy: 0.2 };
  const buffers = packLocalVolumes(bindLocalVolumeParts(resolveLocalVolumes([grid]), []), createLocalVolumeBuffers());
  assert.deepEqual(Array.from(buffers.grid.slice(0, 4)).map(value => Number(value.toFixed(3))), [1, 500, 2, 0.2]);
  assert.throws(() => packLocalVolumes(bindLocalVolumeParts(resolveLocalVolumes([grid, grid]), []), createLocalVolumeBuffers()), /At most one volume.*shape "grid"/);
});

const LOOKING_DOWN = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };
const IMAGE = { width: 16, height: 16, denoise: false, threads: 1, bounces: 1, samples: 1 };
const CENTER_PIXEL = (8 * 16 + 8) * 3;

function ground(emission) {
  const half = 20;
  const geometry = {
    positions: new Float32Array([-half, 0, half, half, 0, half, half, 0, -half, -half, 0, -half]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  return [{ name: 'ground', geometry, material: { tag: 'surface', metallic: 0, roughness: 1, color: [0, 0, 0], ior: 1, emission, emissiveColor: [1, 1, 1] } }];
}

async function centerRadiance(parts, localVolumes) {
  const { linear } = await renderPathTracedImage({ parts, environment: { localVolumes }, camera: LOOKING_DOWN }, IMAGE);
  return Array.from(linear.slice(CENTER_PIXEL, CENTER_PIXEL + 3));
}

test('the path tracer attenuates by the grid density and adds the flame and the blackbody glow', async () => {
  const resolution = [2, 2, 2];
  registerVolumeGrid('slab-density', decodeVolumeGrid(encodeVolumeGrid({ resolution, channels: uniformGrid(resolution, { density: 1 }) })));
  registerVolumeGrid('slab-flame', decodeVolumeGrid(encodeVolumeGrid({ resolution, channels: uniformGrid(resolution, { density: 0, flame: 1, temperature: 3000 }) })));
  const slab = { shape: 'grid', center: [0, 1.5, 0], size: [20, 1, 20], steps: 16 };
  const [dimmed] = await centerRadiance(ground(1), [{ ...slab, grid: 'slab-density', density: 1 }]);
  assert.ok(Math.abs(dimmed - Math.exp(-1)) < 2e-3, `transmitted ${dimmed}`);
  const [flameRed, flameGreen] = await centerRadiance(ground(0), [{ ...slab, grid: 'slab-flame', emission: [0.5, 0.25, 0], emissionStrength: 2 }]);
  assert.ok(Math.abs(flameRed - 1) < 2e-3, `red ${flameRed}`);
  assert.ok(Math.abs(flameGreen - 0.5) < 2e-3, `green ${flameGreen}`);
  const [glowRed] = await centerRadiance(ground(0), [{ ...slab, grid: 'slab-flame', emissionStrength: 1, blackbodyIntensity: 1, temperatureScale: 0.5 }]);
  const expected = blackbodyRadiance(1500, [0, 0, 0])[0];
  assert.ok(Math.abs(glowRed - expected) < 2e-3 * expected, `blackbody red ${glowRed}, expected ${expected}`);
});

test('a grid volume is zero outside its box and takes the profile from the density', () => {
  const resolution = [2, 2, 2];
  registerVolumeGrid('profile-test', decodeVolumeGrid(encodeVolumeGrid({ resolution, channels: uniformGrid(resolution, { density: 0.5 }) })));
  const [volume] = bindLocalVolumeParts(resolveLocalVolumes([{ shape: 'grid', grid: 'profile-test', center: [0, 0, 0], size: [2, 2, 2] }]), []);
  assert.equal(localVolumeProfile(volume, 0, 0, 0), 0.5);
  assert.equal(localVolumeProfile(volume, 1.5, 0, 0), 0);
});

test('the checked in 32 cube explosion frame decodes to a plausible fireball', () => {
  const grid = decodeVolumeGrid(readFileSync(new URL('./fixtures/explosion-32.67vg', import.meta.url)));
  assert.deepEqual(grid.resolution.length, 3);
  assert.ok(grid.resolution.every(axis => axis <= 32));
  const floats = volumeGridFloats(grid);
  assert.ok(Math.max(...floats.density) > 0.05 && Math.max(...floats.density) < 2);
  assert.ok(floats.flame && Math.max(...floats.flame) > 0.5, 'the frame carries a flame channel');
});

// Local volumes without a grid keep their bytes: these fingerprints were taken on main before the grid code and must not move.
test('volumes without a grid pack, profile and trace to the same bytes as before', () => {
  const volumes = resolveLocalVolumes([
    { shape: 'box', center: [0, 1, 0], size: [2, 2, 2], density: 2, falloff: 0.4, noiseAmount: 0.5, noiseScale: 2, emission: [1, 0.4, 0.1], emissionStrength: 3, scatter: 0.5, steps: 12 },
    { shape: 'sphere', center: [1, 1, 0], radius: 0.8, density: 1.5, absorption: [0.3, 0.6, 1], steps: 20 },
  ]);
  const buffers = packLocalVolumes(volumes, createLocalVolumeBuffers());
  const packed = createHash('sha256');
  for (const name of ['centers', 'extents', 'absorption', 'emission', 'steps', 'axes']) packed.update(Buffer.from(buffers[name].buffer));
  const profiles = [];
  for (let index = 0; index < 40; index++) profiles.push(localVolumeProfile(volumes[index % 2], (index % 7) * 0.3 - 1, (index % 5) * 0.4, (index % 3) * 0.5 - 0.5));
  const crossing = createLocalVolumeCrossing(volumes, { ambient: [0.2, 0.3, 0.4], sun: { direction: [0.3, 0.8, 0.5], color: [1, 0.9, 0.8] }, sunVisibility: () => 1 });
  const results = [];
  for (const jitter of [0.1, 0.5, 0.9]) {
    const throughput = [1, 1, 1];
    const emitted = [0, 0, 0];
    crossing(-3, 1, 0.1, 1, 0, 0, 10, jitter, throughput, emitted);
    results.push(...throughput, ...emitted);
  }
  const fingerprint = values => createHash('sha256').update(Buffer.from(new Float64Array(values).buffer)).digest('hex').slice(0, 16);
  assert.equal(packed.digest('hex').slice(0, 16), '622e0fbca427f116');
  assert.equal(fingerprint(profiles), '0039eaf64dc4fe26');
  assert.equal(fingerprint(results), '2796aa9abc58f416');
});

test('the MCP grid folder loads name.67vg files and nothing that looks like a path', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { installVolumeGridFiles } = await import('../src/mcp-volume-grids.js');
  const directory = mkdtempSync(join(tmpdir(), 'grid-files-'));
  try {
    writeFileSync(join(directory, 'folder-blast.67vg'), encodeVolumeGrid({ resolution: [2, 2, 2], channels: uniformGrid([2, 2, 2], { density: 1 }) }));
    installVolumeGridFiles(directory);
    assert.deepEqual(findVolumeGrid('folder-blast.67vg', 'x').resolution, [2, 2, 2]);
    assert.throws(() => findVolumeGrid('../folder-blast.67vg', 'x'), /is not loaded/);
    assert.throws(() => findVolumeGrid('absent.67vg', 'x'), /is not loaded/);
  } finally {
    setVolumeGridLoader(null);
    rmSync(directory, { recursive: true, force: true });
  }
});
