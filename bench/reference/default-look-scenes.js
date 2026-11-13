// Four bare scenes for the default look bench (issue #988): geometry, a camera, one sun and a constant sky, and nothing else.
// No recipe lighting setup, no bake, no probes, no post steps. 67js, three.js and Cycles all get exactly these numbers.
import { box, cylinder, sphere } from '/src/geometry.js';
import { constantLighting, environment, part, SUN_COLOR } from './scenes.js';
import { SKY_RADIANCE } from './default-look-variants.js';

export const SUN_DIRECTION = [-3, 6, 4];
const SHARP_BOX = box(0, 1);
const SMOOTH_SPHERE = sphere(64, 40);
const SMOOTH_CYLINDER = cylinder(64, 0, 1);

function sunShadowAround(target, extent) {
  const distance = 18;
  const length = Math.hypot(...SUN_DIRECTION);
  return {
    eye: target.map((value, axis) => value + (SUN_DIRECTION[axis] / length) * distance),
    target, up: [0, 1, 0], extent, near: 1, far: distance * 2,
  };
}

function ground() {
  return part('floor', SHARP_BOX, [0, -0.05, 0], [40, 0.1, 40], { color: [0.55, 0.55, 0.55], roughness: 0.85 });
}

function bareScene(parts, camera, shadowTarget, shadowExtent) {
  const lighting = constantLighting(SKY_RADIANCE);
  return {
    parts,
    blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: SUN_COLOR, lightDirection: SUN_DIRECTION }),
    camera: { up: [0, 1, 0], near: 0.1, far: 100, ...camera },
    shadow: sunShadowAround(shadowTarget, shadowExtent),
  };
}

function shapesScene() {
  const parts = [
    ground(),
    part('block', SHARP_BOX, [-1.4, 0.5, 0], [1, 1, 1], { color: [0.75, 0.25, 0.2], roughness: 0.7 }),
    part('ball', SMOOTH_SPHERE, [0.2, 0.7, 0.5], [0.7, 0.7, 0.7], { color: [0.2, 0.45, 0.75], roughness: 0.4 }),
    part('drum', SMOOTH_CYLINDER, [1.7, 0.6, -0.4], [0.5, 1.2, 0.5], { color: [0.85, 0.7, 0.25], roughness: 0.55 }),
  ];
  return bareScene(parts, { eye: [0.5, 2.6, 6.2], target: [0.2, 0.55, 0], fov: 35 }, [0, 0.5, 0], 6);
}

// Two walls and a floor meet in a corner with boxes pushed into it: the places where ambient occlusion shows.
function cornerScene() {
  const wallColor = { color: [0.8, 0.78, 0.72], roughness: 0.9 };
  const crateColor = { color: [0.55, 0.38, 0.22], roughness: 0.75 };
  const parts = [
    ground(),
    part('back-wall', SHARP_BOX, [0, 1.5, -2.05], [6, 3, 0.1], wallColor),
    part('side-wall', SHARP_BOX, [-3.05, 1.5, 0], [0.1, 3, 4.2], wallColor),
    part('crate-large', SHARP_BOX, [-2.2, 0.5, -1.2], [1.2, 1, 1.2], crateColor),
    part('crate-small', SHARP_BOX, [-0.9, 0.3, -1.4], [0.6, 0.6, 0.6], crateColor),
    part('crate-top', SHARP_BOX, [-2.1, 1.25, -1.1], [0.6, 0.5, 0.6], { color: [0.3, 0.5, 0.35], roughness: 0.75 }),
    part('stone', SMOOTH_SPHERE, [0.6, 0.35, -0.9], [0.35, 0.35, 0.35], { color: [0.6, 0.6, 0.65], roughness: 0.8 }),
  ];
  return bareScene(parts, { eye: [2.4, 2.1, 4.4], target: [-1.3, 0.9, -1], fov: 40 }, [-1, 0.8, -1], 5);
}

function materialRowScene() {
  const parts = [ground()];
  for (const [column, roughness] of [0.15, 0.4, 0.65, 0.9].entries()) {
    const x = (column - 1.5) * 1.3;
    parts.push(part(`plastic-${column}`, SMOOTH_SPHERE, [x, 0.5, 0.7], [0.5, 0.5, 0.5], { color: [0.8, 0.2, 0.15], roughness }));
    parts.push(part(`metal-${column}`, SMOOTH_SPHERE, [x, 0.5, -0.7], [0.5, 0.5, 0.5], { color: [0.9, 0.75, 0.4], roughness, metallic: 1 }));
  }
  return bareScene(parts, { eye: [0, 2.8, 5.6], target: [0, 0.45, 0], fov: 35 }, [0, 0.4, 0], 5);
}

// Columns in a row under a lintel, with the sun throwing their shadows across the floor.
function colonnadeScene() {
  const stone = { color: [0.72, 0.68, 0.6], roughness: 0.85 };
  const parts = [ground(), part('step', SHARP_BOX, [0, 0.1, 0], [8, 0.2, 3], stone)];
  for (let index = 0; index < 5; index++) {
    parts.push(part(`column-${index}`, SMOOTH_CYLINDER, [(index - 2) * 1.6, 1.6, 0], [0.3, 2.8, 0.3], stone));
  }
  parts.push(part('lintel', SHARP_BOX, [0, 3.2, 0], [7, 0.4, 1], stone));
  parts.push(part('urn', SMOOTH_SPHERE, [0.8, 0.55, 2.2], [0.35, 0.35, 0.35], { color: [0.3, 0.45, 0.6], roughness: 0.3 }));
  return bareScene(parts, { eye: [3.5, 2.2, 8], target: [0, 1.6, 0], fov: 38 }, [0, 1, 0], 7);
}

export const DEFAULT_LOOK_SCENES = {
  shapes: async () => shapesScene(),
  corner: async () => cornerScene(),
  'material-row': async () => materialRowScene(),
  colonnade: async () => colonnadeScene(),
};
