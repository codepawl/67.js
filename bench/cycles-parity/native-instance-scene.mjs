// A deterministic field of small cards for the native instance bound (#1055): `count` copies of one two-triangle card, tilted
// and turned by a fixed hash, on a square grid under a sun. Cards from `redFrom` on are red and the others grey, so a picture
// shows whether the instances past an index were traced at all. `buildCardFieldMerged` writes the same cards into two
// world-space meshes (grey and red) for the picture the instanced one is compared with.
import { createCamera } from '../../src/path-tracer.js';

export const CARD_FIELD_ENVIRONMENT = { keyColor: [3, 3, 3], lightDirection: [0.4, 0.8, 0.5] };
export const CARD_FIELD_PACK_OPTIONS = { width: 160, height: 120, bounces: 3, seed: 1, fireflyClamp: 20, noiseThreshold: 0 };

const CARD_HALF_SIZE = 0.5;
const CARD_SPACING = 1.2;
const GREY_MATERIAL = { color: [0.6, 0.6, 0.6], roughness: 0.7 };
const RED_MATERIAL = { color: [0.8, 0.1, 0.1], roughness: 0.7 };
const GROUND_MATERIAL = { color: [0.5, 0.5, 0.5], roughness: 0.9 };

const CARD = {
  positions: new Float32Array([-CARD_HALF_SIZE, 0, -CARD_HALF_SIZE, CARD_HALF_SIZE, 0, -CARD_HALF_SIZE, CARD_HALF_SIZE, 0, CARD_HALF_SIZE, -CARD_HALF_SIZE, 0, CARD_HALF_SIZE]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
};

function hashUnit(index, salt) {
  let state = Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d);
  state = Math.imul(state ^ (state >>> 12), 0x297a2d39);
  return ((state ^ (state >>> 15)) >>> 0) / 4294967296;
}

// Column-major: a turn about Y, then a tilt about X, then the move to the grid cell of the card.
function cardMatrix(index, columns) {
  const turn = hashUnit(index, 1) * Math.PI * 2;
  const tilt = (hashUnit(index, 2) - 0.5) * 0.8;
  const cosineTurn = Math.cos(turn);
  const sineTurn = Math.sin(turn);
  const cosineTilt = Math.cos(tilt);
  const sineTilt = Math.sin(tilt);
  const x = ((index % columns) - columns / 2) * CARD_SPACING;
  const z = (Math.floor(index / columns) - columns / 2) * CARD_SPACING;
  return new Float32Array([
    cosineTurn, 0, -sineTurn, 0,
    sineTurn * sineTilt, cosineTilt, cosineTurn * sineTilt, 0,
    sineTurn * cosineTilt, -sineTilt, cosineTurn * cosineTilt, 0,
    x, 0.2 + hashUnit(index, 3) * 0.3, z, 1,
  ]);
}

function groundPart(halfSize) {
  const geometry = {
    positions: new Float32Array([-halfSize, -0.05, -halfSize, halfSize, -0.05, -halfSize, halfSize, -0.05, halfSize, -halfSize, -0.05, halfSize]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: CARD.uvs,
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
  };
  return { name: 'ground', geometry, material: GROUND_MATERIAL };
}

function fieldSize(count) {
  const columns = Math.ceil(Math.sqrt(count));
  return { columns, halfSize: columns * CARD_SPACING / 2 + 1 };
}

/** The camera looks straight down at the whole field, so every card is in the picture. */
export function cardFieldCamera(count) {
  const { halfSize } = fieldSize(count);
  const { width, height } = CARD_FIELD_PACK_OPTIONS;
  return createCamera({ eye: [0, halfSize * 1.9, 0.001], target: [0, 0, 0], fov: 50, near: 0.05, far: halfSize * 4 }, width, height);
}

/** `count` cards sharing one geometry object: the instanced scene. Cards from `redFrom` on are red. */
export function buildCardField(count, redFrom) {
  const { columns, halfSize } = fieldSize(count);
  const parts = [groundPart(halfSize)];
  for (let index = 0; index < count; index++) {
    parts.push({ name: `card-${index}`, geometry: CARD, matrix: cardMatrix(index, columns), material: index >= redFrom ? RED_MATERIAL : GREY_MATERIAL });
  }
  return parts;
}

function appendCard(mesh, matrix) {
  const vertexOffset = mesh.positions.length / 3;
  for (let vertex = 0; vertex < 4; vertex++) {
    const x = CARD.positions[vertex * 3];
    const y = CARD.positions[vertex * 3 + 1];
    const z = CARD.positions[vertex * 3 + 2];
    for (let axis = 0; axis < 3; axis++) mesh.positions.push(matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis]);
    for (let axis = 0; axis < 3; axis++) mesh.normals.push(matrix[4 + axis]);
    mesh.uvs.push(CARD.uvs[vertex * 2], CARD.uvs[vertex * 2 + 1]);
  }
  for (const corner of CARD.indices) mesh.indices.push(vertexOffset + corner);
}

function meshPart(name, mesh, material) {
  return {
    name,
    geometry: { positions: Float32Array.from(mesh.positions), normals: Float32Array.from(mesh.normals), uvs: Float32Array.from(mesh.uvs), indices: Uint32Array.from(mesh.indices) },
    material,
  };
}

/** The same cards merged into one grey and one red world-space mesh, with the same ground: the flattened reference picture. */
export function buildCardFieldMerged(count, redFrom) {
  const { columns, halfSize } = fieldSize(count);
  const grey = { positions: [], normals: [], uvs: [], indices: [] };
  const red = { positions: [], normals: [], uvs: [], indices: [] };
  for (let index = 0; index < count; index++) appendCard(index >= redFrom ? red : grey, cardMatrix(index, columns));
  const parts = [groundPart(halfSize)];
  if (grey.indices.length > 0) parts.push(meshPart('grey-cards', grey, GREY_MATERIAL));
  if (red.indices.length > 0) parts.push(meshPart('red-cards', red, RED_MATERIAL));
  return parts;
}
