// The scenes of the native job material checks.
//   parityScene(name): raw parts, environment and camera (the reference scene shape of bench/reference) for one material
//     field the v1 job tables used to drop, or the composite of a blend pane and a sheen cloth. Cycles renders the same
//     description (bench/cycles-parity/render-cycles.py) and Cook traces it through the export a native job runs.
//   recipeFor(name): a scene recipe for a real MCP job, to compare a job on this branch with one on the base branch.
import { readFileSync } from 'node:fs';
import { box, sphere } from '../../src/geometry.js';

export const PARITY_SCENE_NAMES = ['blend', 'sheen', 'specular-tint', 'anisotropy', 'iridescence', 'absorption', 'composite'];

const SUN_COLOR = [3, 2.8, 2.5];

function placed(name, geometry, translation, scale, material) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry, matrix, material: { tag: 'surface', metallic: 0, roughness: 0.5, emission: 0, ...material } };
}

function stage() {
  return [
    placed('floor', box(0, 1), [0, -1.05, 0], [12, 0.1, 12], { color: [0.5, 0.5, 0.5], roughness: 0.8 }),
    placed('wall', box(0, 1), [0, 1, -3], [12, 6, 0.1], { color: [0.45, 0.5, 0.55], roughness: 0.9 }),
  ];
}

function subject(material) {
  return placed('subject', sphere(64, 40), [0, 0, 0], [0.9, 0.9, 0.9], material);
}

function stripes() {
  return [
    placed('stripe-red', box(0, 1), [-0.9, 0, -1.2], [0.8, 1.6, 0.1], { color: [0.9, 0.15, 0.1], roughness: 0.6 }),
    placed('stripe-white', box(0, 1), [0.9, 0, -1.2], [0.8, 1.6, 0.1], { color: [0.9, 0.9, 0.9], roughness: 0.6 }),
  ];
}

const pane = () => placed('pane', box(0, 1), [0, 0, 1.2], [2.6, 1.8, 0.04], { color: [0.4, 0.65, 1], roughness: 0.1, opacity: 0.3, alphaMode: 'blend' });

const subjectMaterials = {
  sheen: { color: [0.25, 0.05, 0.35], roughness: 0.8, sheenColor: [1, 1, 1], sheenRoughness: 0.4 },
  'specular-tint': { color: [0.9, 0.8, 0.5], metallic: 1, roughness: 0.3, specular: 0.8, specularColor: [1, 0.5, 0.2] },
  anisotropy: { color: [0.9, 0.8, 0.5], metallic: 1, roughness: 0.35, anisotropy: 0.7, anisotropyRotation: 0.5 },
  iridescence: { color: [0.8, 0.8, 0.8], roughness: 0.15, iridescence: 1, iridescenceIor: 1.4, iridescenceThickness: 500 },
  absorption: { color: [1, 1, 1], roughness: 0.02, transmission: 1, ior: 1.45, attenuationDistance: 1, attenuationColor: [0.2, 0.8, 0.4] },
};

export function parityScene(name) {
  let parts;
  if (name === 'blend') parts = [...stage(), ...stripes(), pane()];
  else if (name === 'composite') parts = [...stage(), ...stripes(), placed('cloth', sphere(64, 40), [0, 0, 0], [0.7, 0.7, 0.7], subjectMaterials.sheen), pane()];
  else if (subjectMaterials[name]) parts = [...stage(), subject(subjectMaterials[name])];
  else throw new RangeError(`Unknown parity scene "${name}". Pass one of: ${PARITY_SCENE_NAMES.join(', ')}.`);
  return {
    parts,
    camera: { eye: [0, 0.6, 5.2], target: [0, 0.2, 0], fov: 40, near: 0.1, far: 60 },
    environment: { world: true, fillIntensity: 0, ambientIntensity: 1, fogDensity: 0, lightDirection: [-3, 6, 4], keyColor: SUN_COLOR, pointLights: [], spotLights: [], areaLights: [] },
    blenderWorld: { type: 'constant', value: 0.4 },
  };
}

export const IDENTITY_SCENE_NAMES = ['room', 'textured', 'shared', 'glass'];

const IDENTITY_MATERIALS = [
  { id: 'brick', color: [1, 1, 1], roughness: 0.9, pattern: { type: 'bricks', size: 1.5, count: 6, bump: 1.2, seed: 4 } },
  { id: 'wood', color: [1, 1, 1], roughness: 0.55, pattern: { type: 'planks', size: 1.3, count: 5, bump: 0.8, seed: 3 } },
  { id: 'stone', color: [0.5, 0.55, 0.6], roughness: 1, pattern: { type: 'concrete', size: 2, bump: 0.5, seed: 9 } },
  { id: 'red', color: [0.8, 0.2, 0.15], roughness: 0.5 },
  { id: 'blue', color: [0.15, 0.4, 0.85], roughness: 0.3, metallic: 0.8 },
  { id: 'glow', color: [1, 0.7, 0.4], roughness: 0.7, emission: 4 },
  { id: 'glass', color: [1, 1, 1], roughness: 0.05, transmission: 0.9, ior: 1.45 },
  { id: 'lacquer', color: [0.7, 0.1, 0.1], roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.1 },
];

function shape(index) {
  return { id: `solid-${index}`, type: index % 2 ? 'box' : 'sphere', ...(index % 2 ? { bevel: 0 } : { segments: 16 + index, rings: 8 }) };
}

function recipeOf(geometries, nodes) {
  return {
    format: 'crucible.scene', schemaVersion: 1, geometries, materials: IDENTITY_MATERIALS, nodes,
    camera: { eye: [0, 0, 14], target: [0, 0, -2], fov: 50, near: 0.1, far: 60 },
  };
}

export function recipeFor(name) {
  if (name === 'room') return JSON.parse(readFileSync(new URL('../../tests/fixtures/demo-room.recipe.json', import.meta.url), 'utf8'));
  const place = (index, geometry, material, extra = {}) => ({ id: `n-${index}`, geometry, material, translation: [((index % 4) - 1.5) * 1.6, (Math.floor(index / 4) - 1) * 1.6, 0], scale: [0.5, 0.5, 0.5], ...extra });
  if (name === 'textured') {
    const materials = ['brick', 'wood', 'stone'];
    return recipeOf(Array.from({ length: 12 }, (_, index) => shape(index)), Array.from({ length: 12 }, (_, index) => place(index, `solid-${index}`, materials[index % 3])));
  }
  if (name === 'glass') {
    const materials = ['glass', 'lacquer', 'blue', 'glow'];
    return recipeOf(Array.from({ length: 12 }, (_, index) => shape(index)), Array.from({ length: 12 }, (_, index) => place(index, `solid-${index}`, materials[index % 4])));
  }
  if (name === 'shared') {
    const materials = ['red', 'blue', 'glow', 'stone'];
    return recipeOf([{ id: 'ball', type: 'sphere', segments: 16, rings: 8 }], Array.from({ length: 40 }, (_, index) => place(index, 'ball', materials[index % 4],
      { translation: [((index % 8) - 3.5) * 1.1, (Math.floor(index / 8) - 2) * 1.1, 0], scale: [0.4, 0.4, 0.4] })));
  }
  throw new RangeError(`Unknown identity scene "${name}". Pass one of: ${IDENTITY_SCENE_NAMES.join(', ')}.`);
}
