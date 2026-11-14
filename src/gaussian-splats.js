import { mat4 } from 'gl-matrix';
import { compileProgram } from './gl-program.js';
import { createSplatSorter } from './gaussian-splat-sort.js';
import { runInChunks } from './gaussian-splat-chunks.js';
import { GAUSSIAN_SPLAT_HARD_COUNT_LIMIT, GAUSSIAN_SPLAT_LIMITS, parseGaussianSplatPly, parseGaussianSplatPlyAsync } from './gaussian-splat-ply.js';

export { GAUSSIAN_SPLAT_HARD_COUNT_LIMIT, GAUSSIAN_SPLAT_LIMITS, parseGaussianSplatPly, parseGaussianSplatPlyAsync };

// Gaussian splats as an optional addon (crucible/addons/gaussian-splats). A splat is an ellipsoid with a colour and an opacity;
// each is drawn as a screen-space quad whose shape comes from projecting its 3D covariance. The splats are drawn after
// the opaque and translucent parts of the renderer, with the depth test against them and no depth write, back to front.
// The renderer needs no code for this: attachGaussianSplats wraps its drawBlendBatches step, which runs once per frame
// after those parts and before the frame is resolved to the canvas. Perspective cameras only.
// The per-splat data sits in one RGBA32UI texture, three texels per splat:
// - texel 0: centre x, y, z as float bits and the colour as four bytes;
// - texels 1 and 2: the six unique values of the 3D covariance (xx, xy, xz, yy, yz, zz) as float bits.
// The only per-frame upload is the sort order, one 32-bit index per visible splat.

const DATA_TEXTURE_WIDTH = 2048;
const TEXELS_PER_SPLAT = 3;
const WORDS_PER_TEXEL = 4;
const MAXIMUM_SPLAT_COUNT = GAUSSIAN_SPLAT_HARD_COUNT_LIMIT;
const DATA_TEXTURE_UNIT = 10;

const VERTEX_SOURCE = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D splatData;
uniform mat4 modelView;
uniform mat4 projection;
uniform vec2 focal;
uniform vec2 viewport;
layout(location = 0) in uint splatIndex;
out vec4 vertexColor;
out vec2 vertexOffset;
ivec2 texelOf(uint splat, uint texel) {
  uint linear = splat * 3u + texel;
  return ivec2(int(linear & 2047u), int(linear >> 11));
}
void main() {
  uvec4 first = texelFetch(splatData, texelOf(splatIndex, 0u), 0);
  uvec4 second = texelFetch(splatData, texelOf(splatIndex, 1u), 0);
  uvec4 third = texelFetch(splatData, texelOf(splatIndex, 2u), 0);
  vec3 center = uintBitsToFloat(first.xyz);
  vec4 cameraSpace = modelView * vec4(center, 1.0);
  vec4 clip = projection * cameraSpace;
  if (clip.z < -clip.w || abs(clip.x) > 1.3 * clip.w || abs(clip.y) > 1.3 * clip.w) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vec4 firstCovariance = uintBitsToFloat(second);
  vec2 secondCovariance = uintBitsToFloat(third.xy);
  mat3 covariance = mat3(
    firstCovariance.x, firstCovariance.y, firstCovariance.z,
    firstCovariance.y, firstCovariance.w, secondCovariance.x,
    firstCovariance.z, secondCovariance.x, secondCovariance.y);
  float depth = -cameraSpace.z;
  mat3 jacobian = mat3(
    focal.x / depth, 0.0, 0.0,
    0.0, focal.y / depth, 0.0,
    focal.x * cameraSpace.x / (depth * depth), focal.y * cameraSpace.y / (depth * depth), 0.0);
  mat3 transform = jacobian * mat3(modelView);
  mat3 screen = transform * covariance * transpose(transform);
  float a = screen[0][0] + 0.3;
  float b = screen[0][1];
  float c = screen[1][1] + 0.3;
  float middle = 0.5 * (a + c);
  float radius = length(vec2(0.5 * (a - c), b));
  float majorVariance = middle + radius;
  float minorVariance = max(middle - radius, 0.1);
  vec2 direction = vec2(b, majorVariance - a);
  direction = dot(direction, direction) < 1e-12 ? vec2(1.0, 0.0) : normalize(direction);
  vec2 majorAxis = min(sqrt(2.0 * majorVariance), 1024.0) * direction;
  vec2 minorAxis = min(sqrt(2.0 * minorVariance), 1024.0) * vec2(direction.y, -direction.x);
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 4.0 - 2.0;
  vec2 offset = (corner.x * majorAxis + corner.y * minorAxis) * 2.0 / viewport;
  vertexColor = vec4(float(first.w & 255u), float((first.w >> 8) & 255u), float((first.w >> 16) & 255u), float(first.w >> 24)) / 255.0;
  vertexOffset = corner;
  gl_Position = vec4(clip.xy / clip.w + offset, clip.z / clip.w, 1.0);
}`;

// A splat colour is display-referred, so the sRGB path takes it as is; the HDR path linearises it and applies exposure.
const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
uniform float hdrEnabled;
uniform float exposure;
in vec4 vertexColor;
in vec2 vertexOffset;
out vec4 outputColor;
void main() {
  float falloff = -dot(vertexOffset, vertexOffset);
  if (falloff < -4.0) discard;
  float alpha = exp(falloff) * vertexColor.a;
  if (alpha < 1.0 / 255.0) discard;
  vec3 color = hdrEnabled > 0.5 ? pow(vertexColor.rgb, vec3(2.2)) * exposure : vertexColor.rgb;
  outputColor = vec4(color * alpha, alpha);
}`;

const UNIFORM_NAMES = ['splatData', 'modelView', 'projection', 'focal', 'viewport', 'hdrEnabled', 'exposure'];

function covarianceOf(scales, rotations, index) {
  const [w, x, y, z] = rotations.subarray(index * 4, index * 4 + 4);
  const rotation = [
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y),
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x),
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y),
  ];
  // rotation is stored by columns; scaling the columns by the axis lengths gives M = R S.
  const scaled = rotation.map((value, entry) => value * scales[index * 3 + Math.floor(entry / 3)]);
  const product = (row, column) => scaled[row] * scaled[column] + scaled[3 + row] * scaled[3 + column] + scaled[6 + row] * scaled[6 + column];
  return [product(0, 0), product(0, 1), product(0, 2), product(1, 1), product(1, 2), product(2, 2)];
}

function createSplatPacker(data) {
  const texelCount = data.count * TEXELS_PER_SPLAT;
  const rows = Math.ceil(texelCount / DATA_TEXTURE_WIDTH);
  const words = new Uint32Array(rows * DATA_TEXTURE_WIDTH * WORDS_PER_TEXEL);
  const floats = new Float32Array(words.buffer);
  const colorWords = new Uint32Array(data.colors.buffer, data.colors.byteOffset, data.count);
  function packRange(start, end) {
    for (let index = start; index < end; index++) {
      const base = index * TEXELS_PER_SPLAT * WORDS_PER_TEXEL;
      floats.set(data.positions.subarray(index * 3, index * 3 + 3), base);
      words[base + 3] = colorWords[index];
      floats.set(covarianceOf(data.scales, data.rotations, index), base + 4);
    }
  }
  return { packRange, packed: { words, rows } };
}

function checkSplatInput(data, matrix, maximumCount, caller) {
  const limit = Math.min(maximumCount, MAXIMUM_SPLAT_COUNT);
  if (!(data?.count > 0)) throw new Error(`${caller} needs parsed splat data with at least one splat`);
  if (data.count > limit) throw new RangeError(`Gaussian splat scene holds ${data.count} splats, over the limit of ${limit}`);
  if (matrix.length !== 16 || !Array.from(matrix).every(Number.isFinite)) throw new TypeError('matrix must be 16 finite numbers');
}

function buildSplats(data, matrix, packed) {
  const sorter = createSplatSorter(data.positions, data.count, data.bounds);
  const statistics = { count: data.count, visibleCount: 0, sortMilliseconds: 0, gpuBytes: 0, cpuBytes: data.positions.byteLength + data.count * 8 };
  return { count: data.count, matrix: mat4.clone(matrix), bounds: data.bounds, statistics, packed, sorter };
}

/**
 * Splat data ready to draw, from `parseGaussianSplatPly`. `matrix` (a 16-number column-major array, default identity) places
 * the splat scene in the world; it may rotate, translate and scale uniformly. Many captures are y-down, so a flip is
 * usual. Throws a RangeError when `data.count` is over `maximumCount` (default 2,000,000, at most 4,000,000).
 * The returned object has `count`, `matrix`, `bounds` and `statistics` (`count`, `visibleCount`, `sortMilliseconds`,
 * `gpuBytes`, `cpuBytes`).
 */
export function createGaussianSplats(data, { matrix = mat4.create(), maximumCount = GAUSSIAN_SPLAT_LIMITS.maximumCount } = {}) {
  checkSplatInput(data, matrix, maximumCount, 'createGaussianSplats');
  const { packRange, packed } = createSplatPacker(data);
  packRange(0, data.count);
  return buildSplats(data, matrix, packed);
}

/**
 * The same result as `createGaussianSplats`, packed in slices of `chunkSize` splats (default 32,768) with a wait of one
 * macrotask between slices. `onProgress(fraction)` rises to exactly 1 and an aborted `signal` rejects with an error named
 * `AbortError`. Input checks run first and reject before any splat is packed.
 */
export async function createGaussianSplatsAsync(data, options = {}) {
  const { matrix = mat4.create(), maximumCount = GAUSSIAN_SPLAT_LIMITS.maximumCount } = options;
  checkSplatInput(data, matrix, maximumCount, 'createGaussianSplatsAsync');
  const { packRange, packed } = createSplatPacker(data);
  await runInChunks(data.count, options, 'createGaussianSplatsAsync', packRange);
  return buildSplats(data, matrix, packed);
}

function createGpuResources(context, splats) {
  const { words, rows } = splats.packed;
  const texture = context.createTexture();
  context.activeTexture(context.TEXTURE0 + DATA_TEXTURE_UNIT);
  context.bindTexture(context.TEXTURE_2D, texture);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
  context.texImage2D(context.TEXTURE_2D, 0, context.RGBA32UI, DATA_TEXTURE_WIDTH, rows, 0, context.RGBA_INTEGER, context.UNSIGNED_INT, words);
  const orderBuffer = context.createBuffer();
  context.bindBuffer(context.ARRAY_BUFFER, orderBuffer);
  context.bufferData(context.ARRAY_BUFFER, splats.count * 4, context.DYNAMIC_DRAW);
  const vertexArray = context.createVertexArray();
  context.bindVertexArray(vertexArray);
  context.enableVertexAttribArray(0);
  context.vertexAttribIPointer(0, 1, context.UNSIGNED_INT, 0, 0);
  context.vertexAttribDivisor(0, 1);
  context.bindVertexArray(null);
  splats.statistics.gpuBytes = words.byteLength + splats.count * 4;
  splats.packed = null;
  return { texture, orderBuffer, vertexArray };
}

const attachments = new WeakMap();

function createAttachment(renderer) {
  const context = renderer.context;
  const program = compileProgram(context, VERTEX_SOURCE, FRAGMENT_SOURCE);
  const uniforms = Object.fromEntries(UNIFORM_NAMES.map(name => [name, context.getUniformLocation(program, name)]));
  const attachment = { program, uniforms, entries: new Set(), modelView: mat4.create(), original: null, disposeOriginal: null };
  attachment.original = renderer.drawBlendBatches;
  attachment.disposeOriginal = renderer.dispose;
  renderer.drawBlendBatches = function drawBlendBatchesAndSplats(frame) {
    attachment.original.call(this, frame);
    drawEntries(this, attachment, frame);
  };
  renderer.dispose = function disposeWithSplats() {
    releaseAttachment(renderer, attachment);
    return attachment.disposeOriginal.call(this);
  };
  return attachment;
}

function releaseEntry(context, entry) {
  context.deleteTexture(entry.texture);
  context.deleteBuffer(entry.orderBuffer);
  context.deleteVertexArray(entry.vertexArray);
}

function releaseAttachment(renderer, attachment) {
  for (const entry of attachment.entries) releaseEntry(renderer.context, entry);
  attachment.entries.clear();
  renderer.context.deleteProgram(attachment.program);
  renderer.drawBlendBatches = attachment.original;
  renderer.dispose = attachment.disposeOriginal;
  attachments.delete(renderer);
}

function prepareState(renderer, attachment, frame) {
  const context = renderer.context;
  const width = renderer.canvas.width;
  const height = renderer.canvas.height;
  context.bindFramebuffer(context.FRAMEBUFFER, renderer.multisampleFramebuffer);
  context.viewport(0, 0, width, height);
  context.enable(context.DEPTH_TEST);
  context.depthMask(false);
  context.disable(context.CULL_FACE);
  context.enable(context.BLEND);
  context.blendFuncSeparate(context.ONE, context.ONE_MINUS_SRC_ALPHA, context.ONE, context.ONE_MINUS_SRC_ALPHA);
  context.useProgram(attachment.program);
  const { uniforms } = attachment;
  context.uniformMatrix4fv(uniforms.projection, false, renderer.rasterProjection ?? renderer.projection);
  context.uniform2f(uniforms.focal, renderer.projection[0] * width * 0.5, renderer.projection[5] * height * 0.5);
  context.uniform2f(uniforms.viewport, width, height);
  context.uniform1f(uniforms.hdrEnabled, renderer.hdr ? 1 : 0);
  context.uniform1f(uniforms.exposure, frame.exposure ?? 1);
  context.uniform1i(uniforms.splatData, DATA_TEXTURE_UNIT);
}

function restoreState(renderer) {
  const context = renderer.context;
  context.depthMask(true);
  context.disable(context.BLEND);
  context.enable(context.CULL_FACE);
  context.bindVertexArray(null);
  context.activeTexture(context.TEXTURE0);
}

function drawEntry(renderer, attachment, entry) {
  const context = renderer.context;
  const { splats } = entry;
  mat4.multiply(attachment.modelView, renderer.view, splats.matrix);
  const start = performance.now();
  const { order, visibleCount, changed } = splats.sorter.sort(attachment.modelView);
  if (changed) {
    context.bindBuffer(context.ARRAY_BUFFER, entry.orderBuffer);
    context.bufferSubData(context.ARRAY_BUFFER, 0, order, 0, visibleCount);
    splats.statistics.sortMilliseconds = performance.now() - start;
  }
  splats.statistics.visibleCount = visibleCount;
  if (visibleCount === 0) return;
  context.uniformMatrix4fv(attachment.uniforms.modelView, false, attachment.modelView);
  context.activeTexture(context.TEXTURE0 + DATA_TEXTURE_UNIT);
  context.bindTexture(context.TEXTURE_2D, entry.texture);
  context.bindVertexArray(entry.vertexArray);
  context.bindBuffer(context.ARRAY_BUFFER, entry.orderBuffer);
  context.drawArraysInstanced(context.TRIANGLE_STRIP, 0, 4, visibleCount);
}

function drawEntries(renderer, attachment, frame) {
  if (attachment.entries.size === 0) return;
  prepareState(renderer, attachment, frame);
  const farToNear = [...attachment.entries].map(entry => ({ entry, distance: distanceToEye(entry.splats, frame.eye) })).sort((first, second) => second.distance - first.distance);
  for (const { entry } of farToNear) drawEntry(renderer, attachment, entry);
  restoreState(renderer);
}

function distanceToEye(splats, eye) {
  const { minimum, maximum } = splats.bounds;
  const center = [0, 1, 2].map(axis => (minimum[axis] + maximum[axis]) / 2);
  const world = [splats.matrix[0] * center[0] + splats.matrix[4] * center[1] + splats.matrix[8] * center[2] + splats.matrix[12],
    splats.matrix[1] * center[0] + splats.matrix[5] * center[1] + splats.matrix[9] * center[2] + splats.matrix[13],
    splats.matrix[2] * center[0] + splats.matrix[6] * center[1] + splats.matrix[10] * center[2] + splats.matrix[14]];
  return Math.hypot(world[0] - eye[0], world[1] - eye[1], world[2] - eye[2]);
}

/**
 * Draws `splats` (from `createGaussianSplats`) with `renderer` on every normal frame, after its parts and with their
 * depth. Call it again for more splat scenes: they are drawn farthest first. Returns a function that removes this one
 * and frees its GPU memory; `renderer.dispose()` removes all of them. Not drawn in render passes, benchmark mode or
 * the water reflection image.
 */
export function attachGaussianSplats(renderer, splats) {
  if (!splats?.packed) throw new Error('These splats are already attached to a renderer; create them again to attach to another');
  if (typeof renderer?.drawBlendBatches !== 'function') throw new TypeError('attachGaussianSplats needs a CrucibleRenderer');
  const attachment = attachments.get(renderer) ?? createAttachment(renderer);
  attachments.set(renderer, attachment);
  const entry = { splats, ...createGpuResources(renderer.context, splats) };
  attachment.entries.add(entry);
  return function detachGaussianSplats() {
    if (!attachment.entries.delete(entry)) return;
    releaseEntry(renderer.context, entry);
    if (attachment.entries.size === 0 && attachments.get(renderer) === attachment) releaseAttachment(renderer, attachment);
  };
}
