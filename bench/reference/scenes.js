// The reference scenes, built in the browser with the engine's own code so every engine feature can be reached.
// Each builder returns parts, a camera and lighting. render-blender.py builds the same scene from a dump of this data.
import { box, cylinder, sphere, torus } from '/src/geometry.js';
import { createEnvironmentMap, parseRadianceHdr } from '/src/hdri.js';
import { parseGltf, loadGltf, ktx2WorkerConfigFor } from '/src/gltf.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { createTree, scatterVegetation, selectLevels, vegetationParts } from '/src/vegetation.js';
import { createNoiseHeight, createTerrain } from '/src/terrain.js';
import { createAgentScene, loadAgentSceneModules } from '/src/agent-scene.js';
import { materialPatternTextures, normalizeMaterialPattern } from '/src/material-patterns.js';

const HDRI_FILE = 'public/hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr';
const HDRI_URL = '/hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr';
// The HDRI holds its own sun: 6 pixels carry 48 percent of the sky light. Scenes add a sun light of their own, so Cycles and
// EEVEE drew two shadows of each object while 67js, whose environment casts no shadow, drew one. Both sides cap the image
// at this radiance, which removes the sun and its halo (208 of 524,288 pixels) and keeps the clouds.
const HDRI_RADIANCE_LIMIT = 16;
const ROBOT_FILE = 'tests/fixtures/RobotExpressive.glb';
const IDENTITY_ROTATION_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function placedMatrix(translation, scale) {
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = IDENTITY_ROTATION_MATRIX;
  return new Float32Array([
    xx * scale[0], xy * scale[0], xz * scale[0], 0,
    yx * scale[1], yy * scale[1], yz * scale[1], 0,
    zx * scale[2], zy * scale[2], zz * scale[2], 0,
    translation[0], translation[1], translation[2], 1,
  ]);
}

export function part(name, geometry, translation, scale, material) {
  return { name, geometry, matrix: placedMatrix(translation, scale), material: { tag: 'surface', metallic: 0, roughness: 0.5, emission: 0, ...material } };
}

function floor(color = [0.5, 0.5, 0.5]) {
  return part('floor', box(0, 1), [0, -0.05, 0], [40, 0.1, 40], { color, roughness: 0.8 });
}

export async function skyLighting(intensity = 1) {
  const response = await fetch(HDRI_URL);
  const parsed = parseRadianceHdr(await response.arrayBuffer());
  const data = parsed.data.map((radiance) => Math.min(radiance, HDRI_RADIANCE_LIMIT));
  const map = createEnvironmentMap({ ...parsed, data, intensity, showBackground: true });
  return { map, meanRadiance: meanRadiance(data, intensity), blenderWorld: { type: 'hdri', file: HDRI_FILE, intensity, radianceLimit: HDRI_RADIANCE_LIMIT } };
}

// The average colour of an equirectangular map. Rows are not weighted by solid angle: the scenes that use it do not need that.
function meanRadiance(data, intensity) {
  const sum = [0, 0, 0];
  for (let index = 0; index < data.length; index++) sum[index % 3] += data[index];
  return sum.map(channel => (channel / (data.length / 3)) * intensity);
}

export function constantLighting(value) {
  const data = new Float32Array(8 * 4 * 3).fill(value);
  const map = createEnvironmentMap({ width: 8, height: 4, data, showBackground: true });
  return { map, blenderWorld: { type: 'constant', value } };
}

export function environment(lighting, { lightDirection = [-3, 6, 4], keyColor = [0, 0, 0], pointLights = [], spotLights = [], areaLights = [], volumeFog } = {}) {
  return {
    world: true, fillIntensity: 0, ambientIntensity: 1, fogDensity: 0, lightDirection, keyColor, pointLights, spotLights, areaLights,
    map: lighting.map, ...(volumeFog ? { volumeFog } : {}),
  };
}

export const SUN_COLOR = [3, 2.8, 2.5];

// A wall of bricks written as a material graph: a triangle wave across each course for the mortar joints, half a brick of
// shift on every second course, noise through a colour ramp for the brick tone. Blender gets the same graph as nodes.
const BRICK_COLUMNS = 6;
const BRICK_ROWS = 12;

function brickGraph() {
  const coordinate = axis => ({ uv: axis });
  const oddCourse = { smoothstep: [0.49, 0.51, { wave: { frequency: BRICK_ROWS / 2, direction: 'v', shape: 'saw' } }] };
  const shifted = { vec: [{ add: [coordinate('u'), { mul: [oddCourse, 0.5 / BRICK_COLUMNS] }] }, coordinate('v'), 0] };
  const jointAcross = { smoothstep: [0.12, 0.3, { wave: { frequency: BRICK_COLUMNS, direction: 'u', shape: 'triangle', at: shifted } }] };
  const jointAlong = { smoothstep: [0.08, 0.2, { wave: { frequency: BRICK_ROWS, direction: 'v', shape: 'triangle' } }] };
  const body = { min: [jointAcross, jointAlong] };
  const tone = { ramp: { value: { noise: { scale: 10, octaves: 3, tile: false } }, stops: [[0, [0.3, 0.09, 0.05]], [1, [0.58, 0.24, 0.14]]] } };
  return { color: { mix: [[0.45, 0.42, 0.38], tone, body] }, height: body };
}

function wallQuad(width, height) {
  const halfWidth = width / 2;
  return {
    positions: new Float32Array([-halfWidth, 0, 0, halfWidth, 0, 0, halfWidth, height, 0, -halfWidth, height, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function srgbToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function averageLinearColor(colorImage) {
  const sums = [0, 0, 0];
  const pixelCount = colorImage.width * colorImage.height;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      sums[channel] += srgbToLinear(colorImage.data[pixel * 4 + channel] / 255);
    }
  }
  return sums.map(sum => sum / pixelCount);
}

async function brickWallScene({ withGraph }) {
  const lighting = await skyLighting();
  const pattern = normalizeMaterialPattern({ type: 'graph', graph: brickGraph(), mapping: 'uv', bump: 1, resolution: 512 });
  const { map, normalMap, boxMapScale, boxMapAxis } = materialPatternTextures(pattern);
  const wall = withGraph
    ? part('wall', wallQuad(6, 4), [0, 0, 0], [1, 1, 1], { color: [1, 1, 1], roughness: 0.85, map, normalMap, boxMapScale, boxMapAxis })
    : part('wall', wallQuad(6, 4), [0, 0, 0], [1, 1, 1], { color: averageLinearColor(map.image), roughness: 0.85 });
  if (withGraph) {
    wall.material.graph = pattern.graph;
    wall.material.graphBump = pattern.bump;
  }
  return {
    parts: [floor([0.4, 0.38, 0.32]), wall], blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: SUN_COLOR }),
    camera: { eye: [0, 2, 8.5], target: [0, 2, 0], up: [0, 1, 0], fov: 40, near: 0.1, far: 100 },
    shadow: shadowAlongSun(DEFAULT_SUN_DIRECTION, { target: [0, 1, 0], distance: 13.45, extent: 8, near: 0.1, far: 40 }),
  };
}

// Khronos glTF sample assets (issue #51), downloaded by hand into artifacts/khronos/<name>/<name>.glb. Blender imports
// the same file with its own importer, so the reference is Cycles reading the asset, not our reading of it.
// SheenChair's fabric gives the base color and normal textures different KHR_texture_transform values: the importer bakes
// the shared one into the UVs and the shader applies the normal map's remainder.
const KHRONOS_ASSET_NAMES = ['ClearCoatTest', 'TransmissionTest', 'AnisotropyBarnLamp', 'AnisotropyDiscTest', 'SheenChair'];
const KHRONOS_VIEW_DIRECTION = [0.35, 0.25, 1];
const KHRONOS_FIELD_OF_VIEW = 35;

function worldBounds(parts) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const { geometry, matrix } of parts) {
    for (let index = 0; index < geometry.positions.length; index += 3) {
      const [x, y, z] = [geometry.positions[index], geometry.positions[index + 1], geometry.positions[index + 2]];
      for (let axis = 0; axis < 3; axis++) {
        const coordinate = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
        minimum[axis] = Math.min(minimum[axis], coordinate);
        maximum[axis] = Math.max(maximum[axis], coordinate);
      }
    }
  }
  return { minimum, maximum };
}

function cameraAroundBounds({ minimum, maximum }) {
  const center = minimum.map((low, axis) => (low + maximum[axis]) / 2);
  const radius = Math.hypot(...minimum.map((low, axis) => maximum[axis] - low)) / 2;
  const distance = (radius / Math.sin((KHRONOS_FIELD_OF_VIEW / 2) * Math.PI / 180)) * 1.05;
  const length = Math.hypot(...KHRONOS_VIEW_DIRECTION);
  const eye = center.map((value, axis) => value + (KHRONOS_VIEW_DIRECTION[axis] / length) * distance);
  return { center, radius, camera: { eye, target: center, up: [0, 1, 0], fov: KHRONOS_FIELD_OF_VIEW, near: distance / 100, far: distance * 10 } };
}

async function khronosSceneFromAsset(asset, file) {
  const lighting = await skyLighting();
  const { center, radius, camera } = cameraAroundBounds(worldBounds(asset.parts));
  return {
    parts: asset.parts, glb: file, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: SUN_COLOR }),
    camera,
    shadow: shadowAlongSun(DEFAULT_SUN_DIRECTION, { target: center, distance: radius * Math.sqrt(6), extent: radius * 1.5, near: radius * 0.1, far: radius * 8 }),
  };
}

async function khronosAssetScene(name) {
  const file = `artifacts/khronos/${name}/${name}.glb`;
  const response = await fetch(`/${file}`);
  return khronosSceneFromAsset(await parseGltf(await response.arrayBuffer()), file);
}

export const KHRONOS_SCENES = Object.fromEntries(KHRONOS_ASSET_NAMES.map(name => [name, () => khronosAssetScene(name)]));

// Grand scenes: the scale people actually want to draw, built from the engine's terrain, vegetation and plain boxes.
// Only what Blender can draw too is used: the terrain colours are vertex colours, the emissive windows are Emission, the
// fog is a volume box. Blender rebuilds the 67js leaf model for foliage materials (see the README).
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

export function smoothBetween(low, high, value) {
  const fraction = clamp01((value - low) / (high - low));
  return fraction * fraction * (3 - 2 * fraction);
}

export function mixColors(first, second, amount) {
  return first.map((channel, index) => channel + (second[index] - channel) * amount);
}

export function normalized(vector) {
  const length = Math.hypot(...vector);
  return vector.map(component => component / length);
}

// A shadow map that looks along the sun from `depth` metres away and covers a square of half-width `extent`.
export function sunShadow(towardLight, target, extent, depth) {
  const direction = normalized(towardLight);
  return { eye: target.map((value, axis) => value + direction[axis] * depth), target, up: [0, 1, 0], extent, near: 1, far: depth * 2 };
}

// The sun every scene gets from environment() unless it names its own.
const DEFAULT_SUN_DIRECTION = [-3, 6, 4];

// A shadow map that looks along the sun toward `target` from `distance` metres away, so shadows fall where the shading says.
function shadowAlongSun(towardLight, { target, distance, extent, near, far }) {
  const direction = normalized(towardLight);
  return { eye: target.map((value, axis) => value + direction[axis] * distance), target, up: [0, 1, 0], extent, near, far };
}

// Mountain valley: a bowl about 2 km across whose rim rises into ridged peaks, a conifer forest on the lower slopes.
export const VALLEY_TERRAIN = { size: 5120, chunks: 20, resolution: 64, levels: 4 };
const VALLEY_FLOOR_RADIUS = 520;
const VALLEY_RIM_RADIUS = 1500;
const VALLEY_SNOW_LINE = 520;
const VALLEY_TREE_LINE = 420;
const VALLEY_EYE = [20, 0, 560];
const VALLEY_SUN_DIRECTION = [0.85, 0.2, -0.25];

function valleyHeightFunction() {
  const floorHills = createNoiseHeight({ amplitude: 14, featureSize: 260, mountainMask: () => 0 }, 3);
  const peaks = createNoiseHeight({ amplitude: 0, mountainAmplitude: 1100, featureSize: 800, octaves: 7, warp: 260, warpFeatureSize: 700, mountainMask: () => 1 }, 11);
  return (x, z) => {
    const radius = Math.hypot(x, z * 0.75);
    const rise = smoothBetween(VALLEY_FLOOR_RADIUS, VALLEY_RIM_RADIUS, radius);
    const farWall = smoothBetween(2000, 2600, radius) * 600;
    return floorHills(x, z) + rise * (peaks(x, z) * 1.5 + 90) + farWall;
  };
}

// Grass in the valley, bare soil and rock on steep ground, snow on high ground that is not steep.
function paintValleyTerrain(terrain) {
  const grass = [0.14, 0.22, 0.07];
  const alpine = [0.2, 0.19, 0.12];
  const rock = [0.27, 0.25, 0.23];
  const snow = [0.85, 0.87, 0.9];
  for (const terrainPart of terrain.parts) {
    const { positions, normals } = terrainPart.geometry;
    const colors = new Float32Array(positions.length);
    for (let vertex = 0; vertex < positions.length; vertex += 3) {
      const height = positions[vertex + 1];
      const flatness = normals[vertex + 1];
      let color = mixColors(grass, alpine, smoothBetween(VALLEY_TREE_LINE * 0.7, VALLEY_TREE_LINE * 1.5, height));
      color = mixColors(color, rock, smoothBetween(0.9, 0.7, flatness));
      color = mixColors(color, snow, smoothBetween(VALLEY_SNOW_LINE, VALLEY_SNOW_LINE + 120, height) * smoothBetween(0.55, 0.8, flatness));
      colors.set(color, vertex);
    }
    terrainPart.geometry.colors = colors;
  }
}

async function mountainValleyScene() {
  const lighting = await skyLighting(0.8);
  const terrain = createTerrain({ ...VALLEY_TERRAIN, height: valleyHeightFunction(), eye: [VALLEY_EYE[0], 100, VALLEY_EYE[2]], material: { color: [1, 1, 1], metallic: 0, roughness: 0.95, emission: 0 } });
  paintValleyTerrain(terrain);
  const eye = [VALLEY_EYE[0], terrain.heightAt(VALLEY_EYE[0], VALLEY_EYE[2]) + 22, VALLEY_EYE[2]];
  const forest = scatterVegetation({
    area: { minX: -1500, maxX: 1500, minZ: -1700, maxZ: 1100 }, density: 0.0016, terrainHeight: terrain.heightAt, slopeLimit: 26,
    exclusion: (x, z) => terrain.heightAt(x, z) > VALLEY_TREE_LINE || Math.hypot(x - eye[0], z - eye[2]) < 110,
    mix: { conifer: 1 }, variants: 3, scale: [0.8, 1.3], seed: 5,
  });
  const visibleForest = selectLevels(forest.instances, eye, { cullDistance: 1800, distanceScale: 3 });
  return {
    parts: [...terrain.parts, ...visibleForest.parts], blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [4.4, 3, 1.8], lightDirection: normalized(VALLEY_SUN_DIRECTION) }),
    camera: { eye, target: [0, 330, -1800], up: [0, 1, 0], fov: 50, near: 0.5, far: 8000 },
    shadow: sunShadow(VALLEY_SUN_DIRECTION, [0, 150, -400], 2300, 3500),
  };
}

// Temple hall: a nave 140 m long between four rows of columns 30 m tall, a roof with square openings that let the sun
// fall through fog, a bright window at the far end and a few small figures near the camera for scale.
export const HALL_BLOCK = box(0, 1);
export const HALL = { halfWidth: 33, front: 50, back: -130, columnHeight: 30, columnRadius: 1.6, roofHeight: 31.5 };
const HALL_COLUMN_ROWS = [-22, -11, 11, 22];
const HALL_COLUMN_PITCH = 12;
const HALL_COLUMN_COUNT = 11;
const HALL_SUN_DIRECTION = [0.4, 0.82, 0.25];
const HALL_OPENING_PITCH = 20;
const HALL_OPENING_COUNT = 6;
const HALL_OPENING_FIRST_Z = -5;
const HALL_OPENING_SIZE = [10, 7];

export function hallRoofParts(parts, stone) {
  const roofThickness = 2;
  const length = HALL.front - HALL.back;
  const middleZ = (HALL.front + HALL.back) / 2;
  parts.push(part('roof-left', HALL_BLOCK, [-19, HALL.roofHeight, middleZ], [28, roofThickness, length], stone));
  parts.push(part('roof-right', HALL_BLOCK, [19, HALL.roofHeight, middleZ], [28, roofThickness, length], stone));
  let slabStart = HALL.front;
  for (let opening = 0; opening <= HALL_OPENING_COUNT; opening++) {
    const openingCenter = HALL_OPENING_FIRST_Z - opening * HALL_OPENING_PITCH;
    const slabEnd = opening < HALL_OPENING_COUNT ? openingCenter + HALL_OPENING_SIZE[1] / 2 : HALL.back;
    if (slabStart - slabEnd > 0.5) {
      parts.push(part(`roof-center-${opening}`, HALL_BLOCK, [0, HALL.roofHeight, (slabStart + slabEnd) / 2], [HALL_OPENING_SIZE[0], roofThickness, slabStart - slabEnd], stone));
    }
    slabStart = openingCenter - HALL_OPENING_SIZE[1] / 2;
  }
}

export function hallColumnParts(parts, stone) {
  const column = cylinder(48, 0, 1);
  for (const [rowIndex, x] of HALL_COLUMN_ROWS.entries()) {
    for (let index = 0; index < HALL_COLUMN_COUNT; index++) {
      const z = -index * HALL_COLUMN_PITCH;
      const label = `${rowIndex}-${index}`;
      parts.push(part(`column-${label}`, column, [x, HALL.columnHeight / 2, z], [HALL.columnRadius, HALL.columnHeight, HALL.columnRadius], stone));
      parts.push(part(`column-base-${label}`, HALL_BLOCK, [x, 0.6, z], [4.2, 1.2, 4.2], stone));
      parts.push(part(`column-capital-${label}`, HALL_BLOCK, [x, HALL.columnHeight + 0.7, z], [4.2, 1.4, 4.2], stone));
    }
    parts.push(part(`architrave-${rowIndex}`, HALL_BLOCK, [x, HALL.columnHeight + 2, (HALL.front + HALL.back) / 2], [2.6, 1.2, HALL.front - HALL.back], stone));
  }
}

export function hallFigureParts(parts) {
  const body = cylinder(16, 0, 1);
  const head = sphere(16, 10);
  const robes = [[0.5, 0.1, 0.08], [0.1, 0.2, 0.45], [0.55, 0.45, 0.15], [0.15, 0.3, 0.18], [0.4, 0.4, 0.42]];
  const standing = [[-3.5, 33], [-1.5, 30.5], [2.5, 32], [4.5, 27.5], [-5.5, 26], [0.8, 23.5]];
  standing.forEach(([x, z], index) => {
    const height = 1.5 + (index % 3) * 0.12;
    parts.push(part(`figure-body-${index}`, body, [x, height / 2, z], [0.2, height, 0.2], { color: robes[index % robes.length], roughness: 0.8 }));
    parts.push(part(`figure-head-${index}`, head, [x, height + 0.13, z], [0.13, 0.13, 0.13], { color: [0.75, 0.55, 0.42], roughness: 0.7 }));
  });
}

async function templeHallScene() {
  const lighting = constantLighting(0.03);
  const stone = { color: [0.52, 0.45, 0.36], roughness: 0.85 };
  const floorStone = { color: [0.36, 0.32, 0.27], roughness: 0.6 };
  const length = HALL.front - HALL.back;
  const middleZ = (HALL.front + HALL.back) / 2;
  const parts = [
    part('hall-floor', HALL_BLOCK, [0, -0.5, middleZ], [HALL.halfWidth * 2, 1, length], floorStone),
    part('hall-carpet', HALL_BLOCK, [0, 0.03, middleZ], [5, 0.06, length - 8], { color: [0.45, 0.06, 0.05], roughness: 0.9 }),
    part('wall-left', HALL_BLOCK, [-HALL.halfWidth - 1, HALL.roofHeight / 2, middleZ], [2, HALL.roofHeight + 1, length], stone),
    part('wall-right', HALL_BLOCK, [HALL.halfWidth + 1, HALL.roofHeight / 2, middleZ], [2, HALL.roofHeight + 1, length], stone),
    part('wall-front', HALL_BLOCK, [0, HALL.roofHeight / 2, HALL.front + 1], [HALL.halfWidth * 2 + 4, HALL.roofHeight + 1, 2], stone),
    part('wall-far', HALL_BLOCK, [0, HALL.roofHeight / 2, HALL.back - 1], [HALL.halfWidth * 2 + 4, HALL.roofHeight + 1, 2], stone),
    part('far-window', HALL_BLOCK, [0, 15, HALL.back + 0.05], [12, 22, 0.1], { color: [1, 0.78, 0.5], roughness: 1, emission: 5 }),
    part('altar-steps-low', HALL_BLOCK, [0, 0.4, HALL.back + 9], [26, 0.8, 18], stone),
    part('altar-steps-high', HALL_BLOCK, [0, 1.2, HALL.back + 6], [16, 0.8, 11], stone),
    part('altar', HALL_BLOCK, [0, 2.8, HALL.back + 6], [4, 2.4, 3], floorStone),
  ];
  hallColumnParts(parts, stone);
  hallRoofParts(parts, stone);
  hallFigureParts(parts);
  const volumeFog = {
    density: 0.012, minimum: [-HALL.halfWidth, 0, HALL.back], maximum: [HALL.halfWidth, HALL.roofHeight - 1, HALL.front + 2],
    color: [1, 0.95, 0.85], ambient: [0.02, 0.02, 0.02], anisotropy: 0.6, noiseAmount: 0, steps: 48, maxDistance: 190,
  };
  const pointLights = [
    { position: [-6, 4.5, HALL.back + 8], color: [1, 0.55, 0.2], intensity: 120, radius: 0.3 },
    { position: [6, 4.5, HALL.back + 8], color: [1, 0.55, 0.2], intensity: 120, radius: 0.3 },
  ];
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [8, 6.9, 5.4], lightDirection: normalized(HALL_SUN_DIRECTION), pointLights, volumeFog }),
    camera: { eye: [-2, 1.7, HALL.front - 3], target: [0, 12, -80], up: [0, 1, 0], fov: 62, near: 0.1, far: 300 },
    shadow: sunShadow(HALL_SUN_DIRECTION, [0, 15, middleZ], 105, 200),
    // The default of 6 texels per metre needs 1.4 million texels for this hall, and the bake allows 1 million; at 2 texels, 128 samples would pass the 400 million ray limit.
    bakeOptions: { texelsPerUnit: 2, samples: 48, maxSeconds: 300 },
    brightRegion: { luminance: 0.1, dilation: 4 },
  };
}

// Dark shaft: a closed stone room with one small opening in the roof. The sun comes through it as a shaft in fog and lands
// as a bright patch on the floor, and the rest of the room is dark. The world is 0.03, as in the temple hall.
const SHAFT_ROOM = { halfWidth: 5.5, front: 5, back: -10, height: 6.5, wall: 1 };
const SHAFT_SUN_DIRECTION = [0.35, 0.9, 0.25];
const SHAFT_OPENING = { center: [1.8, -1.2], size: 2.2 };

function shaftRoomParts(stone, floorStone) {
  const { halfWidth, front, back, height, wall } = SHAFT_ROOM;
  const length = front - back;
  const middleZ = (front + back) / 2;
  const outerWidth = halfWidth * 2 + wall * 2;
  const [openingX, openingZ] = SHAFT_OPENING.center;
  const half = SHAFT_OPENING.size / 2;
  const roofY = height + wall / 2;
  return [
    part('room-floor', HALL_BLOCK, [0, -0.5, middleZ], [outerWidth, 1, length + wall * 2], floorStone),
    part('room-wall-left', HALL_BLOCK, [-halfWidth - wall / 2, height / 2, middleZ], [wall, height, length], stone),
    part('room-wall-right', HALL_BLOCK, [halfWidth + wall / 2, height / 2, middleZ], [wall, height, length], stone),
    part('room-wall-front', HALL_BLOCK, [0, height / 2, front + wall / 2], [outerWidth, height, wall], stone),
    part('room-wall-back', HALL_BLOCK, [0, height / 2, back - wall / 2], [outerWidth, height, wall], stone),
    // Four slabs leave a square opening.
    part('roof-near', HALL_BLOCK, [0, roofY, (front + openingZ + half) / 2], [outerWidth, wall, front - openingZ - half], stone),
    part('roof-far', HALL_BLOCK, [0, roofY, (back + openingZ - half) / 2], [outerWidth, wall, openingZ - half - back], stone),
    part('roof-left', HALL_BLOCK, [(-halfWidth + openingX - half) / 2, roofY, openingZ], [openingX - half + halfWidth, wall, half * 2], stone),
    part('roof-right', HALL_BLOCK, [(halfWidth + openingX + half) / 2, roofY, openingZ], [halfWidth - openingX - half, wall, half * 2], stone),
  ];
}

function shaftPropParts(stone, floorStone) {
  return [
    part('plinth', HALL_BLOCK, [-0.9, 0.4, -3.3], [1.1, 0.8, 1.1], floorStone),
    part('urn', sphere(24, 16), [-0.9, 1.25, -3.3], [0.42, 0.42, 0.42], { color: [0.55, 0.3, 0.2], roughness: 0.4 }),
    part('slab-left', HALL_BLOCK, [-3.8, 0.5, -8], [2.2, 1, 3], stone),
    part('slab-right', HALL_BLOCK, [2.6, 0.35, -4.6], [1.6, 0.7, 2.4], stone),
    part('pillar', cylinder(32, 0, 1), [-4.4, 3.25, -0.5], [0.7, 6.5, 0.7], stone),
    part('pillar-far', cylinder(32, 0, 1), [4.4, 3.25, -6.5], [0.7, 6.5, 0.7], stone),
  ];
}

async function darkShaftScene() {
  const lighting = constantLighting(0.03);
  const stone = { color: [0.62, 0.55, 0.45], roughness: 0.85 };
  const floorStone = { color: [0.5, 0.45, 0.38], roughness: 0.6 };
  const parts = [...shaftRoomParts(stone, floorStone), ...shaftPropParts(stone, floorStone)];
  const { halfWidth, front, back, height } = SHAFT_ROOM;
  const volumeFog = {
    density: 0.07, minimum: [-halfWidth, 0, back], maximum: [halfWidth, height, front],
    color: [1, 0.95, 0.85], ambient: [0.02, 0.02, 0.02], anisotropy: 0.6, noiseAmount: 0, steps: 48, maxDistance: 40,
  };
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [8, 6.9, 5.4], lightDirection: normalized(SHAFT_SUN_DIRECTION), volumeFog }),
    camera: { eye: [3.4, 1.6, 4.2], target: [-0.6, 1.2, -5], up: [0, 1, 0], fov: 62, near: 0.1, far: 60 },
    shadow: sunShadow(SHAFT_SUN_DIRECTION, [0, 3, -3], 14, 30),
    // The bright pixels of the Cycles image, grown by a few pixels, are scored on their own (score.py).
    brightRegion: { luminance: 0.1, dilation: 4 },
  };
}

// Fog valley: open ground under a clear sky with a low sun ahead of the camera, a field of blocks from 25 m to 400 m away, and
// distance haze over all of it. There is no roof, so the fog sees the whole sky.
const FOG_VALLEY_SUN_DIRECTION = [-0.45, 0.4, -0.75];
const FOG_VALLEY_BLOCK_COUNT = 48;

function fogValleyParts() {
  const cube = HALL_BLOCK;
  const parts = [part('ground', cube, [0, -0.5, -200], [900, 1, 900], { color: [0.32, 0.3, 0.24], roughness: 0.9 })];
  let seed = 7;
  const next = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let index = 0; index < FOG_VALLEY_BLOCK_COUNT; index++) {
    const distance = 25 + (index / FOG_VALLEY_BLOCK_COUNT) * 375;
    const width = 4 + next() * 14;
    const height = 3 + next() * 22;
    const x = (next() - 0.5) * (60 + distance * 0.9);
    const tone = 0.35 + next() * 0.3;
    parts.push(part(`block-${index}`, cube, [x, height / 2, -distance], [width, height, 4 + next() * 14], { color: [tone, tone * 0.93, tone * 0.82], roughness: 0.85 }));
  }
  return parts;
}

async function fogValleyScene() {
  const parts = fogValleyParts();
  const lighting = await skyLighting();
  const volumeFog = {
    density: 0.005, minimum: [-300, 0, -450], maximum: [300, 90, 40],
    color: [1, 1, 1], ambient: lighting.meanRadiance, anisotropy: 0.4, noiseAmount: 0, steps: 48, maxDistance: 600,
  };
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [4, 3.7, 3.3], lightDirection: normalized(FOG_VALLEY_SUN_DIRECTION), volumeFog }),
    camera: { eye: [0, 2.5, 14], target: [0, 8, -150], up: [0, 1, 0], fov: 55, near: 0.1, far: 700 },
    shadow: sunShadow(FOG_VALLEY_SUN_DIRECTION, [0, 0, -190], 230, 500),
  };
}

// Fog room: a 5 m square room with a window in one wall. The sun comes through the window as a shaft in the fog and lands
// on the floor; the rest of the room is lit by what the window lets in of a 0.05 sky.
const FOG_ROOM = { halfSize: 2.5, height: 3.2, wall: 0.4 };
const FOG_ROOM_WINDOW = { bottom: 0.9, top: 2.5, halfWidth: 0.8 };
const FOG_ROOM_SUN_DIRECTION = [0.8, 0.55, 0.2];

function fogRoomParts(plaster, floorWood) {
  const { halfSize, height, wall } = FOG_ROOM;
  const { bottom, top, halfWidth } = FOG_ROOM_WINDOW;
  const outer = (halfSize + wall) * 2;
  const wallX = halfSize + wall / 2;
  const gap = (halfSize - halfWidth) / 2 + halfWidth;
  return [
    part('floor', HALL_BLOCK, [0, -0.5, 0], [outer, 1, outer], floorWood),
    part('roof', HALL_BLOCK, [0, height + 0.5, 0], [outer, 1, outer], plaster),
    part('wall-left', HALL_BLOCK, [-wallX, height / 2, 0], [wall, height, outer], plaster),
    part('wall-front', HALL_BLOCK, [0, height / 2, wallX], [outer, height, wall], plaster),
    part('wall-back', HALL_BLOCK, [0, height / 2, -wallX], [outer, height, wall], plaster),
    // Four pieces leave a rectangular window in the right wall.
    part('wall-right-low', HALL_BLOCK, [wallX, bottom / 2, 0], [wall, bottom, outer], plaster),
    part('wall-right-high', HALL_BLOCK, [wallX, (top + height) / 2, 0], [wall, height - top, outer], plaster),
    part('wall-right-near', HALL_BLOCK, [wallX, (bottom + top) / 2, gap], [wall, top - bottom, halfSize - halfWidth], plaster),
    part('wall-right-far', HALL_BLOCK, [wallX, (bottom + top) / 2, -gap], [wall, top - bottom, halfSize - halfWidth], plaster),
    part('table', HALL_BLOCK, [-0.4, 0.4, -0.2], [1.2, 0.8, 0.8], floorWood),
    part('vase', sphere(24, 16), [-0.4, 0.98, -0.2], [0.18, 0.18, 0.18], { color: [0.55, 0.3, 0.2], roughness: 0.4 }),
    part('cabinet', HALL_BLOCK, [-1.9, 0.9, -1.8], [0.8, 1.8, 0.6], floorWood),
  ];
}

async function fogRoomScene() {
  const lighting = constantLighting(0.05);
  const plaster = { color: [0.7, 0.66, 0.6], roughness: 0.85 };
  const floorWood = { color: [0.45, 0.3, 0.18], roughness: 0.6 };
  const parts = fogRoomParts(plaster, floorWood);
  const { halfSize, height } = FOG_ROOM;
  const volumeFog = {
    density: 0.2, minimum: [-halfSize, 0, -halfSize], maximum: [halfSize, height, halfSize],
    color: [1, 1, 1], ambient: [0.05, 0.05, 0.05], anisotropy: 0.5, noiseAmount: 0, steps: 48, maxDistance: 20,
  };
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [8, 6.9, 5.4], lightDirection: normalized(FOG_ROOM_SUN_DIRECTION), volumeFog }),
    camera: { eye: [-2.3, 1.5, 2.3], target: [0.4, 1.0, -1], up: [0, 1, 0], fov: 62, near: 0.05, far: 30 },
    shadow: sunShadow(FOG_ROOM_SUN_DIRECTION, [0, 1.5, 0], 5, 20),
    brightRegion: { luminance: 0.1, dilation: 4 },
  };
}

// Megacity at dusk: hundreds of towers of stepped boxes on both sides of a broad avenue, windows as emissive bands, a low
// sun from the left behind the city, seen from a high camera. Every tower shares one box geometry.
const CITY_AVENUE_HALF_WIDTH = 40;
const CITY_COLUMNS_PER_SIDE = 8;
const CITY_COLUMN_PITCH = 62;
const CITY_ROW_PITCH = 46;
const CITY_ROW_FIRST_Z = 260;
const CITY_ROW_COUNT = 29;
const CITY_CENTER_Z = -430;
const CITY_SUN_DIRECTION = [-0.7, 0.14, -0.35];
const WINDOW_PITCH = 6.5;
export const FACADE_STYLES = [
  { color: [0.07, 0.09, 0.13], metallic: 0.3, roughness: 0.25 },
  { color: [0.3, 0.3, 0.32], metallic: 0, roughness: 0.8 },
  { color: [0.38, 0.31, 0.25], metallic: 0, roughness: 0.75 },
  { color: [0.14, 0.16, 0.2], metallic: 0.5, roughness: 0.3 },
];
export const WINDOW_STYLES = [
  { color: [1, 0.7, 0.35], emission: 1.1 },
  { color: [1, 0.8, 0.55], emission: 1 },
  { color: [0.6, 0.78, 1], emission: 0.9 },
];

function towerHeight(x, z, random) {
  const downtown = Math.exp(-(((z - CITY_CENTER_Z) / 330) ** 2)) * Math.exp(-((x / 330) ** 2));
  const ridge = 28 + downtown * 420 * (0.3 + random() * 0.95);
  return random() < 0.04 ? ridge * 1.5 : ridge;
}

export function cityTowerParts(parts, towerBox, x, z, random, towerIndex, heightOverride) {
  const width = 24 + random() * 16;
  const depth = 24 + random() * 16;
  const facade = FACADE_STYLES[Math.floor(random() * FACADE_STYLES.length)];
  const windows = WINDOW_STYLES[Math.floor(random() * WINDOW_STYLES.length)];
  const totalHeight = heightOverride ?? towerHeight(x, z, random);
  const tierCount = totalHeight > 90 ? 1 + Math.floor(random() * 3) : 1;
  let baseY = 0;
  for (let tier = 0; tier < tierCount; tier++) {
    const shrink = 0.78 ** tier;
    const tierHeight = tier === tierCount - 1 ? totalHeight - baseY : (totalHeight - baseY) * (0.4 + random() * 0.2);
    const tierWidth = width * shrink;
    const tierDepth = depth * shrink;
    const label = `${towerIndex}-${tier}`;
    parts.push(part(`tower-${label}`, towerBox, [x, baseY + tierHeight / 2, z], [tierWidth, tierHeight, tierDepth], facade));
    for (let bandY = baseY + 5; bandY < baseY + tierHeight - 3; bandY += WINDOW_PITCH) {
      if (random() < 0.28) continue;
      parts.push(part(`windows-${label}-${Math.round(bandY)}`, towerBox, [x, bandY, z], [tierWidth + 0.3, 2.1, tierDepth + 0.3], { ...windows, roughness: 0.6 }));
    }
    baseY += tierHeight;
  }
  if (totalHeight > 160 && random() < 0.5) {
    parts.push(part(`spire-${towerIndex}`, towerBox, [x, totalHeight + 22, z], [1.6, 44, 1.6], { color: [0.2, 0.2, 0.22], roughness: 0.4, metallic: 0.8 }));
    parts.push(part(`spire-light-${towerIndex}`, towerBox, [x, totalHeight + 46, z], [2.4, 2.4, 2.4], { color: [1, 0.15, 0.1], roughness: 1, emission: 12 }));
  }
}

function cityAvenueParts(parts, towerBox) {
  parts.push(part('city-ground', towerBox, [0, -1, -400], [9000, 2, 9000], { color: [0.1, 0.1, 0.11], roughness: 0.95 }));
  parts.push(part('avenue', towerBox, [0, 0.05, -400], [CITY_AVENUE_HALF_WIDTH * 2 - 12, 0.1, 2400], { color: [0.16, 0.16, 0.17], roughness: 0.6 }));
  for (let lamp = 0; lamp < 36; lamp++) {
    const z = CITY_ROW_FIRST_Z + 40 - lamp * 34;
    for (const side of [-1, 1]) {
      parts.push(part(`lamp-post-${lamp}-${side}`, towerBox, [side * 31, 5, z], [0.5, 10, 0.5], { color: [0.15, 0.15, 0.16], roughness: 0.5, metallic: 0.8 }));
      parts.push(part(`lamp-head-${lamp}-${side}`, towerBox, [side * 30, 10.2, z], [1.8, 0.5, 1.2], { color: [1, 0.75, 0.4], roughness: 1, emission: 14 }));
    }
  }
}

async function megacityDuskScene() {
  const lighting = await skyLighting(0.45);
  const towerBox = box(0, 1);
  const random = seededRandom(67);
  const parts = [];
  cityAvenueParts(parts, towerBox);
  let towerIndex = 0;
  for (let row = 0; row < CITY_ROW_COUNT; row++) {
    for (let column = 0; column < CITY_COLUMNS_PER_SIDE; column++) {
      for (const side of [-1, 1]) {
        if (random() < 0.15) continue;
        const x = side * (CITY_AVENUE_HALF_WIDTH + 18 + column * CITY_COLUMN_PITCH + (random() - 0.5) * 8);
        const z = CITY_ROW_FIRST_Z - row * CITY_ROW_PITCH + (random() - 0.5) * 8;
        cityTowerParts(parts, towerBox, x, z, random, towerIndex++);
      }
    }
  }
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [5, 2.9, 1.5], lightDirection: normalized(CITY_SUN_DIRECTION) }),
    camera: { eye: [45, 230, 620], target: [0, 80, -500], up: [0, 1, 0], fov: 48, near: 1, far: 4000 },
    shadow: sunShadow(CITY_SUN_DIRECTION, [0, 0, -420], 900, 2500),
  };
}

// A lit sign at night (issue #284): a dark wall with a panel whose emissive map is a strip of colour bars with a scan line
// pattern, over a pale floor under a faint constant sky. The panel is the only strong light, so the colours must come from
// the map and the floor in front of it must pick up its glow.
const SIGN_MAP_WIDTH = 32;
const SIGN_MAP_HEIGHT = 16;
const SIGN_BAR_COLORS = [[255, 255, 255], [255, 210, 40], [40, 220, 230], [60, 230, 70], [240, 60, 220], [240, 50, 40], [50, 70, 240], [20, 20, 20]];

function signEmissiveImage() {
  const pixels = new Uint8ClampedArray(SIGN_MAP_WIDTH * SIGN_MAP_HEIGHT * 4);
  for (let row = 0; row < SIGN_MAP_HEIGHT; row++) {
    for (let column = 0; column < SIGN_MAP_WIDTH; column++) {
      const bar = SIGN_BAR_COLORS[Math.floor(column / (SIGN_MAP_WIDTH / SIGN_BAR_COLORS.length))];
      const scanLineDimming = row % 4 === 3 ? 0.35 : 1;
      const base = (row * SIGN_MAP_WIDTH + column) * 4;
      pixels[base] = bar[0] * scanLineDimming;
      pixels[base + 1] = bar[1] * scanLineDimming;
      pixels[base + 2] = bar[2] * scanLineDimming;
      pixels[base + 3] = 255;
    }
  }
  return new ImageData(pixels, SIGN_MAP_WIDTH, SIGN_MAP_HEIGHT);
}

async function emissiveSignScene() {
  const lighting = constantLighting(0.02);
  const sign = part('sign', wallQuad(4, 1.6), [0, 0.7, 0.02], [1, 1, 1], {
    color: [0.02, 0.02, 0.02], roughness: 0.6, emission: 6, emissiveColor: [1, 1, 1], emissiveMap: { image: signEmissiveImage(), colorSpace: 'srgb' },
  });
  return {
    parts: [floor([0.45, 0.43, 0.4]), part('wall', wallQuad(8, 4), [0, 0, 0], [1, 1, 1], { color: [0.25, 0.25, 0.27], roughness: 0.9 }), sign],
    blenderWorld: lighting.blenderWorld,
    environment: environment(lighting),
    camera: { eye: [1.5, 1.4, 5], target: [0, 1.2, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 60 },
    shadow: shadowAlongSun(DEFAULT_SUN_DIRECTION, { target: [0, 0, 0], distance: 13.45, extent: 8, near: 0.1, far: 40 }),
  };
}

// Subsurface scattering against Cycles (issue #283): a wax candle, a skin sphere and a leaf slab with the sun behind and to the side,
// so the shadow edge and the light through the thin parts show. 'subsurface-off' is the same scene at weight 0, the control that
// 'subsurface' must score better than.
const SUBSURFACE_SUN_DIRECTION = [4, 3, -2];
const SUBSURFACE_LAYERS = {
  wax: { radius: [1, 0.6, 0.3], scale: 0.04 },
  skin: { radius: [1, 0.2, 0.1], scale: 0.05 },
  leaf: { radius: [0.5, 1, 0.3], scale: 0.02 },
};

async function subsurfaceScene(weight) {
  const lighting = await skyLighting();
  const layer = name => ({ subsurface: { weight, ...SUBSURFACE_LAYERS[name] } });
  const parts = [
    floor([0.2, 0.2, 0.22]),
    part('wax-candle', cylinder(64, 0, 1), [-1.1, 0.4, 0], [0.3, 0.8, 0.3], { color: [0.85, 0.72, 0.5], roughness: 0.45, ...layer('wax') }),
    part('skin-sphere', sphere(96, 64), [0.2, 0.45, 0], [0.9, 0.9, 0.9], { color: [0.8, 0.45, 0.35], roughness: 0.5, ...layer('skin') }),
    part('leaf-slab', box(0, 1), [1.5, 0.55, 0], [0.7, 0.9, 0.012], { color: [0.12, 0.3, 0.04], roughness: 0.5, ...layer('leaf') }),
  ];
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: SUN_COLOR, lightDirection: SUBSURFACE_SUN_DIRECTION }),
    camera: { eye: [0, 1.6, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 200 },
    shadow: shadowAlongSun(SUBSURFACE_SUN_DIRECTION, { target: [0, 0.5, 0], distance: 13, extent: 4, near: 0.1, far: 40 }),
  };
}

export const REFERENCE_SCENES = {
  subsurface: () => subsurfaceScene(1),
  'subsurface-off': () => subsurfaceScene(0),

  'emissive-sign': emissiveSignScene,
  'mountain-valley': mountainValleyScene,
  'temple-hall': templeHallScene,
  'dark-shaft': darkShaftScene,
  'fog-valley': fogValleyScene,
  'fog-room': fogRoomScene,
  'megacity-dusk': megacityDuskScene,

  async 'brick-graph'() {
    return brickWallScene({ withGraph: true });
  },

  // The control for brick-graph: the same wall in the colour the graph averages to, with no maps, which is all a
  // material without a graph could say. brick-graph must score better than this against Cycles (issue #50).
  async 'brick-flat'() {
    return brickWallScene({ withGraph: false });
  },

  async 'material-spheres'() {
    const lighting = await skyLighting();
    const shared = sphere(64, 40);
    const parts = [floor()];
    for (const [column, roughness] of [0.1, 0.3, 0.5, 0.7, 0.9].entries()) {
      const x = (column - 2) * 1.5;
      parts.push(part(`plastic-${column}`, shared, [x, 0.6, 0.8], [0.6, 0.6, 0.6], { color: [0.8, 0.2, 0.15], roughness }));
      parts.push(part(`metal-${column}`, shared, [x, 0.6, -0.8], [0.6, 0.6, 0.6], { color: [0.9, 0.75, 0.4], roughness, metallic: 1 }));
    }
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [0, 3.5, 7.5], target: [0, 0.4, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 200 },
      shadow: shadowAlongSun(DEFAULT_SUN_DIRECTION, { target: [0, 0, 0], distance: 15.62, extent: 8, near: 0.1, far: 40 }),
    };
  },

  async 'lit-interior'() {
    const lighting = constantLighting(0.02);
    const wall = { color: [0.7, 0.68, 0.62], roughness: 0.9 };
    const cube = box(0, 1);
    const parts = [
      part('room-floor', cube, [0, -0.05, 0], [8, 0.1, 8], { color: [0.45, 0.32, 0.22], roughness: 0.6 }),
      part('room-ceiling', cube, [0, 3.05, 0], [8, 0.1, 8], wall),
      part('room-back', cube, [0, 1.5, -4.05], [8, 3.2, 0.1], wall),
      part('room-left', cube, [-4.05, 1.5, 0], [0.1, 3.2, 8], { ...wall, color: [0.55, 0.25, 0.2] }),
      part('room-right', cube, [4.05, 1.5, 0], [0.1, 3.2, 8], { ...wall, color: [0.2, 0.35, 0.5] }),
      part('table', cube, [0, 0.7, -1], [2.4, 0.1, 1.2], { color: [0.3, 0.18, 0.1], roughness: 0.4 }),
      part('table-leg', cube, [0, 0.33, -1], [0.3, 0.66, 0.3], { color: [0.2, 0.2, 0.2], roughness: 0.5 }),
      part('vase', sphere(48, 32), [-0.5, 1.05, -1], [0.3, 0.3, 0.3], { color: [0.2, 0.5, 0.45], roughness: 0.2 }),
      part('block', cube, [0.6, 1, -1], [0.4, 0.5, 0.4], { color: [0.75, 0.7, 0.2], roughness: 0.5 }),
    ];
    const pointLights = [
      { position: [0, 2.6, -0.5], color: [1, 0.9, 0.75], intensity: 8, radius: 0.05, castShadow: true },
      { position: [-2.5, 1.5, 1.5], color: [1, 0.6, 0.4], intensity: 2, radius: 0.05, castShadow: true },
      { position: [2.5, 1.5, 1.5], color: [0.5, 0.7, 1], intensity: 2, radius: 0.05, castShadow: true },
    ];
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { pointLights }),
      camera: { eye: [0, 1.5, 3.9], target: [0, 1, -1], up: [0, 1, 0], fov: 50, near: 0.05, far: 50 },
    };
  },

  // The lit-interior room with a mirror sphere, a gold sphere and a glossy floor: what a reflection probe is for.
  async 'metal-room'() {
    const lighting = constantLighting(0.02);
    const wall = { color: [0.7, 0.68, 0.62], roughness: 0.9 };
    const cube = box(0, 1);
    const parts = [
      part('room-floor', cube, [0, -0.05, 0], [8, 0.1, 8], { color: [0.35, 0.3, 0.27], roughness: 0.25 }),
      part('room-ceiling', cube, [0, 3.05, 0], [8, 0.1, 8], wall),
      part('room-back', cube, [0, 1.5, -4.05], [8, 3.2, 0.1], wall),
      part('room-left', cube, [-4.05, 1.5, 0], [0.1, 3.2, 8], { ...wall, color: [0.55, 0.25, 0.2] }),
      part('room-right', cube, [4.05, 1.5, 0], [0.1, 3.2, 8], { ...wall, color: [0.2, 0.35, 0.5] }),
      part('room-front', cube, [0, 1.5, 4.05], [8, 3.2, 0.1], wall),
      part('table', cube, [0, 0.7, -1], [2.4, 0.1, 1.2], { color: [0.3, 0.18, 0.1], roughness: 0.4 }),
      part('mirror', sphere(64, 40), [-0.6, 1.05, -1], [0.3, 0.3, 0.3], { color: [0.95, 0.95, 0.95], metallic: 1, roughness: 0.04 }),
      part('gold', sphere(64, 40), [0.6, 1.05, -1], [0.3, 0.3, 0.3], { color: [1, 0.77, 0.34], metallic: 1, roughness: 0.25 }),
    ];
    const pointLights = [
      { position: [0, 2.6, -0.5], color: [1, 0.9, 0.75], intensity: 8, radius: 0.05, castShadow: true },
      { position: [-2.5, 1.5, 1.5], color: [1, 0.6, 0.4], intensity: 2, radius: 0.05, castShadow: true },
      { position: [2.5, 1.5, 1.5], color: [0.5, 0.7, 1], intensity: 2, radius: 0.05, castShadow: true },
    ];
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { pointLights }),
      camera: { eye: [0, 1.5, 3.9], target: [0, 1, -1], up: [0, 1, 0], fov: 50, near: 0.05, far: 50 },
    };
  },

  // A closed room built from a recipe, with brick walls: the bake has to give a patterned wall bounced light and keep its bricks.
  async 'brick-room'() {
    const lighting = constantLighting(0.02);
    const pointLights = [
      { position: [0, 2.6, -0.5], color: [1, 0.9, 0.75], intensity: 8, radius: 0.05, castShadow: true },
      { position: [-2.5, 1.5, 1.5], color: [1, 0.6, 0.4], intensity: 2, radius: 0.05, castShadow: true },
    ];
    const placedBox = (id, translation, scale, material) => ({ id, geometry: 'box', material, translation, scale });
    const recipe = {
      format: '67js.scene', schemaVersion: 1,
      geometries: [{ id: 'box', type: 'box' }, { id: 'ball', type: 'sphere', segments: 48, rings: 32 }],
      materials: [
        { id: 'bricks', color: [1, 1, 1], roughness: 0.9, pattern: { type: 'bricks', size: 0.5 } },
        { id: 'plaster', color: [0.7, 0.68, 0.62], roughness: 0.9 },
        { id: 'boards', color: [0.45, 0.32, 0.22], roughness: 0.6 },
        { id: 'teal', color: [0.2, 0.5, 0.45], roughness: 0.2 },
      ],
      nodes: [
        placedBox('room-floor', [0, -0.05, 0], [8, 0.1, 8], 'boards'),
        placedBox('room-ceiling', [0, 3.05, 0], [8, 0.1, 8], 'plaster'),
        placedBox('room-back', [0, 1.5, -4.05], [8, 3.2, 0.1], 'bricks'),
        placedBox('room-left', [-4.05, 1.5, 0], [0.1, 3.2, 8], 'bricks'),
        placedBox('room-right', [4.05, 1.5, 0], [0.1, 3.2, 8], 'bricks'),
        placedBox('room-front', [0, 1.5, 4.05], [8, 3.2, 0.1], 'plaster'),
        placedBox('table', [0, 0.7, -1], [2.4, 0.1, 1.2], 'plaster'),
        { id: 'vase', geometry: 'ball', material: 'teal', translation: [-0.5, 1.05, -1], scale: [0.3, 0.3, 0.3] },
      ],
      camera: { eye: [0, 1.5, 3.6], target: [0, 1.1, -1], fov: 60, near: 0.05, far: 50 },
    };
    await loadAgentSceneModules(recipe);
    const scene = createAgentScene(recipe);
    return {
      parts: scene.parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { pointLights }),
      camera: { eye: [0, 1.5, 3.6], target: [0, 1.1, -1], up: [0, 1, 0], fov: 60, near: 0.05, far: 50 },
    };
  },

  // A shadowing spot light with a soft cone edge and a rectangular panel, over objects that block the spot.
  async 'spot-area'() {
    const lighting = constantLighting(0.01);
    const cube = box(0, 1);
    const wall = { color: [0.7, 0.68, 0.62], roughness: 0.9 };
    const parts = [
      part('stage-floor', cube, [0, -0.05, 0], [10, 0.1, 10], { color: [0.55, 0.5, 0.45], roughness: 0.7 }),
      part('stage-back', cube, [0, 1.5, -4.05], [10, 3.2, 0.1], wall),
      part('column', cube, [-0.9, 0.75, -1.5], [0.4, 1.5, 0.4], { color: [0.6, 0.6, 0.65], roughness: 0.5 }),
      part('ball', sphere(48, 32), [0.6, 0.5, -1], [0.5, 0.5, 0.5], { color: [0.8, 0.25, 0.2], roughness: 0.3 }),
      part('block', cube, [1.8, 0.3, -2], [0.6, 0.6, 0.6], { color: [0.2, 0.45, 0.75], roughness: 0.6 }),
    ];
    const spotLights = [
      { position: [-2.4, 3.2, 0.5], direction: [2.4, -3.2, -1.7], angle: 0.5, penumbra: 0.3, color: [1, 0.92, 0.8], intensity: 40, radius: 0.05, castShadow: true },
    ];
    const areaLights = [
      { position: [2.2, 2.6, 0], direction: [0, -1, 0], up: [0, 0, 1], width: 1.5, height: 0.8, color: [0.7, 0.8, 1], intensity: 4 },
    ];
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { spotLights, areaLights }),
      camera: { eye: [0, 1.8, 4.5], target: [0, 0.7, -1.5], up: [0, 1, 0], fov: 50, near: 0.05, far: 50 },
    };
  },

  // Issue #623: a 36 m corridor with 24 lamps (16 point, 8 spot) along the ceiling and nothing else lighting it, so most lamps are far from
  // any point and a light tree has something to choose. The lamps do not cast shadow maps (the rasterizer's atlas holds 24 tiles); the path tracer and Cycles shadow every light.
  async 'many-lights'() {
    const lighting = constantLighting(0.01);
    const cube = box(0, 1);
    const wall = { color: [0.72, 0.7, 0.66], roughness: 0.9 };
    const parts = [
      part('corridor-floor', cube, [0, -0.05, 0], [4, 0.1, 36], { color: [0.5, 0.45, 0.4], roughness: 0.6 }),
      part('corridor-ceiling', cube, [0, 3.05, 0], [4, 0.1, 36], wall),
      part('corridor-left', cube, [-2.05, 1.5, 0], [0.1, 3.2, 36], { ...wall, color: [0.6, 0.35, 0.3] }),
      part('corridor-right', cube, [2.05, 1.5, 0], [0.1, 3.2, 36], { ...wall, color: [0.3, 0.42, 0.58] }),
      part('corridor-end', cube, [0, 1.5, -18.05], [4, 3.2, 0.1], wall),
      part('pillar-near', cube, [-1.2, 0.8, 4], [0.5, 1.6, 0.5], { color: [0.6, 0.6, 0.65], roughness: 0.5 }),
      part('ball', sphere(48, 32), [0.8, 0.5, 1], [0.5, 0.5, 0.5], { color: [0.8, 0.25, 0.2], roughness: 0.3 }),
      part('block-far', cube, [0.7, 0.4, -7], [0.8, 0.8, 0.8], { color: [0.2, 0.45, 0.75], roughness: 0.6 }),
    ];
    const lampPosition = index => [index % 2 === 0 ? -0.8 : 0.8, 2.8, 15 - index * 1.4];
    const lampColor = index => (index % 3 === 0 ? [1, 0.75, 0.5] : index % 3 === 1 ? [0.85, 0.9, 1] : [1, 0.95, 0.85]);
    const lampIndices = Array.from({ length: 24 }, (_, index) => index);
    const pointLights = lampIndices.filter(index => index % 3 !== 2).map(index => ({ position: lampPosition(index), color: lampColor(index), intensity: 3, radius: 0.05, castShadow: false }));
    const spotLights = lampIndices.filter(index => index % 3 === 2).map(index => ({ position: lampPosition(index), direction: [0, -1, 0], angle: 1, penumbra: 0.5, color: lampColor(index), intensity: 6, radius: 0.05, castShadow: false }));
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { pointLights, spotLights }),
      camera: { eye: [0, 1.5, 17], target: [0, 1.2, -8], up: [0, 1, 0], fov: 55, near: 0.05, far: 80 },
    };
  },

  // A street 140 m long under the sun. A single shadow map has to cover the whole street, so its texels are about 8 cm wide;
  // cascades give the cars and lamp posts near the camera 1 to 2 cm texels. harness.js draws it with one map by default and
  // with cascades when run.mjs gets --cascades <count>.
  async 'long-street'() {
    const lighting = constantLighting(0.25);
    const cube = box(0, 1);
    const parts = [part('street-ground', cube, [0, -0.05, -10], [60, 0.1, 160], { color: [0.32, 0.32, 0.33], roughness: 0.9 })];
    const facade = { color: [0.62, 0.55, 0.48], roughness: 0.85 };
    for (let block = 0; block < 12; block++) {
      const z = 55 - block * 12;
      const height = 5 + ((block * 7) % 5) * 2;
      parts.push(part(`building-west-${block}`, cube, [-10.5, height / 2, z], [6, height, 10], facade));
      parts.push(part(`building-east-${block}`, cube, [10.5, (height + 3) / 2, z], [6, height + 3, 10], { color: [0.55, 0.58, 0.62], roughness: 0.85 }));
    }
    for (let post = 0; post < 14; post++) {
      const z = 52 - post * 10;
      parts.push(part(`lamp-post-${post}`, cube, [-4.6, 2.2, z], [0.16, 4.4, 0.16], { color: [0.15, 0.15, 0.16], roughness: 0.4, metallic: 0.8 }));
      parts.push(part(`lamp-arm-${post}`, cube, [-4.1, 4.3, z], [1.1, 0.12, 0.12], { color: [0.15, 0.15, 0.16], roughness: 0.4, metallic: 0.8 }));
    }
    const carColors = [[0.7, 0.1, 0.1], [0.1, 0.25, 0.6], [0.85, 0.8, 0.7], [0.1, 0.4, 0.2]];
    carColors.forEach((color, index) => {
      parts.push(part(`car-body-${index}`, cube, [2.4, 0.55, 44 - index * 9], [1.8, 0.7, 4.2], { color, roughness: 0.35 }));
      parts.push(part(`car-roof-${index}`, cube, [2.4, 1.15, 44.3 - index * 9], [1.5, 0.5, 2.2], { color: [0.12, 0.14, 0.17], roughness: 0.2 }));
    });
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR, lightDirection: [-0.7, 0.8, 0.35] }),
      camera: { eye: [-1.5, 1.7, 56], target: [0, 2.2, -40], up: [0, 1, 0], fov: 50, near: 0.1, far: 200 },
      shadow: shadowAlongSun([-0.7, 0.8, 0.35], { target: [0, 0, -10], distance: 96.54, extent: 85, near: 1, far: 260 }),
    };
  },

  // Three point lights that each light only some parts (light linking). Without linking the red light would tint the right
  // sphere too. Blender gets the same lists as light-linking receiver collections.
  async 'light-linking'() {
    const lighting = constantLighting(0.01);
    const cube = box(0, 1);
    const parts = [
      part('stage-floor', cube, [0, -0.05, 0], [10, 0.1, 10], { color: [0.6, 0.6, 0.6], roughness: 0.8 }),
      part('stage-back', cube, [0, 1.5, -3.05], [10, 3.2, 0.1], { color: [0.7, 0.7, 0.7], roughness: 0.9 }),
      part('sphere-left', sphere(48, 32), [-1.2, 0.6, -0.5], [0.6, 0.6, 0.6], { color: [0.8, 0.8, 0.8], roughness: 0.4 }),
      part('sphere-right', sphere(48, 32), [1.2, 0.6, -0.5], [0.6, 0.6, 0.6], { color: [0.8, 0.8, 0.8], roughness: 0.4 }),
      part('block-center', cube, [0, 0.4, -1.5], [0.8, 0.8, 0.8], { color: [0.8, 0.8, 0.8], roughness: 0.6 }),
    ];
    const pointLights = [
      { position: [-1.8, 2.4, 1.2], color: [1, 0.35, 0.2], intensity: 14, radius: 0.1, affects: ['sphere-left', 'block-center'] },
      { position: [1.8, 2.4, 1.2], color: [0.25, 0.45, 1], intensity: 14, radius: 0.1, affects: ['sphere-right'] },
      { position: [0, 3, 2.5], color: [1, 1, 1], intensity: 6, radius: 0.1, affects: ['stage-floor', 'stage-back'] },
    ];
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { pointLights }),
      camera: { eye: [0, 1.6, 4.6], target: [0, 0.6, -0.8], up: [0, 1, 0], fov: 50, near: 0.05, far: 50 },
    };
  },

  async character() {
    const lighting = await skyLighting();
    const response = await fetch(`/${ROBOT_FILE}`);
    const asset = await parseGltf(await response.arrayBuffer());
    return {
      parts: [floor([0.4, 0.42, 0.45]), ...asset.parts], blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [2, 3.5, 9], target: [0, 2.4, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 200 },
      shadow: shadowAlongSun(DEFAULT_SUN_DIRECTION, { target: [0, 2, 0], distance: 14.14, extent: 7, near: 0.1, far: 40 }),
    };
  },

  async foliage() {
    const lighting = await skyLighting();
    const tree = createTree({ species: 'broadleaf', height: 6, leaves: 'cards' }, 3);
    return {
      parts: [floor([0.25, 0.3, 0.18]), ...vegetationParts(tree, placedMatrix([0, 0, 0], [1, 1, 1]))],
      blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [0, 3.5, 12], target: [0, 3.2, 0], up: [0, 1, 0], fov: 40, near: 0.1, far: 200 },
      shadow: shadowAlongSun(DEFAULT_SUN_DIRECTION, { target: [0, 3, 0], distance: 14.87, extent: 9, near: 0.1, far: 40 }),
    };
  },

  async glass() {
    const lighting = await skyLighting();
    const cube = box(0, 1);
    const parts = [floor()];
    const colors = [[0.8, 0.15, 0.1], [0.9, 0.8, 0.2], [0.15, 0.6, 0.25], [0.15, 0.3, 0.8]];
    colors.forEach((color, index) => {
      parts.push(part(`stripe-${index}`, cube, [(index - 1.5) * 1, 1, -1.5], [0.5, 2, 0.2], { color, roughness: 0.6 }));
    });
    parts.push(part('glass-sphere', sphere(96, 64), [0, 0.9, 0.5], [0.9, 0.9, 0.9], {
      color: [1, 1, 1], roughness: 0.02, transmission: 1, ior: 1.5, thickness: 1.8,
    }));
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [0, 1.8, 6], target: [0, 0.9, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 200 },
      shadow: shadowAlongSun(DEFAULT_SUN_DIRECTION, { target: [0, 0, 0], distance: 15.62, extent: 6, near: 0.1, far: 40 }),
    };
  },

  async 'car-paint'() {
    const lighting = await skyLighting();
    const parts = [
      floor([0.2, 0.2, 0.22]),
      part('lacquer-red', sphere(96, 64), [-1.6, 0.8, 0], [0.8, 0.8, 0.8], { color: [0.55, 0.02, 0.02], roughness: 0.5, clearcoat: 1, clearcoatRoughness: 0.03 }),
      part('flake-blue', sphere(96, 64), [0, 0.8, 0], [0.8, 0.8, 0.8], { color: [0.03, 0.12, 0.6], metallic: 0.8, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.03 }),
      part('uncoated-red', sphere(96, 64), [1.6, 0.8, 0], [0.8, 0.8, 0.8], { color: [0.55, 0.02, 0.02], roughness: 0.5 }),
    ];
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [0, 2.2, 7], target: [0, 0.7, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 200 },
      shadow: shadowAlongSun(DEFAULT_SUN_DIRECTION, { target: [0, 0, 0], distance: 15.62, extent: 6, near: 0.1, far: 40 }),
    };
  },

  // Anisotropy and iridescence against Cycles: a brushed gold sphere, a dark dielectric with a thin film and a silver one.
  async 'brushed-film'() {
    const lighting = await skyLighting();
    const parts = [
      floor([0.2, 0.2, 0.22]),
      part('brushed-gold', sphere(96, 64), [-1.6, 0.8, 0], [0.8, 0.8, 0.8], { color: [1, 0.77, 0.34], metallic: 1, roughness: 0.35, anisotropy: 0.8 }),
      part('oil-film', sphere(96, 64), [0, 0.8, 0], [0.8, 0.8, 0.8], { color: [0.02, 0.02, 0.025], roughness: 0.15, iridescence: 1, iridescenceIor: 1.3, iridescenceThickness: 400 }),
      part('film-on-silver', sphere(96, 64), [1.6, 0.8, 0], [0.8, 0.8, 0.8], { color: [0.9, 0.9, 0.92], metallic: 1, roughness: 0.2, iridescence: 1, iridescenceIor: 1.3, iridescenceThickness: 400 }),
    ];
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [0, 2.2, 7], target: [0, 0.7, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 200 },
      shadow: shadowAlongSun(DEFAULT_SUN_DIRECTION, { target: [0, 0, 0], distance: 15.62, extent: 6, near: 0.1, far: 40 }),
    };
  },

  async metal() {
    const lighting = await skyLighting();
    const parts = [
      floor([0.2, 0.2, 0.22]),
      part('chrome', sphere(96, 64), [-1.6, 0.8, 0], [0.8, 0.8, 0.8], { color: [0.95, 0.95, 0.95], metallic: 1, roughness: 0.05 }),
      part('gold', torus(0.3, 96, 32), [0.3, 1.1, 0], [0.7, 0.7, 0.7], { color: [1, 0.77, 0.34], metallic: 1, roughness: 0.3 }),
      part('copper', box(0, 1), [2, 0.6, 0], [1.2, 1.2, 1.2], { color: [0.95, 0.64, 0.54], metallic: 1, roughness: 0.5 }),
      part('steel', cylinder(64, 0, 1), [0, 0.2, 1.6], [0.5, 0.4, 0.5], { color: [0.56, 0.57, 0.58], metallic: 1, roughness: 0.2 }),
    ];
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [0, 2.2, 7], target: [0, 0.7, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 200 },
      shadow: shadowAlongSun(DEFAULT_SUN_DIRECTION, { target: [0, 0, 0], distance: 15.62, extent: 6, near: 0.1, far: 40 }),
    };
  },

  async fog() {
    const lighting = constantLighting(0.05);
    const cube = box(0, 1);
    const parts = [floor([0.35, 0.35, 0.35])];
    for (let index = 0; index < 5; index++) {
      parts.push(part(`pillar-left-${index}`, cube, [-2, 2, -index * 2.2 + 3], [0.5, 4, 0.5], { color: [0.5, 0.48, 0.45], roughness: 0.8 }));
      parts.push(part(`pillar-right-${index}`, cube, [2, 2, -index * 2.2 + 3], [0.5, 4, 0.5], { color: [0.5, 0.48, 0.45], roughness: 0.8 }));
    }
    const volumeFog = {
      density: 0.25, minimum: [-8, 0, -10], maximum: [8, 6, 8], color: [1, 1, 1], ambient: [0.05, 0.05, 0.05],
      anisotropy: 0.3, noiseAmount: 0, steps: 48, maxDistance: 60,
    };
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { lightDirection: [-5, 6, 2], keyColor: [6, 5.6, 5], volumeFog }),
      camera: { eye: [0, 1.6, 7], target: [0, 1.6, -4], up: [0, 1, 0], fov: 50, near: 0.1, far: 80 },
      shadow: shadowAlongSun([-5, 6, 2], { target: [0, 0, -1], distance: 16.4, extent: 12, near: 0.1, far: 50 }),
    };
  },

  async 'outdoor-hdri'() {
    const lighting = await skyLighting();
    const cube = box(0, 1);
    const parts = [
      floor([0.4, 0.38, 0.32]),
      part('block-large', cube, [-2.5, 1.5, -2], [2, 3, 2], { color: [0.6, 0.55, 0.5], roughness: 0.8 }),
      part('block-small', cube, [1, 0.5, 0], [1, 1, 1], { color: [0.7, 0.3, 0.2], roughness: 0.6 }),
      part('ball', sphere(64, 40), [3, 0.8, -1], [0.8, 0.8, 0.8], { color: [0.2, 0.4, 0.7], roughness: 0.3 }),
    ];
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [0, 2, 10], target: [0, 1.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 300 },
      shadow: shadowAlongSun(DEFAULT_SUN_DIRECTION, { target: [0, 0, 0], distance: 18.97, extent: 10, near: 0.1, far: 50 }),
    };
  },
};

// Cloth against a Blender cloth bake (npm run reference -- --cloth). 67js bakes the sheet with its own solver and Blender
// bakes the same sheet with its cloth modifier from rest to the same time; both are drawn in the same lit scene.
// Blender's air damping of 1 acts on a 0.003 kg particle as a drag of about 54 per second (the terminal speed of a
// falling sheet is 0.18 m/s), so both sides use a drag of 0.1 Blender units, which is 5.4 per second here.
const BLENDER_AIR_DAMPING = 0.1;
const DAMPING_PER_BLENDER_AIR_UNIT = 54;
const CLOTH_SEGMENTS = 12;
const CLOTH_DENSITY = 0.2;
// Blender's wind field and this solver's wind speed differ in kind (linear against quadratic drag). The two are matched
// by the steady swing of the banner: field strength 2 and 1.5 m/s both hold the free edge about 0.6 m out at 3 s.
const BANNER_WIND_SPEED = 1.5;
const BANNER_BLENDER_WIND_STRENGTH = 2;

async function clothScene({ kind, seconds }) {
  const lighting = await skyLighting();
  const isBanner = kind === 'banner';
  const sheetNode = isBanner
    ? { id: 'cloth', geometry: 'sheet', material: 'cloth', translation: [0, 2.5, 0], scale: [2, 1.2, 1] }
    : { id: 'cloth', geometry: 'sheet', material: 'cloth', translation: [0, 1.4, 0], rotation: [-0.7071068, 0, 0, 0.7071068], scale: [1.6, 1.6, 1] };
  const recipe = {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'sheet', type: 'grid', segments: CLOTH_SEGMENTS }, { id: 'ball', type: 'sphere', segments: 48, rings: 32 }, { id: 'box', type: 'box' }],
    materials: [{ id: 'cloth', color: [0.8, 0.25, 0.2], roughness: 0.7 }, { id: 'ball', color: [0.25, 0.4, 0.7], roughness: 0.4 }, { id: 'ground', color: [0.5, 0.5, 0.5], roughness: 0.8 }],
    nodes: [
      sheetNode,
      { id: 'floor', geometry: 'box', material: 'ground', translation: [0, -0.05, 0], scale: [40, 0.1, 40] },
      ...(isBanner ? [] : [{ id: 'ball', geometry: 'ball', material: 'ball', translation: [0, 0.4, 0], scale: [0.4, 0.4, 0.4] }]),
    ],
    cloth: {
      duration: seconds,
      ...(isBanner ? { wind: [0, 0, BANNER_WIND_SPEED] } : {}),
      sheets: [{ node: 'cloth', density: CLOTH_DENSITY, damping: BLENDER_AIR_DAMPING * DAMPING_PER_BLENDER_AIR_UNIT, ...(isBanner ? { pin: ['top'] } : {}) }],
      colliders: isBanner ? [] : [{ node: 'ball', shape: 'ball' }, { node: 'floor' }],
    },
  };
  await loadAgentSceneModules(recipe);
  const scene = createAgentScene(recipe);
  scene.sampleMotion(0);
  const restMatrix = [...scene.parts.find(entry => entry.name === 'cloth').matrix];
  scene.sampleMotion(seconds);
  const sheetArea = Math.hypot(restMatrix[0], restMatrix[1], restMatrix[2]) * Math.hypot(restMatrix[4], restMatrix[5], restMatrix[6]);
  return {
    parts: scene.parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: SUN_COLOR }),
    camera: isBanner
      ? { eye: [1.2, 2.2, 6.5], target: [0.1, 1.9, 0.3], up: [0, 1, 0], fov: 35, near: 0.1, far: 200 }
      : { eye: [2.6, 1.5, 3.6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 200 },
    shadow: shadowAlongSun(DEFAULT_SUN_DIRECTION, { target: [0, 0, 0], distance: 15.62, extent: 8, near: 0.1, far: 40 }),
    blenderCloth: {
      part: 'cloth', segments: CLOTH_SEGMENTS, restMatrix, seconds, framesPerSecond: 60,
      vertexMass: CLOTH_DENSITY * sheetArea / ((CLOTH_SEGMENTS + 1) ** 2),
      airDamping: BLENDER_AIR_DAMPING,
      pinTopRow: isBanner,
      windStrength: isBanner ? BANNER_BLENDER_WIND_STRENGTH : 0,
      // The wind pushes along the sheet's facing, +Z in 67js axes.
      windDirection: [0, 0, 1],
      colliders: isBanner ? [] : ['ball', 'floor'],
    },
  };
}

export const CLOTH_SCENES = {
  'banner-1s': () => clothScene({ kind: 'banner', seconds: 1 }),
  'banner-2s': () => clothScene({ kind: 'banner', seconds: 2 }),
  'drape-0.5s': () => clothScene({ kind: 'drape', seconds: 0.5 }),
  'drape-1s': () => clothScene({ kind: 'drape', seconds: 1 }),
  'drape-2s': () => clothScene({ kind: 'drape', seconds: 2 }),
};

// Issue #304: the same AnisotropyBarnLamp as the suite's GLB, as the separate-file glTF with PNG textures and as the
// KHR_texture_basisu variant (bench/ktx2/measure.mjs downloads both into artifacts/ktx2/). Drawn through the Khronos
// framing, so they score against the suite's stored Cycles array. They are a set of their own and never reach baseline.json.
const KTX2_ASSET_DIRECTORY = 'artifacts/ktx2/AnisotropyBarnLamp';
const BASIS_TRANSCODER_PATH = '/node_modules/three/examples/jsm/libs/basis/';

// Loads one variant the way an app does and returns the asset with the format of the context that decoded it.
export async function loadBarnLampVariant(directoryName) {
  const url = `/${KTX2_ASSET_DIRECTORY}/${directoryName}/AnisotropyBarnLamp.gltf`;
  const decoders = {};
  let loader = null;
  let workerConfig = null;
  if (directoryName === 'ktx2') {
    loader = new KTX2Loader().setTranscoderPath(BASIS_TRANSCODER_PATH);
    workerConfig = ktx2WorkerConfigFor(document.createElement('canvas').getContext('webgl2'));
    loader.workerConfig = workerConfig;
    decoders.ktx2 = loader;
  }
  const asset = await loadGltf(url, { decoders });
  loader?.dispose();
  return { asset, workerConfig, url };
}

async function ktx2VariantScene(directoryName) {
  const { asset, url } = await loadBarnLampVariant(directoryName);
  return khronosSceneFromAsset(asset, url.slice(1));
}

export const KTX2_SCENES = {
  'AnisotropyBarnLamp-png': () => ktx2VariantScene('png'),
  'AnisotropyBarnLamp-ktx2': () => ktx2VariantScene('ktx2'),
};
