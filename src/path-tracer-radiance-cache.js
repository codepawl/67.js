import { createFloatTexture, createFramebuffer, createPass, bindInput, drawFullscreen, FRAGMENT_HEADER } from './path-tracer-realtime-gl.js';

// A spatial hash radiance cache for the real-time path tracer (issue #624), in the manner of NVIDIA SHaRC. A cell is the
// quantized position (cells grow with the distance from the eye, so far surfaces share cells) and the quantized normal
// of a surface point. Each cell keeps the mean radiance that arrived at its points, as a running average over frames.
//   - a path ends at its last hit by reading the cell there (`cacheLookup`), so two bounces see the light of many;
//   - the path's second hit writes what the rest of the path brought back (`outCacheUpdate`), and a point pass adds those
//     records into the cells with additive blending, because WebGL2 has no atomics.
// Cells are not checked against collisions: two surfaces that hash alike share a cell (about 1 of 1000 at 100,000 cells).

export const CACHE_TEXTURE_SIZE = 1024;
export const CACHE_SLOT_COUNT = CACHE_TEXTURE_SIZE * CACHE_TEXTURE_SIZE;
export const CACHE_HISTORY_LIMIT = 128;
export const NORMAL_AXIS_THRESHOLD = 0.3;
export const MAXIMUM_LEVEL = 8;

const multiplyUnsigned = (first, second) => Math.imul(first, second) >>> 0;

function normalAxisCode(component) {
  if (component > NORMAL_AXIS_THRESHOLD) return 2;
  if (component < -NORMAL_AXIS_THRESHOLD) return 0;
  return 1;
}

/** The size level of the cells at `distance` from the eye: it doubles the cell size each time the distance doubles past `levelDistance`. */
export function cacheLevel(distance, levelDistance) {
  return Math.min(Math.max(Math.floor(Math.log2(Math.max(distance / levelDistance, 1))), 0), MAXIMUM_LEVEL);
}

/** The slot (0 to CACHE_SLOT_COUNT - 1) of the cell of a surface point. The shader function `cacheHash` computes the same value. */
export function cacheSlot({ point, normal, eye, cellSize, levelDistance }) {
  const level = cacheLevel(Math.hypot(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]), levelDistance);
  const levelCellSize = cellSize * 2 ** level;
  const cell = point.map(component => Math.floor(component / levelCellSize));
  const normalCode = normalAxisCode(normal[0]) + 3 * normalAxisCode(normal[1]) + 9 * normalAxisCode(normal[2]);
  let hash = (multiplyUnsigned(cell[0], 73856093) ^ multiplyUnsigned(cell[1], 19349663) ^ multiplyUnsigned(cell[2], 83492791)) >>> 0;
  hash = (hash ^ multiplyUnsigned(normalCode + 1, 0x9e3779b1)) >>> 0;
  hash = (hash ^ multiplyUnsigned(level, 0x85ebca6b)) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;
  hash = multiplyUnsigned(hash, 0x7feb352d);
  hash = (hash ^ (hash >>> 15)) >>> 0;
  hash = multiplyUnsigned(hash, 0x846ca68b);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return hash & (CACHE_SLOT_COUNT - 1);
}

/**
 * The running average a cell applies to the records that landed in it this frame: `count` records with mean radiance
 * `mean` meet a cell of `previousMean` over `previousCount` earlier records. The history counts at most CACHE_HISTORY_LIMIT.
 */
export function mergeCell({ previousMean, previousCount, mean, count }) {
  if (count < 1) return { mean: previousMean, count: previousCount };
  const weight = count / (Math.min(previousCount, CACHE_HISTORY_LIMIT) + count);
  return { mean: previousMean.map((value, channel) => value + (mean[channel] - value) * weight), count: previousCount + count };
}

// GLSL that the tracer kernel includes (path-tracer-gpu-shader.js) when the kernel is built with the cache.
export const CACHE_DECLARATIONS = `
uniform sampler2D uRadianceCache;
uniform float uCacheCellSize;
uniform float uCacheLevelDistance;
layout(location = 4) out vec4 outCacheUpdate;
const int CACHE_SHIFT = ${Math.log2(CACHE_TEXTURE_SIZE)};
const int CACHE_MASK = ${CACHE_TEXTURE_SIZE - 1};
const float NORMAL_AXIS_THRESHOLD = ${NORMAL_AXIS_THRESHOLD};
float recordedSlot = 0.0;
vec3 recordedRadianceBefore = vec3(0.0);
vec3 recordedThroughput = vec3(1.0);

uint normalAxisCode(float component) {
  if (component > NORMAL_AXIS_THRESHOLD) return 2u;
  if (component < -NORMAL_AXIS_THRESHOLD) return 0u;
  return 1u;
}

uint cacheHash(vec3 point, vec3 normal) {
  float level = clamp(floor(log2(max(length(point - uEye) / uCacheLevelDistance, 1.0))), 0.0, ${MAXIMUM_LEVEL}.0);
  ivec3 cell = ivec3(floor(point / (uCacheCellSize * exp2(level))));
  uint normalCode = normalAxisCode(normal.x) + 3u * normalAxisCode(normal.y) + 9u * normalAxisCode(normal.z);
  uint hash = uint(cell.x) * 73856093u ^ uint(cell.y) * 19349663u ^ uint(cell.z) * 83492791u;
  hash ^= (normalCode + 1u) * 0x9e3779b1u;
  hash ^= uint(level) * 0x85ebca6bu;
  hash ^= hash >> 16;
  hash *= 0x7feb352du;
  hash ^= hash >> 15;
  hash *= 0x846ca68bu;
  hash ^= hash >> 16;
  return hash & uint(${CACHE_SLOT_COUNT - 1});
}

// The mean radiance that arrives at the cell of a surface point; black while the cell has no record yet.
vec3 cacheLookup(vec3 point, vec3 normal) {
  int slot = int(cacheHash(point, normal));
  vec4 cell = texelFetch(uRadianceCache, ivec2(slot & CACHE_MASK, slot >> CACHE_SHIFT), 0);
  return cell.a >= 1.0 ? cell.rgb : vec3(0.0);
}
`;

// The last hit of a path adds the cell's radiance, times what the path carries and the surface colour (a diffuse reading).
export const CACHE_TERMINAL = `
    if (depth == uBounces && !inFog && !isGlass) {
      addRadiance(depth, throughput * hitColor * cacheLookup(hitPoint, normal));
      break;
    }`;

// The hit before it, if the surface scatters diffusely, remembers its cell, the light so far and the path's weight.
export const CACHE_RECORD = `
      if (depth == max(uBounces - 1, 0) && !isMirror) {
        recordedSlot = float(cacheHash(hitPoint, normal)) + 1.0;
        recordedRadianceBefore = radiance;
        recordedThroughput = throughput;
      }`;

// The record: the light the rest of the path brought, per unit of the weight at that hit (the incoming radiance).
export const CACHE_OUTPUT = `
  vec3 recordedTail = clamp((radiance - recordedRadianceBefore) / max(recordedThroughput, vec3(0.05)), vec3(0.0), vec3(uFireflyClamp));
  outCacheUpdate = recordedSlot > 0.0 ? vec4(recordedTail, recordedSlot) : vec4(0.0);`;

const SCATTER_VERTEX = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uRecords;
uniform ivec2 uRecordSize;
out vec3 vRadiance;
void main() {
  vec4 record = texelFetch(uRecords, ivec2(gl_VertexID % uRecordSize.x, gl_VertexID / uRecordSize.x), 0);
  gl_PointSize = 1.0;
  vRadiance = record.rgb;
  if (record.a < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  int slot = int(record.a) - 1;
  vec2 texel = vec2(float(slot & ${CACHE_TEXTURE_SIZE - 1}), float(slot >> ${Math.log2(CACHE_TEXTURE_SIZE)})) + 0.5;
  gl_Position = vec4(texel / ${CACHE_TEXTURE_SIZE}.0 * 2.0 - 1.0, 0.0, 1.0);
}`;

const SCATTER_FRAGMENT = `${FRAGMENT_HEADER}
in vec3 vRadiance;
out vec4 outSum;
void main() {
  outSum = vec4(vRadiance, 1.0);
}`;

const RESOLVE_FRAGMENT = `${FRAGMENT_HEADER}
uniform sampler2D uPreviousCache;
uniform sampler2D uSums;
out vec4 outCache;
void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  vec4 previous = texelFetch(uPreviousCache, texel, 0);
  vec4 sums = texelFetch(uSums, texel, 0);
  if (sums.a < 0.5) {
    outCache = previous;
    return;
  }
  float weight = sums.a / (min(previous.a, ${CACHE_HISTORY_LIMIT}.0) + sums.a);
  outCache = vec4(mix(previous.rgb, sums.rgb / sums.a, weight), previous.a + sums.a);
}`;

/**
 * The cache textures and the two passes that fold a frame's records in. `texture` is the current cache for the tracer's
 * `uRadianceCache`; `update(recordTexture, recordWidth, recordHeight)` adds the records the tracer wrote.
 */
export function createRadianceCache(gl) {
  const scatterPass = createPass(gl, SCATTER_FRAGMENT, SCATTER_VERTEX);
  const resolvePass = createPass(gl, RESOLVE_FRAGMENT);
  const caches = [createFloatTexture(gl, CACHE_TEXTURE_SIZE, CACHE_TEXTURE_SIZE), createFloatTexture(gl, CACHE_TEXTURE_SIZE, CACHE_TEXTURE_SIZE)];
  const sums = createFloatTexture(gl, CACHE_TEXTURE_SIZE, CACHE_TEXTURE_SIZE);
  const cacheFramebuffers = caches.map(texture => createFramebuffer(gl, [{ slot: 0, texture }]));
  const sumsFramebuffer = createFramebuffer(gl, [{ slot: 0, texture: sums }]);
  let current = 0;

  const clear = () => {
    for (const framebuffer of [...cacheFramebuffers, sumsFramebuffer]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    }
  };
  clear();

  return {
    get texture() { return caches[current]; },
    clear,
    update(recordTexture, recordWidth, recordHeight) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, sumsFramebuffer);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
      gl.viewport(0, 0, CACHE_TEXTURE_SIZE, CACHE_TEXTURE_SIZE);
      gl.useProgram(scatterPass.program);
      bindInput(gl, scatterPass, 'uRecords', 0, recordTexture);
      gl.uniform2i(scatterPass.locate('uRecordSize'), recordWidth, recordHeight);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.POINTS, 0, recordWidth * recordHeight);
      gl.disable(gl.BLEND);
      const next = 1 - current;
      gl.useProgram(resolvePass.program);
      bindInput(gl, resolvePass, 'uPreviousCache', 0, caches[current]);
      bindInput(gl, resolvePass, 'uSums', 1, sums);
      drawFullscreen(gl, cacheFramebuffers[next], CACHE_TEXTURE_SIZE, CACHE_TEXTURE_SIZE);
      current = next;
    },
    dispose() {
      for (const texture of [...caches, sums]) gl.deleteTexture(texture);
      for (const framebuffer of [...cacheFramebuffers, sumsFramebuffer]) gl.deleteFramebuffer(framebuffer);
      gl.deleteProgram(scatterPass.program);
      gl.deleteProgram(resolvePass.program);
    },
  };
}
