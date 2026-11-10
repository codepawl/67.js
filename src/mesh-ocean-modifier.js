import { GROUP_PREFIX, createMeshData } from './mesh-data.js';
import { seededRandom } from './mesh-fields.js';
import { registerModifierNormalizer, registerModifierRunner } from './mesh-modifiers.js';

// Ocean modifier: a deterministic spectrum displacement like Blender's Ocean modifier, without the FFT. The sea is a sum of
// travelling waves on a lattice of wave vectors, so the surface repeats exactly every `size` metres. Each wave has an
// amplitude from the Phillips spectrum for the wind (damped for the smallest waves), a seeded random gaussian and a seeded
// phase, and travels at the deep water speed, so the same seed and time give the same vertices on every run.
// The waves lift the up axis; `choppiness` also pulls vertices toward the crests along the horizontal axes. The squeeze of
// the surface (the Jacobian of that horizontal move) becomes the vertex group `foam`: 0 where the surface is not squeezed
// and 1 where it folds over itself.

export const MAX_OCEAN_RESOLUTION = 16;
export const MAX_OCEAN_WORK = 50_000_000;
const GRAVITY = 9.81;
const SIGNIFICANT_HEIGHT_PER_WIND_SQUARED = 0.21;
const FOAM_START = 0.5;
const FOAM_FULL = 0;
const CHANNEL_GAUSSIAN_RADIUS = 40;
const CHANNEL_GAUSSIAN_ANGLE = 41;
const CHANNEL_PHASE = 42;
const UP_AXES = Object.freeze({ x: 0, y: 1, z: 2 });
const MAX_SEED = 0x7fffffff;

function windSpectrum(waveNumber, alignment, windSpeed) {
  const largestWave = windSpeed * windSpeed / GRAVITY;
  const smallestWave = largestWave / 1000;
  const spectrum = Math.exp(-1 / (waveNumber * largestWave) ** 2) / waveNumber ** 4 * alignment * alignment;
  return spectrum * Math.exp(-((waveNumber * smallestWave) ** 2));
}

function gaussian(key, seed) {
  const radius = Math.sqrt(-2 * Math.log(Math.max(seededRandom(key, CHANNEL_GAUSSIAN_RADIUS, seed), 1e-12)));
  return radius * Math.cos(2 * Math.PI * seededRandom(key, CHANNEL_GAUSSIAN_ANGLE, seed));
}

/**
 * The waves of a sea: wave vector (waveX, waveZ along the two horizontal axes), amplitude, phase and angular frequency.
 * The amplitudes are scaled so the significant wave height (4 standard deviations of the height) is
 * 0.21 * windSpeed^2 / g, the height of a fully developed sea.
 */
export function oceanWaves({ windSpeed, direction, size, seed, resolution }) {
  const windX = Math.cos(direction * Math.PI / 180);
  const windZ = Math.sin(direction * Math.PI / 180);
  const waves = [];
  let variance = 0;
  const step = 2 * Math.PI / size;
  for (let row = -resolution; row <= resolution; row++) {
    for (let column = -resolution; column <= resolution; column++) {
      if (row === 0 && column === 0) continue;
      const waveX = column * step;
      const waveZ = row * step;
      const waveNumber = Math.hypot(waveX, waveZ);
      const alignment = (waveX * windX + waveZ * windZ) / waveNumber;
      const amplitude = Math.sqrt(windSpectrum(waveNumber, alignment, windSpeed)) * gaussian(waves.length, seed);
      variance += amplitude * amplitude / 2;
      waves.push({
        waveX, waveZ, waveNumber, amplitude,
        phase: seededRandom(waves.length, CHANNEL_PHASE, seed) * 2 * Math.PI,
        frequency: Math.sqrt(GRAVITY * waveNumber),
      });
    }
  }
  const targetHeight = SIGNIFICANT_HEIGHT_PER_WIND_SQUARED * windSpeed * windSpeed / GRAVITY / 4;
  const scale = variance > 0 ? targetHeight / Math.sqrt(variance) : 0;
  for (const wave of waves) wave.amplitude *= scale;
  return waves;
}

/** Height, horizontal move and foam of the sea at one rest point and time. */
export function oceanSurfaceAt(waves, restX, restZ, time, choppiness) {
  let height = 0;
  let moveX = 0;
  let moveZ = 0;
  let squeezeXX = 0;
  let squeezeZZ = 0;
  let squeezeXZ = 0;
  for (const wave of waves) {
    const angle = wave.waveX * restX + wave.waveZ * restZ - wave.frequency * time + wave.phase;
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    const directionX = wave.waveX / wave.waveNumber;
    const directionZ = wave.waveZ / wave.waveNumber;
    height += wave.amplitude * cosine;
    moveX -= choppiness * directionX * wave.amplitude * sine;
    moveZ -= choppiness * directionZ * wave.amplitude * sine;
    const slope = choppiness * wave.amplitude * wave.waveNumber * cosine;
    squeezeXX -= directionX * directionX * slope;
    squeezeZZ -= directionZ * directionZ * slope;
    squeezeXZ -= directionX * directionZ * slope;
  }
  const jacobian = (1 + squeezeXX) * (1 + squeezeZZ) - squeezeXZ * squeezeXZ;
  const foam = Math.min(1, Math.max(0, (FOAM_START - jacobian) / (FOAM_START - FOAM_FULL)));
  return { height, moveX, moveZ, foam };
}

/** Displace every vertex by the sea and write the vertex group `foam`; `axis` is the up axis of the sea. */
export function oceanMesh(mesh, { axis, windSpeed, direction, choppiness, size, seed, time, resolution }) {
  const waves = oceanWaves({ windSpeed, direction, size, seed, resolution });
  if (waves.length * mesh.vertexCount > MAX_OCEAN_WORK) {
    throw new RangeError(`ocean would make ${waves.length * mesh.vertexCount} wave evaluations, over the limit of ${MAX_OCEAN_WORK}. Lower resolution or use a coarser grid.`);
  }
  const up = UP_AXES[axis];
  const first = (up + 1) % 3;
  const second = (up + 2) % 3;
  const positions = new Float32Array(mesh.positions);
  const foam = new Float32Array(mesh.vertexCount);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const surface = oceanSurfaceAt(waves, positions[vertex * 3 + first], positions[vertex * 3 + second], time, choppiness);
    positions[vertex * 3 + up] += surface.height;
    positions[vertex * 3 + first] += surface.moveX;
    positions[vertex * 3 + second] += surface.moveZ;
    foam[vertex] = surface.foam;
  }
  const attributes = { ...mesh.attributes, point: { ...mesh.attributes.point, [`${GROUP_PREFIX}foam`]: { data: foam, size: 1 } } };
  return createMeshData({
    positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges, attributes,
  });
}

function normalizeOcean(edit, normalized, index, { finiteNumber, integerInRange }) {
  normalized.axis = edit.axis ?? 'y';
  if (!Object.hasOwn(UP_AXES, normalized.axis)) throw new TypeError(`Mesh edit ${index} (axis must be x, y or z)`);
  normalized.windSpeed = edit.windSpeed === undefined ? 10 : finiteNumber(edit.windSpeed, index, 'windSpeed', { minimum: 0, maximum: 60, exclusiveMinimum: true });
  normalized.direction = edit.direction === undefined ? 0 : finiteNumber(edit.direction, index, 'direction', { minimum: -3600, maximum: 3600 });
  normalized.choppiness = edit.choppiness === undefined ? 1 : finiteNumber(edit.choppiness, index, 'choppiness', { minimum: 0, maximum: 4 });
  normalized.size = edit.size === undefined ? 100 : finiteNumber(edit.size, index, 'size', { minimum: 1, maximum: 10_000 });
  normalized.seed = edit.seed === undefined ? 0 : integerInRange(edit.seed, index, 'seed', 0, MAX_SEED);
  normalized.time = edit.time === undefined ? 0 : finiteNumber(edit.time, index, 'time', { minimum: -1e6, maximum: 1e6 });
  normalized.resolution = edit.resolution === undefined ? 8 : integerInRange(edit.resolution, index, 'resolution', 1, MAX_OCEAN_RESOLUTION);
}

registerModifierNormalizer('ocean', normalizeOcean);
registerModifierRunner('ocean', (mesh, edit) => ({ mesh: oceanMesh(mesh, edit), result: {} }));
