// A deterministic scene of four large meshes for the native triangle bound (#1041): the meshes are rippled grids side by side, two of
// them appear a second time (sharing their geometry object, so an instanced build keeps them as instances), and one emissive
// quad lights them. `uniqueTriangles` is about the triangles of the four meshes together.
import { createCamera } from '../../src/path-tracer.js';
import { buildRippledGrid } from './large-scene.mjs';

const MESH_COUNT = 4;
const COPIED_MESH_COUNT = 2;
const MESH_SPACING = 7;
const MESH_HALF_SIZE = 3;

export const NATIVE_CAP_ENVIRONMENT = { keyColor: [3, 3, 3], lightDirection: [0.4, 0.8, 0.5] };
export const NATIVE_CAP_PACK_OPTIONS = { width: 480, height: 270, bounces: 4, seed: 1, fireflyClamp: 20, noiseThreshold: 0 };

const SURFACE_MATERIAL = { color: [0.6, 0.55, 0.5], roughness: 0.7 };
const LAMP_MATERIAL = { color: [1, 0.95, 0.9], emission: 6, roughness: 1 };

const LAMP_QUAD = {
  positions: new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
  normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  colors: new Float32Array(12).fill(1),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

function translation(x, y, z, scale = 1) {
  return new Float32Array([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1]);
}

function buildMesh(meshIndex, cells) {
  const phase = 1 + meshIndex * 0.35;
  return buildRippledGrid(cells, MESH_HALF_SIZE, (x, z) => 0.35 * Math.sin(phase * x) * Math.cos(phase * z));
}

/** The parts of the scene: `uniqueTriangles` is the target for the four meshes together; `copies` adds the two shared copies. */
export function buildNativeCapParts(uniqueTriangles, copies) {
  const cells = Math.max(1, Math.round(Math.sqrt(uniqueTriangles / MESH_COUNT / 2)));
  const meshes = Array.from({ length: MESH_COUNT }, (_, meshIndex) => buildMesh(meshIndex, cells));
  const leftEdge = -MESH_SPACING * (MESH_COUNT - 1) / 2;
  const parts = meshes.map((geometry, meshIndex) => ({ name: `mesh-${meshIndex}`, geometry, matrix: translation(leftEdge + meshIndex * MESH_SPACING, 0, 0), material: SURFACE_MATERIAL }));
  if (copies) {
    for (let meshIndex = 0; meshIndex < COPIED_MESH_COUNT; meshIndex++) {
      parts.push({ name: `copy-${meshIndex}`, geometry: meshes[meshIndex], matrix: translation(leftEdge + meshIndex * MESH_SPACING, 0, MESH_SPACING), material: SURFACE_MATERIAL });
    }
  }
  parts.push({ name: 'lamp', geometry: LAMP_QUAD, matrix: translation(0, 6, 0, 9), material: LAMP_MATERIAL });
  return { parts, uniqueTriangles: meshes.reduce((total, mesh) => total + mesh.indices.length / 3, 0) };
}

export function nativeCapCamera() {
  const { width, height } = NATIVE_CAP_PACK_OPTIONS;
  return createCamera({ eye: [0, 11, 24], target: [0, 0, 2], fov: 50, near: 0.05, far: 200 }, width, height);
}
