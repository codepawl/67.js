// Writes the scenes that check Cook's thin-sheet diffuse transmission against Blender Cycles (#1058): a vertical sheet
// (a curtain) above a grey floor, lit from behind, lit from the front, and, as the control, the backlit sheet at weight 0.
//   node bench/cycles-parity/make-diffuse-transmission-scenes.mjs <outputDirectory>
// Render them without --grey-diffuse. Cycles builds the lobe as a Principled BSDF at (1 - weight) * base colour plus a
// Translucent BSDF at weight * colour (render-cycles.py), so every material here has `specular: 0`: with no specular lobe
// the diffuse layer is the whole surface and both sides split it the same way.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SHEET_HALF_WIDTH = 1.5;
const SHEET_HALF_HEIGHT = 1.2;
const FLOOR_HALF_SIZE = 6;
const FLOOR_HEIGHT = -1.2;
const WEIGHT = 0.6;
const SHEET_COLOR = [0.8, 0.75, 0.7];
const TRANSMISSION_COLOR = [0.95, 0.55, 0.25];
const WORLD_RADIANCE = 0.05;

function encodeTypedArray(typedArray) {
  const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  return { type: typedArray.constructor.name, base64: Buffer.from(bytes).toString('base64') };
}

// A quad in the plane z = 0 (the sheet) or y = 0 (the floor), facing the viewer side the camera sees.
function createQuadGeometry(corners, normal) {
  const positions = Float32Array.from(corners.flat());
  const normals = Float32Array.from(Array.from({ length: 4 }, () => normal).flat());
  return {
    positions: encodeTypedArray(positions),
    normals: encodeTypedArray(normals),
    indices: encodeTypedArray(Uint32Array.from([0, 1, 2, 0, 2, 3])),
  };
}

function createMaterial(color, extraFields = {}) {
  return { tag: 'surface', color, metallic: 0, roughness: 1, specular: 0, emission: 0, ...extraFields };
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function createScene(id, sheetMaterial, areaLight) {
  return {
    id,
    camera: { eye: [1.4, 0.3, 4.6], target: [0, -0.1, 0], up: [0, 1, 0], fov: 40, near: 0.05, far: 50 },
    environment: {
      world: true,
      fillIntensity: 0,
      ambientIntensity: 1,
      fogDensity: 0,
      lightDirection: [0, 1, 0],
      keyColor: [0, 0, 0],
      pointLights: [],
      spotLights: [],
      areaLights: [areaLight],
    },
    world: { type: 'constant', value: WORLD_RADIANCE },
    materials: [createMaterial([0.5, 0.5, 0.5]), sheetMaterial],
    images: [],
    geometries: [
      createQuadGeometry(
        [[-FLOOR_HALF_SIZE, FLOOR_HEIGHT, FLOOR_HALF_SIZE], [FLOOR_HALF_SIZE, FLOOR_HEIGHT, FLOOR_HALF_SIZE], [FLOOR_HALF_SIZE, FLOOR_HEIGHT, -FLOOR_HALF_SIZE], [-FLOOR_HALF_SIZE, FLOOR_HEIGHT, -FLOOR_HALF_SIZE]],
        [0, 1, 0],
      ),
      createQuadGeometry(
        [[-SHEET_HALF_WIDTH, -SHEET_HALF_HEIGHT, 0], [SHEET_HALF_WIDTH, -SHEET_HALF_HEIGHT, 0], [SHEET_HALF_WIDTH, SHEET_HALF_HEIGHT, 0], [-SHEET_HALF_WIDTH, SHEET_HALF_HEIGHT, 0]],
        [0, 0, 1],
      ),
    ],
    parts: [
      { name: 'floor', geometry: 0, matrix: IDENTITY_MATRIX, material: 0 },
      { name: 'sheet', geometry: 1, matrix: IDENTITY_MATRIX, material: 1 },
    ],
  };
}

const translucentSheet = createMaterial(SHEET_COLOR, { diffuseTransmission: WEIGHT, diffuseTransmissionColor: TRANSMISSION_COLOR });
const opaqueSheet = createMaterial(SHEET_COLOR, { diffuseTransmission: 0, diffuseTransmissionColor: TRANSMISSION_COLOR });

// A lamp 1.6 m behind the sheet, facing it; and a lamp in front of it, above the picture, facing down and forward.
const lampBehind = { position: [0, 0.2, -1.6], direction: [0, 0, 1], up: [0, 1, 0], width: 3, height: 2.5, color: [1, 0.95, 0.9], intensity: 6 };
const lampInFront = { position: [0.6, 2.4, 3.2], direction: [-0.1, -0.5, -1], up: [0, 1, 0], width: 1.6, height: 1.6, color: [1, 0.95, 0.9], intensity: 12 };

const scenes = [
  createScene('sheet-backlit', translucentSheet, lampBehind),
  createScene('sheet-front', translucentSheet, lampInFront),
  createScene('sheet-backlit-weight-0', opaqueSheet, lampBehind),
];

const outputDirectory = process.argv[2];
if (!outputDirectory) {
  throw new RangeError('Usage: node bench/cycles-parity/make-diffuse-transmission-scenes.mjs <outputDirectory>');
}
const scenesDirectory = join(resolve(outputDirectory), 'scenes');
await mkdir(scenesDirectory, { recursive: true });
for (const scene of scenes) {
  await writeFile(join(scenesDirectory, `${scene.id}.json`), JSON.stringify(scene));
  console.log(scene.id);
}
