// The water shadow test scene, shared by scripts/measure-water-shadows.mjs and the preview. It runs in the browser page:
// a post stands in a pool, its shadow falls on the bed, and the camera looks straight down (or along the water for the reflection).
import { CrucibleRenderer } from '../src/renderer.js';
import { box } from '../src/geometry.js';
import '../src/world-material-shader.js';

const SUN_DIRECTION = [-0.6, 1, 0];
const POST_TOP = 1.5;
const POOL_SIZE = 12;
const unitBox = box(0, 1);

function placed(name, center, size, material, castShadow) {
  const matrix = new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1]);
  return { name, geometry: unitBox, matrix, material, ...(castShadow === undefined ? {} : { castShadow }) };
}

const SURFACE = { tag: 'surface', color: [0.3, 0.3, 0.3], metallic: 0, roughness: 0.9, emission: 0 };

/** The parts of a pool `depth` metres deep. `water` is the water material fields; `visible` makes the sheet opaque. */
export function poolParts(depth, water, { visible = false } = {}) {
  const sheet = { tag: 'water', color: [0.02, 0.05, 0.08], metallic: 0, roughness: 0.1, emission: 0, ...water, ...(visible ? {} : { opacity: 0.001, alphaMode: 'blend' }) };
  return [
    placed('bed', [0, -depth - 0.5, 0], [POOL_SIZE, 1, POOL_SIZE], SURFACE),
    placed('post', [0, (POST_TOP - depth) / 2, 0], [0.5, POST_TOP + depth, 0.5], { ...SURFACE, color: [0.6, 0.4, 0.3] }),
    placed('water', [0, -0.05, 0], [POOL_SIZE, 0.1, POOL_SIZE], sheet, false),
  ];
}

function drawFrame(canvas, parts, { eye, target, up = [0, 1, 0], fov = 30, hdr = false }) {
  const renderer = new CrucibleRenderer(canvas, parts, { hdr, depth: false, world: false, ground: false, pixelRatio: 1, samples: 1, environment: { lightDirection: SUN_DIRECTION, keyColor: [3, 3, 3] } });
  renderer.render({ eye, target, up, fov, time: 0, environment: { lightDirection: SUN_DIRECTION } });
  return renderer;
}

function inverseToneMap(value) {
  let low = 0;
  let high = 40;
  const acesCurve = color => Math.min(Math.max((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0), 1);
  for (let step = 0; step < 40; step++) {
    const middle = (low + high) / 2;
    if (acesCurve(middle) < value) low = middle; else high = middle;
  }
  return (low + high) / 2;
}

function readLinear(renderer, canvas, worldPoint) {
  const matrix = renderer.viewProjection;
  const clip = [0, 1, 2, 3].map(row => matrix[row] * worldPoint[0] + matrix[4 + row] * worldPoint[1] + matrix[8 + row] * worldPoint[2] + matrix[12 + row]);
  const pixelX = Math.round((clip[0] / clip[3] * 0.5 + 0.5) * canvas.width);
  const pixelY = Math.round((clip[1] / clip[3] * 0.5 + 0.5) * canvas.height);
  const context = renderer.context;
  const bytes = new Uint8Array(4);
  context.readPixels(pixelX, pixelY, 1, 1, context.RGBA, context.UNSIGNED_BYTE, bytes);
  return [0, 1, 2].map(channel => inverseToneMap(Math.pow(bytes[channel] / 255, 2.2)));
}

const OVERHEAD = { eye: [0, 12, 0], target: [0, 0, 0], up: [0, 0, -1] };
const SHADOW_OFFSET = 0.65;
const LIT_OFFSET = -1.4;

/** Linear RGB of the lit and the shadowed bed at the bottom of a pool, seen from above. `water` null draws the pool dry. */
export function measureBed(canvas, depth, water, shadowOffset = SHADOW_OFFSET, view = OVERHEAD) {
  const parts = water ? poolParts(depth, water) : poolParts(depth, { tag: 'surface' }).filter(part => part.name !== 'water');
  const renderer = drawFrame(canvas, parts, view);
  const lit = readLinear(renderer, canvas, [LIT_OFFSET, -depth, 0]);
  renderer.render({ ...view, fov: 30, time: 0, environment: { lightDirection: SUN_DIRECTION } });
  const shadowed = readLinear(renderer, canvas, [shadowOffset, -depth, 0]);
  renderer.dispose?.();
  return { lit, shadowed };
}

const GRAZING = { eye: [4, 0.8, 6], target: [0, -0.05, 0.5] };
const STEEP = { eye: [1.5, 9, 3], target: [0, -0.05, 0.5] };

/** Linear RGB of one point of an opaque water surface, with the post (shadowed) and without it (lit), from a grazing and a steep view. */
export function measureSurface(canvas, water) {
  const result = {};
  for (const [label, view] of [['grazing', GRAZING], ['steep', STEEP]]) {
    const read = parts => {
      const renderer = drawFrame(canvas, parts, { ...view, fov: 30 });
      const color = readLinear(renderer, canvas, [SHADOW_OFFSET, -0.05, 0]);
      renderer.dispose?.();
      return color;
    };
    const parts = poolParts(1, water, { visible: true });
    result[label] = { lit: read(parts.filter(part => part.name !== 'post')), shadowed: read(parts) };
  }
  return result;
}

/** One frame of the pool for a picture; the caller reads the canvas before the next frame. `visible` draws the water sheet opaque. */
export function drawPool(canvas, depth, water, view = { eye: [-5, 5, 6], target: [0.5, -depth, 0] }, visible = false) {
  const renderer = drawFrame(canvas, poolParts(depth, water, { visible }), { ...view, fov: 40 });
  return renderer;
}
