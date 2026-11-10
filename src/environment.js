// Image-based lighting from equirectangular HDR maps.
// Convention: image row 0 is straight up, the image centre looks toward -Z, and
// `rotation` turns the environment about +Y in radians.

import { registerShaderFeatureCode } from './shader-registry.js';
import { equirectangularGlsl, environmentLookupGlsl, environmentShadingGlsl, registerEnvironmentSupport } from './environment-shading.js';

export const ENVIRONMENT_ROUGHNESS_LEVELS = 7;
export const ENVIRONMENT_BRDF_SIZE = 128;
export const MAXIMUM_ENVIRONMENT_SIZE = 16384;
const MAXIMUM_SPECULAR_WIDTH = 1024;
const HALF_FLOAT_MAXIMUM = 65504;
const PREFILTER_SAMPLES = 256;

function requireIntegerInRange(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Environment map ${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function requireNumberInRange(value, name, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`Environment map ${name} must be a finite number between ${minimum} and ${maximum}.`);
  }
}

export function createEnvironmentMap({ width, height, data, intensity = 1, rotation = 0, showBackground = false, backgroundBlur = 0 } = {}) {
  requireIntegerInRange(width, 'width', 4, MAXIMUM_ENVIRONMENT_SIZE);
  requireIntegerInRange(height, 'height', 2, MAXIMUM_ENVIRONMENT_SIZE);
  if (!(data instanceof Float32Array)) throw new TypeError('Environment map data must be a Float32Array of linear RGB or RGBA values.');
  const pixelCount = width * height;
  const channels = data.length === pixelCount * 3 ? 3 : data.length === pixelCount * 4 ? 4 : 0;
  if (!channels) throw new RangeError('Environment map data length must equal width * height * 3 or width * height * 4.');
  for (let index = 0; index < data.length; index++) {
    if (!Number.isFinite(data[index])) throw new RangeError('Environment map data must contain only finite values.');
  }
  requireNumberInRange(intensity, 'intensity', 0, 1000);
  requireNumberInRange(rotation, 'rotation', -1e6, 1e6);
  requireNumberInRange(backgroundBlur, 'backgroundBlur', 0, 1);
  if (typeof showBackground !== 'boolean') throw new TypeError('Environment map showBackground must be a boolean.');
  return Object.freeze({ kind: 'environment-map', width, height, channels, data, intensity, rotation, showBackground, backgroundBlur });
}

// The renderer accepts descriptors that were spread from a created map (to animate rotation), so it re-checks the shape without rescanning the data.
export function assertEnvironmentMap(map) {
  if (map?.kind !== 'environment-map' || !(map.data instanceof Float32Array)) {
    throw new TypeError('environment.map must be created with createEnvironmentMap.');
  }
  if (map.data.length !== map.width * map.height * map.channels) throw new RangeError('Environment map data length does not match its dimensions.');
  requireNumberInRange(map.intensity, 'intensity', 0, 1000);
  requireNumberInRange(map.rotation, 'rotation', -1e6, 1e6);
  requireNumberInRange(map.backgroundBlur, 'backgroundBlur', 0, 1);
}

export function environmentSpecularLayout(map) {
  const scale = Math.min(1, MAXIMUM_SPECULAR_WIDTH / map.width);
  const width = Math.max(4, Math.round(map.width * scale));
  const height = Math.max(2, Math.round(map.height * scale));
  const levelCount = Math.min(ENVIRONMENT_ROUGHNESS_LEVELS, Math.floor(Math.log2(Math.max(width, height))) + 1);
  const levels = [];
  let bytes = ENVIRONMENT_BRDF_SIZE * ENVIRONMENT_BRDF_SIZE * 4;
  for (let level = 0; level < levelCount; level++) {
    const levelWidth = Math.max(1, width >> level);
    const levelHeight = Math.max(1, height >> level);
    levels.push({ width: levelWidth, height: levelHeight });
    bytes += levelWidth * levelHeight * 8;
  }
  return { width, height, levelCount, levels, bytes };
}

// Persistent GPU bytes: the prefiltered half-float chain and the BRDF lookup. The source upload is freed once prefiltering ends.
export function estimateEnvironmentBytes(map, textureLimit = MAXIMUM_ENVIRONMENT_SIZE) {
  assertEnvironmentMap(map);
  if (map.width > textureLimit || map.height > textureLimit) {
    throw new RangeError(`Environment map ${map.width}x${map.height} exceeds the GPU texture limit of ${textureLimit}.`);
  }
  return environmentSpecularLayout(map).bytes;
}

const BASIS_SCALES = [0.282095, 0.488603, 0.488603, 0.488603, 1.092548, 1.092548, 0.315392, 1.092548, 0.546274];
// Lambert convolution factors A_l / pi for bands 0, 1 and 2.
const BAND_FACTORS = [1, 2 / 3, 2 / 3, 2 / 3, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4];

function sphericalHarmonicBasis(x, y, z) {
  return [1, y, z, x, x * y, y * z, 3 * z * z - 1, x * z, x * x - y * y];
}

// Returns 27 floats (9 RGB triples) with basis constants and the Lambert kernel folded in,
// so evaluateIrradiance(coefficients, normal) is the diffuse radiance for a white surface.
const IRRADIANCE_ROWS_PER_STEP = 32;

// One step per few rows of the map, so a caller can hand the thread back between steps.
function* irradianceSteps(map) {
  assertEnvironmentMap(map);
  const { width, height, channels, data } = map;
  const columnSine = new Float64Array(width);
  const columnCosine = new Float64Array(width);
  for (let column = 0; column < width; column++) {
    const azimuth = ((column + 0.5) / width - 0.5) * 2 * Math.PI;
    columnSine[column] = Math.sin(azimuth);
    columnCosine[column] = Math.cos(azimuth);
  }
  const sums = new Float64Array(27);
  const pixelSolidAngleScale = (2 * Math.PI / width) * (Math.PI / height);
  for (let row = 0; row < height; row++) {
    const polar = (row + 0.5) / height * Math.PI;
    const sinePolar = Math.sin(polar);
    const y = Math.cos(polar);
    const weight = sinePolar * pixelSolidAngleScale;
    for (let column = 0; column < width; column++) {
      const basis = sphericalHarmonicBasis(sinePolar * columnSine[column], y, -sinePolar * columnCosine[column]);
      const offset = (row * width + column) * channels;
      for (let term = 0; term < 9; term++) {
        const termWeight = basis[term] * weight;
        sums[term * 3] += data[offset] * termWeight;
        sums[term * 3 + 1] += data[offset + 1] * termWeight;
        sums[term * 3 + 2] += data[offset + 2] * termWeight;
      }
    }
    if (row % IRRADIANCE_ROWS_PER_STEP === IRRADIANCE_ROWS_PER_STEP - 1) yield;
  }
  const coefficients = new Float32Array(27);
  for (let term = 0; term < 9; term++) {
    // The constant applies once when projecting onto the basis and once when reconstructing.
    const scale = BASIS_SCALES[term] ** 2 * BAND_FACTORS[term];
    for (let channel = 0; channel < 3; channel++) coefficients[term * 3 + channel] = sums[term * 3 + channel] * scale;
  }
  return coefficients;
}

export function computeIrradianceCoefficients(map) {
  return runToEnd(irradianceSteps(map));
}

/** Runs a step generator to its end without pausing and returns its result. */
function runToEnd(steps) {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Awaits `checkpoint()` after every step of a generator and returns its result. */
export async function runInSlices(steps, checkpoint) {
  let step = steps.next();
  while (!step.done) {
    await checkpoint();
    step = steps.next();
  }
  return step.value;
}

export function evaluateIrradiance(coefficients, normal) {
  const [x, y, z] = normal;
  const basis = sphericalHarmonicBasis(x, y, z);
  const result = [0, 0, 0];
  for (let term = 0; term < 9; term++) {
    for (let channel = 0; channel < 3; channel++) result[channel] += coefficients[term * 3 + channel] * basis[term];
  }
  return result.map(value => Math.max(value, 0));
}

// Rows of the map as RGBA floats clamped to the half-float range, so a large map goes to the GPU a strip at a time.
const UPLOAD_ROWS_PER_STEP = 64;

function paddedHalfFloatRows(map, firstRow, rowCount) {
  const pixelCount = map.width * rowCount;
  const padded = new Float32Array(pixelCount * 4);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const source = (firstRow * map.width + pixel) * map.channels;
    const target = pixel * 4;
    padded[target] = Math.min(Math.max(map.data[source], 0), HALF_FLOAT_MAXIMUM);
    padded[target + 1] = Math.min(Math.max(map.data[source + 1], 0), HALF_FLOAT_MAXIMUM);
    padded[target + 2] = Math.min(Math.max(map.data[source + 2], 0), HALF_FLOAT_MAXIMUM);
    padded[target + 3] = 1;
  }
  return padded;
}


export const environmentPrefilterFragment = `#version 300 es
precision highp float;
in vec2 textureCoordinate;
uniform sampler2D sourceMap;
uniform vec2 sourceSize;
uniform float roughness;
uniform float sourceLevelOffset;
out vec4 outputColor;
const float PI = 3.14159265359;
const uint SAMPLE_COUNT = ${PREFILTER_SAMPLES}u;
${equirectangularGlsl}
float radicalInverse(uint bits) {
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return float(bits) * 2.3283064365386963e-10;
}
void main() {
  if (roughness < 0.001) {
    outputColor = vec4(min(textureLod(sourceMap, textureCoordinate, sourceLevelOffset).rgb, 65000.0), 1.0);
    return;
  }
  vec3 normal = directionFromEquirectangular(textureCoordinate);
  vec3 helper = abs(normal.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tangent = normalize(cross(helper, normal));
  vec3 bitangent = cross(normal, tangent);
  float alphaSquared = pow(roughness, 4.0);
  float texelSolidAngle = 4.0 * PI / (sourceSize.x * sourceSize.y);
  vec3 total = vec3(0.0);
  float totalWeight = 0.0;
  for (uint index = 0u; index < SAMPLE_COUNT; index++) {
    float firstRandom = float(index) / float(SAMPLE_COUNT);
    float secondRandom = radicalInverse(index);
    float cosineHalf = sqrt((1.0 - secondRandom) / (1.0 + (alphaSquared - 1.0) * secondRandom));
    float sineHalf = sqrt(max(1.0 - cosineHalf * cosineHalf, 0.0));
    float azimuth = 2.0 * PI * firstRandom;
    vec3 halfway = tangent * (sineHalf * cos(azimuth)) + bitangent * (sineHalf * sin(azimuth)) + normal * cosineHalf;
    vec3 light = reflect(-normal, halfway);
    float normalLight = dot(normal, light);
    if (normalLight <= 0.0) continue;
    float denominator = cosineHalf * cosineHalf * (alphaSquared - 1.0) + 1.0;
    float distribution = alphaSquared / (PI * denominator * denominator);
    // With N = V the half-vector density reduces to D / 4.
    float sampleSolidAngle = 1.0 / (float(SAMPLE_COUNT) * distribution * 0.25 + 0.0001);
    // Sampling a coarser source level for wide lobes keeps a bright sun from leaving fireflies.
    float sourceLevel = max(0.5 * log2(sampleSolidAngle / texelSolidAngle) + 1.0, 0.0);
    total += textureLod(sourceMap, equirectangularFromDirection(light), sourceLevel).rgb * normalLight;
    totalWeight += normalLight;
  }
  outputColor = vec4(min(total / max(totalWeight, 0.0001), 65000.0), 1.0);
}`;

export const environmentBrdfFragment = `#version 300 es
precision highp float;
in vec2 textureCoordinate;
out vec4 outputColor;
const float PI = 3.14159265359;
const uint SAMPLE_COUNT = 256u;
float radicalInverse(uint bits) {
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return float(bits) * 2.3283064365386963e-10;
}
void main() {
  float normalView = max(textureCoordinate.x, 0.001);
  float roughness = max(textureCoordinate.y, 0.02);
  float alpha = roughness * roughness;
  float alphaSquared = alpha * alpha;
  float visibilityBias = alpha * 0.5;
  vec3 view = vec3(sqrt(1.0 - normalView * normalView), 0.0, normalView);
  float scale = 0.0;
  float offset = 0.0;
  for (uint index = 0u; index < SAMPLE_COUNT; index++) {
    float firstRandom = float(index) / float(SAMPLE_COUNT);
    float secondRandom = radicalInverse(index);
    float cosineHalf = sqrt((1.0 - secondRandom) / (1.0 + (alphaSquared - 1.0) * secondRandom));
    float sineHalf = sqrt(max(1.0 - cosineHalf * cosineHalf, 0.0));
    float azimuth = 2.0 * PI * firstRandom;
    vec3 halfway = vec3(sineHalf * cos(azimuth), sineHalf * sin(azimuth), cosineHalf);
    vec3 light = 2.0 * dot(view, halfway) * halfway - view;
    float normalLight = max(light.z, 0.0);
    float normalHalf = max(halfway.z, 0.0);
    float viewHalf = max(dot(view, halfway), 0.0);
    if (normalLight <= 0.0) continue;
    float geometry = (normalLight / (normalLight * (1.0 - visibilityBias) + visibilityBias)) * (normalView / (normalView * (1.0 - visibilityBias) + visibilityBias));
    float visibility = geometry * viewHalf / max(normalHalf * normalView, 0.0001);
    float fresnelTerm = pow(1.0 - viewHalf, 5.0);
    scale += (1.0 - fresnelTerm) * visibility;
    offset += fresnelTerm * visibility;
  }
  outputColor = vec4(scale / float(SAMPLE_COUNT), offset / float(SAMPLE_COUNT), 0.0, 1.0);
}`;

// Shared lookup: rotation, intensity and the prefiltered chain, sampled by direction and roughness level.


export const environmentBackgroundFragment = `#version 300 es
precision highp float;
in vec2 textureCoordinate;
uniform mat4 inverseViewProjection;
uniform vec3 eye;
uniform float backgroundLevel;
uniform float exposure;
uniform float hdrEnabled;
out vec4 outputColor;
${environmentLookupGlsl}
vec3 toneMap(vec3 color) {
  return clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  vec4 world = inverseViewProjection * vec4(textureCoordinate * 2.0 - 1.0, 1.0, 1.0);
  vec3 direction = normalize(world.xyz / world.w - eye);
  vec3 radiance = environmentRadiance(direction, backgroundLevel);
  outputColor = vec4(hdrEnabled > 0.5 ? min(radiance * exposure, vec3(65504.0)) : pow(toneMap(radiance * exposure), vec3(1.0 / 2.2)), 1.0);
}`;

function createHalfFloatTexture(context, internalFormat, levelCount, width, height, { wrapHorizontally }) {
  const texture = context.createTexture();
  context.bindTexture(context.TEXTURE_2D, texture);
  context.texStorage2D(context.TEXTURE_2D, levelCount, internalFormat, width, height);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, levelCount > 1 ? context.LINEAR_MIPMAP_LINEAR : context.LINEAR);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, wrapHorizontally ? context.REPEAT : context.CLAMP_TO_EDGE);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
  return texture;
}

function drawIntoLevel(context, framebuffer, texture, level, width, height) {
  context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
  context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, level);
  if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('Environment prefilter framebuffer is incomplete.');
  context.viewport(0, 0, width, height);
  context.drawArrays(context.TRIANGLES, 0, 3);
}

// Prefilters once at load: GGX-convolved equirect mip chain (level = roughness), split-sum BRDF lookup and L2 spherical harmonics.
export function createEnvironmentResources(context, map, programs) {
  return runToEnd(environmentResourceSteps(context, map, programs));
}

/** The same resources, built a step at a time (upload, mipmaps, each roughness level, the lookup table, the irradiance) so a caller can draw frames between steps. */
export function createEnvironmentResourcesInSlices(context, map, programs, checkpoint) {
  return runInSlices(environmentResourceSteps(context, map, programs), checkpoint);
}

function* environmentResourceSteps(context, map, { compileProgram, fullscreenVertex }) {
  assertEnvironmentMap(map);
  if (!context.getExtension('EXT_color_buffer_float')) throw new Error('Environment maps require EXT_color_buffer_float.');
  const started = performance.now();
  const layout = environmentSpecularLayout(map);
  const sourceLevelCount = Math.floor(Math.log2(Math.max(map.width, map.height))) + 1;
  const sourceTexture = createHalfFloatTexture(context, context.RGBA16F, sourceLevelCount, map.width, map.height, { wrapHorizontally: true });
  for (let firstRow = 0; firstRow < map.height; firstRow += UPLOAD_ROWS_PER_STEP) {
    const rowCount = Math.min(UPLOAD_ROWS_PER_STEP, map.height - firstRow);
    context.texSubImage2D(context.TEXTURE_2D, 0, 0, firstRow, map.width, rowCount, context.RGBA, context.FLOAT, paddedHalfFloatRows(map, firstRow, rowCount));
    yield;
  }
  context.generateMipmap(context.TEXTURE_2D);
  yield;
  const specularTexture = createHalfFloatTexture(context, context.RGBA16F, layout.levelCount, layout.width, layout.height, { wrapHorizontally: true });
  const brdfTexture = createHalfFloatTexture(context, context.RG16F, 1, ENVIRONMENT_BRDF_SIZE, ENVIRONMENT_BRDF_SIZE, { wrapHorizontally: false });
  const framebuffer = context.createFramebuffer();
  const prefilterProgram = compileProgram(context, fullscreenVertex, environmentPrefilterFragment);
  const brdfProgram = compileProgram(context, fullscreenVertex, environmentBrdfFragment);
  context.disable(context.DEPTH_TEST);
  context.disable(context.CULL_FACE);
  context.disable(context.BLEND);
  context.disable(context.SCISSOR_TEST);
  context.bindVertexArray(null);
  context.useProgram(prefilterProgram);
  context.activeTexture(context.TEXTURE0);
  context.bindTexture(context.TEXTURE_2D, sourceTexture);
  context.uniform1i(context.getUniformLocation(prefilterProgram, 'sourceMap'), 0);
  context.uniform2f(context.getUniformLocation(prefilterProgram, 'sourceSize'), map.width, map.height);
  const roughnessUniform = context.getUniformLocation(prefilterProgram, 'roughness');
  const levelOffsetUniform = context.getUniformLocation(prefilterProgram, 'sourceLevelOffset');
  for (let level = 0; level < layout.levelCount; level++) {
    context.uniform1f(roughnessUniform, level / Math.max(1, layout.levelCount - 1));
    context.uniform1f(levelOffsetUniform, Math.max(0, Math.log2(map.width / layout.levels[level].width)));
    drawIntoLevel(context, framebuffer, specularTexture, level, layout.levels[level].width, layout.levels[level].height);
    yield;
  }
  context.useProgram(brdfProgram);
  drawIntoLevel(context, framebuffer, brdfTexture, 0, ENVIRONMENT_BRDF_SIZE, ENVIRONMENT_BRDF_SIZE);
  context.bindFramebuffer(context.FRAMEBUFFER, null);
  context.deleteFramebuffer(framebuffer);
  context.deleteProgram(prefilterProgram);
  context.deleteProgram(brdfProgram);
  context.deleteTexture(sourceTexture);
  context.finish();
  yield;
  const irradiance = yield* irradianceSteps(map.irradianceSource ?? map);
  return {
    data: map.data,
    irradianceSource: map.irradianceSource,
    specularTexture,
    brdfTexture,
    levelCount: layout.levelCount,
    bytes: layout.bytes,
    irradiance,
    prefilterMilliseconds: performance.now() - started,
    dispose() {
      context.deleteTexture(specularTexture);
      context.deleteTexture(brdfTexture);
    },
  };
}

export { environmentLookupGlsl, environmentShadingGlsl };

registerShaderFeatureCode('environmentMap', { environmentShading: environmentLookupGlsl + environmentShadingGlsl });

registerEnvironmentSupport({
  assertMap: assertEnvironmentMap,
  estimateBytes: estimateEnvironmentBytes,
  createResources: createEnvironmentResources,
  createResourcesInSlices: createEnvironmentResourcesInSlices,
  prefilterFragment: environmentPrefilterFragment,
  brdfFragment: environmentBrdfFragment,
  backgroundFragment: environmentBackgroundFragment,
});
