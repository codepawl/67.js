// The depth prepass of the colour loop: opaque batches draw depth only first, then shade only the fragments that survive.
// It pays when many small triangles overlap, because the heavy colour shader then runs once per pixel instead of once per layer.

/**
 * `'auto'` turns the prepass on only for few, large triangles: at most this many opaque triangles per canvas pixel, and at least
 * PREPASS_MINIMUM_TRIANGLES of them. Measured on three scans (see docs/depth-prepass.md) the prepass lost at 0.2 to 1.8 triangles per
 * pixel, because those frames are bound by the count of sub-pixel triangles, which a depth pass cannot remove. The limit sits well below
 * the one point where it broke even (0.07), so it is a guess about where large triangles with overdraw start to win.
 */
export const PREPASS_MAXIMUM_TRIANGLES_PER_PIXEL = 0.03;

/** Below this many triangles the extra draw calls of the prepass cost the CPU more than the saved shading. */
export const PREPASS_MINIMUM_TRIANGLES = 100000;

const MODES = [true, false, 'auto'];

/** The fragment shader of the prepass program: no colour is wanted, only the depth the rasteriser writes. */
export const depthPrepassFragmentShader = `#version 300 es
precision highp float;
out vec4 outputColor;
void main() {
  outputColor = vec4(0.0);
}`;

/** Checks the `depthPrepass` option: true forces it on, false forces it off, 'auto' lets the triangle density decide. The default is false. */
export function validateDepthPrepassMode(mode) {
  if (!MODES.includes(mode)) throw new TypeError(`depthPrepass must be true, false or 'auto', got ${JSON.stringify(mode)}. Pass 'auto' to let the renderer decide.`);
  return mode;
}

/**
 * Whether this frame draws the prepass. `prepassTriangles` counts the triangles of the batches that can take part (opaque,
 * no cutout, no material snippet) and `pixels` is the size of the frame being drawn.
 */
export function shouldUseDepthPrepass(mode, prepassTriangles, pixels) {
  if (mode === true) return prepassTriangles > 0;
  if (mode === false || prepassTriangles === 0 || !(pixels > 0)) return false;
  return prepassTriangles >= PREPASS_MINIMUM_TRIANGLES && prepassTriangles <= pixels * PREPASS_MAXIMUM_TRIANGLES_PER_PIXEL;
}

/** Whether a batch may draw in the prepass: its colour pass must never discard or blend, so its depth is exactly what it shades. */
export function batchTakesDepthPrepass(batch) {
  if (batch.alphaMode !== 'opaque' || batch.splat || batch.parts[0].material.snippet) return false;
  // An impostor card and a fading batch (opacity above 1) discard dithered fragments in the colour shader.
  if (batch.parts[0].material.tag === 'impostor' || batch.opacity > 1) return false;
  return (batch.pass ?? 'opaque') === 'opaque';
}
