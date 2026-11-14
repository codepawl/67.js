// The scene of the rough water picture (scripts/measure-water-roughness.mjs): a dark sea under the sky, with a boulder, a rock and a
// ladder standing in it. The models are Poly Haven CC0 assets read by water-preview-scene.js from a folder that is never committed.
import { CrucibleRenderer } from '../src/renderer.js';
import { box } from '../src/geometry.js';
import { applyWaterReflection, attachWaterReflection } from '../src/water-reflection.js';
import { previewParts } from './water-preview-scene.js';

const SEA_SIZE = 400;
const unitBox = box(0, 1);

function seaPart(roughness) {
  const matrix = new Float32Array([SEA_SIZE, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, SEA_SIZE, 0, 0, -0.05, 0, 1]);
  return { name: 'sea', geometry: unitBox, matrix, material: { tag: 'surface', color: [0.02, 0.05, 0.08], metallic: 0, roughness, emission: 0 } };
}

/** The standing models of the preview pool with a plain sea in place of its water sheet, which would hide the reflection. */
export function roughSeaParts(assets, roughness) {
  const standing = previewParts(assets, 0.3, {}, 1).slice(1, -1);
  return [...standing, seaPart(roughness)];
}

/** Draws one frame on `canvas` and returns what `applyWaterReflection` decided; the caller reads the canvas before the next frame. */
export function drawRoughSea(canvas, assets, roughness, view) {
  const marked = applyWaterReflection(roughSeaParts(assets, roughness));
  const renderer = new CrucibleRenderer(canvas, marked.parts, { hdr: true, depth: true, world: true, ground: false, pixelRatio: 1, samples: 4 });
  const detach = attachWaterReflection(renderer, marked.surface);
  renderer.render({ ...view, fov: 45, time: 0.5 });
  return { placed: marked.report.placed, dispose: () => { detach(); renderer.dispose?.(); } };
}
