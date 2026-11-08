import { REPROJECTION_GLSL, uploadCameraPair } from './path-tracer-reprojection.js';
import { bindInput, createFloatTexture, createFramebuffer, createPass, drawFullscreen, FRAGMENT_HEADER } from './path-tracer-realtime-gl.js';

// The temporal denoiser of the real-time path tracer (issue #624), after SVGF (Schied et al. 2017). One noisy sample per
// pixel comes in at the tracing size (half the output) with its albedo, normal and distance; three steps follow:
//   1. accumulate: the light is divided by the albedo (so texture detail stays out of the filter), reprojected history is
//      blended in where depth and normal agree, and a variance comes from the history of the luminance (or, for a pixel
//      with a short history, from its 3 by 3 neighbours);
//   2. a few edge-stopping a-trous passes with steps 1, 2, 4, 8 (weights from distance to the plane, normal and the
//      luminance relative to the standard deviation);
//   3. present: the filtered light is upsampled to the output size with a joint bilinear filter that does not blend
//      across edges, multiplied by the albedo history (jittered camera rays average the edges' anti-aliasing there), tone
//      mapped (ACES, gamma 2.2, as `toneMapToRgba8`) and drawn to the canvas.
// Motion comes from the camera alone: the scene is static, and a moving part would ghost.

export const DEFAULT_HISTORY_LIMIT = 48;
export const DEFAULT_FILTER_ITERATIONS = 4;
const MINIMUM_ALBEDO = 0.02;
const SPATIAL_VARIANCE_HISTORY = 4;
const FIREFLY_DEVIATIONS = 2.5;
const SHORT_HISTORY_LENGTH = 8;

const LUMINANCE_GLSL = `
float luminanceOf(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}
float distanceOf(vec4 radianceAndDistance, float farDistance) {
  return radianceAndDistance.a > 0.0 ? radianceAndDistance.a : farDistance;
}
`;

const ACCUMULATE_FRAGMENT = `${FRAGMENT_HEADER}
${REPROJECTION_GLSL}
${LUMINANCE_GLSL}
uniform sampler2D uRadiance;
uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform sampler2D uPreviousRadiance;
uniform sampler2D uPreviousNormal;
uniform sampler2D uHistoryColor;
uniform sampler2D uHistoryMoments;
uniform sampler2D uHistoryAlbedo;
uniform ivec2 uTraceSize;
uniform bool uResetHistory;
uniform float uFarDistance;
uniform float uHistoryLimit;
const float FIREFLY_DEVIATIONS = ${FIREFLY_DEVIATIONS};
const float SHORT_HISTORY_LENGTH = ${SHORT_HISTORY_LENGTH}.0;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outMoments;
layout(location = 2) out vec4 outAlbedo;
layout(location = 3) out vec4 outFilter;

vec3 illuminationAt(ivec2 texel) {
  ivec2 clamped = clamp(texel, ivec2(0), uTraceSize - 1);
  return texelFetch(uRadiance, clamped, 0).rgb / max(texelFetch(uAlbedo, clamped, 0).rgb, vec3(${MINIMUM_ALBEDO}));
}

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  vec4 traced = texelFetch(uRadiance, texel, 0);
  vec3 albedo = texelFetch(uAlbedo, texel, 0).rgb;
  vec3 normal = texelFetch(uNormal, texel, 0).rgb;
  vec3 illumination = traced.rgb / max(albedo, vec3(${MINIMUM_ALBEDO}));
  vec2 size = vec2(uTraceSize);
  float distanceToEye = distanceOf(traced, uFarDistance);
  vec3 point = uEye + pixelRayDirection(vec2(texel) + 0.5, size) * distanceToEye;

  vec4 history = vec4(0.0);
  vec4 historyMoments = vec4(0.0);
  vec3 historyAlbedo = vec3(0.0);
  float totalWeight = 0.0;
  vec2 previousPosition;
  float previousDistance;
  if (!uResetHistory && projectToPrevious(point, size, previousPosition, previousDistance)) {
    vec2 base = floor(previousPosition - 0.5);
    vec2 fraction = previousPosition - 0.5 - base;
    for (int tap = 0; tap < 4; tap++) {
      ivec2 offset = ivec2(tap & 1, tap >> 1);
      ivec2 historyTexel = ivec2(base) + offset;
      if (any(lessThan(historyTexel, ivec2(0))) || any(greaterThanEqual(historyTexel, uTraceSize))) continue;
      float weight = (offset.x == 1 ? fraction.x : 1.0 - fraction.x) * (offset.y == 1 ? fraction.y : 1.0 - fraction.y);
      float historyDistance = distanceOf(texelFetch(uPreviousRadiance, historyTexel, 0), uFarDistance);
      if (!isHistoryConsistent(previousDistance, historyDistance, normal, texelFetch(uPreviousNormal, historyTexel, 0).rgb)) continue;
      history += weight * texelFetch(uHistoryColor, historyTexel, 0);
      historyMoments += weight * texelFetch(uHistoryMoments, historyTexel, 0);
      historyAlbedo += weight * texelFetch(uHistoryAlbedo, historyTexel, 0).rgb;
      totalWeight += weight;
    }
  }

  // While the history is short, a sample far above its eight neighbours is a firefly: bring it down to their mean plus a few
  // deviations. A long history averages the spikes in instead, which keeps the energy a clamp would cut.
  float neighbourSum = 0.0;
  float neighbourSumOfSquares = 0.0;
  for (int offsetY = -1; offsetY <= 1; offsetY++) {
    for (int offsetX = -1; offsetX <= 1; offsetX++) {
      if (offsetX == 0 && offsetY == 0) continue;
      float neighbour = luminanceOf(illuminationAt(texel + ivec2(offsetX, offsetY)));
      neighbourSum += neighbour;
      neighbourSumOfSquares += neighbour * neighbour;
    }
  }
  float neighbourMean = neighbourSum / 8.0;
  float neighbourDeviation = sqrt(max(0.0, neighbourSumOfSquares / 8.0 - neighbourMean * neighbourMean));
  float luminanceLimit = neighbourMean * 1.05 + FIREFLY_DEVIATIONS * neighbourDeviation + 0.01;
  float luminance = luminanceOf(illumination);
  bool shortHistory = totalWeight <= 1e-3 || history.a < SHORT_HISTORY_LENGTH;
  if (shortHistory && luminance > luminanceLimit) {
    illumination *= luminanceLimit / luminance;
    luminance = luminanceLimit;
  }
  vec2 currentMoments = vec2(luminance, luminance * luminance);
  vec3 color = illumination;
  vec3 blendedAlbedo = albedo;
  vec2 moments = currentMoments;
  float historyLength = 1.0;
  if (totalWeight > 1e-3) {
    history /= totalWeight;
    historyMoments /= totalWeight;
    historyAlbedo /= totalWeight;
    historyLength = min(history.a + 1.0, uHistoryLimit);
    float blend = 1.0 / historyLength;
    color = mix(history.rgb, illumination, blend);
    blendedAlbedo = mix(historyAlbedo, albedo, blend);
    moments = mix(historyMoments.xy, currentMoments, blend);
  }
  float variance = max(0.0, moments.y - moments.x * moments.x);
  if (historyLength < ${SPATIAL_VARIANCE_HISTORY}.0) {
    float sum = neighbourSum + luminance;
    float sumOfSquares = neighbourSumOfSquares + luminance * luminance;
    variance = max(0.0, sumOfSquares / 9.0 - (sum / 9.0) * (sum / 9.0));
  }
  outColor = vec4(color, historyLength);
  outMoments = vec4(moments, variance, 0.0);
  outAlbedo = vec4(blendedAlbedo, 1.0);
  outFilter = vec4(color, variance);
}`;

const ATROUS_FRAGMENT = `${FRAGMENT_HEADER}
${REPROJECTION_GLSL}
${LUMINANCE_GLSL}
uniform sampler2D uFilter;
uniform sampler2D uRadiance;
uniform sampler2D uNormal;
uniform ivec2 uTraceSize;
uniform int uStep;
uniform float uFarDistance;
out vec4 outFilter;

const float KERNEL[3] = float[3](0.375, 0.25, 0.0625);
const float PLANE_SIGMA = 0.02;
const float LUMINANCE_SIGMA = 4.0;
const float NORMAL_POWER = 64.0;

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  vec2 size = vec2(uTraceSize);
  vec4 center = texelFetch(uFilter, texel, 0);
  vec3 centerNormal = texelFetch(uNormal, texel, 0).rgb;
  float centerDistance = distanceOf(texelFetch(uRadiance, texel, 0), uFarDistance);
  vec3 centerPoint = pixelRayDirection(vec2(texel) + 0.5, size) * centerDistance;
  float centerLuminance = luminanceOf(center.rgb);
  float smoothedVariance = 0.0;
  for (int offsetY = -1; offsetY <= 1; offsetY++) {
    for (int offsetX = -1; offsetX <= 1; offsetX++) {
      ivec2 neighbour = clamp(texel + ivec2(offsetX, offsetY), ivec2(0), uTraceSize - 1);
      smoothedVariance += texelFetch(uFilter, neighbour, 0).a * (offsetX == 0 ? 0.5 : 0.25) * (offsetY == 0 ? 0.5 : 0.25);
    }
  }
  float luminanceScale = LUMINANCE_SIGMA * sqrt(max(smoothedVariance, 0.0)) + 1e-4;

  vec3 sumColor = vec3(0.0);
  float sumVariance = 0.0;
  float sumWeight = 0.0;
  for (int offsetY = -2; offsetY <= 2; offsetY++) {
    for (int offsetX = -2; offsetX <= 2; offsetX++) {
      ivec2 neighbour = texel + ivec2(offsetX, offsetY) * uStep;
      if (any(lessThan(neighbour, ivec2(0))) || any(greaterThanEqual(neighbour, uTraceSize))) continue;
      vec4 value = texelFetch(uFilter, neighbour, 0);
      float neighbourDistance = distanceOf(texelFetch(uRadiance, neighbour, 0), uFarDistance);
      vec3 neighbourPoint = pixelRayDirection(vec2(neighbour) + 0.5, size) * neighbourDistance;
      float planeDistance = abs(dot(centerNormal, neighbourPoint - centerPoint));
      float planeWeight = exp(-planeDistance / (PLANE_SIGMA * centerDistance));
      float normalWeight = pow(max(dot(centerNormal, texelFetch(uNormal, neighbour, 0).rgb), 0.0), NORMAL_POWER);
      float luminanceWeight = exp(-abs(luminanceOf(value.rgb) - centerLuminance) / luminanceScale);
      float weight = KERNEL[abs(offsetX)] * KERNEL[abs(offsetY)] * planeWeight * normalWeight * luminanceWeight;
      sumColor += weight * value.rgb;
      sumVariance += weight * weight * value.a;
      sumWeight += weight;
    }
  }
  outFilter = sumWeight > 1e-6 ? vec4(sumColor / sumWeight, sumVariance / (sumWeight * sumWeight)) : center;
}`;

const PRESENT_FRAGMENT = `${FRAGMENT_HEADER}
${LUMINANCE_GLSL}
uniform sampler2D uFilter;
uniform sampler2D uAlbedoHistory;
uniform sampler2D uRadiance;
uniform sampler2D uNormal;
uniform ivec2 uTraceSize;
uniform ivec2 uOutputSize;
uniform float uFarDistance;
out vec4 outColor;

vec3 toneMap(vec3 linear) {
  vec3 color = max(linear, vec3(0.0));
  vec3 mapped = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
  return pow(mapped, vec3(1.0 / 2.2));
}

void main() {
  vec2 outputPixel = vec2(gl_FragCoord.x, float(uOutputSize.y) - gl_FragCoord.y);
  vec2 position = outputPixel / vec2(uOutputSize) * vec2(uTraceSize);
  ivec2 nearest = clamp(ivec2(floor(position)), ivec2(0), uTraceSize - 1);
  float nearestDistance = distanceOf(texelFetch(uRadiance, nearest, 0), uFarDistance);
  vec3 nearestNormal = texelFetch(uNormal, nearest, 0).rgb;
  vec2 base = floor(position - 0.5);
  vec2 fraction = position - 0.5 - base;
  vec3 illumination = vec3(0.0);
  vec3 albedo = vec3(0.0);
  float totalWeight = 0.0;
  for (int tap = 0; tap < 4; tap++) {
    ivec2 offset = ivec2(tap & 1, tap >> 1);
    ivec2 texel = clamp(ivec2(base) + offset, ivec2(0), uTraceSize - 1);
    float weight = (offset.x == 1 ? fraction.x : 1.0 - fraction.x) * (offset.y == 1 ? fraction.y : 1.0 - fraction.y);
    float distanceDifference = abs(distanceOf(texelFetch(uRadiance, texel, 0), uFarDistance) - nearestDistance);
    weight *= exp(-distanceDifference / (0.02 * nearestDistance));
    weight *= pow(max(dot(nearestNormal, texelFetch(uNormal, texel, 0).rgb), 0.0), 16.0);
    illumination += weight * texelFetch(uFilter, texel, 0).rgb;
    albedo += weight * texelFetch(uAlbedoHistory, texel, 0).rgb;
    totalWeight += weight;
  }
  if (totalWeight < 1e-5) {
    illumination = texelFetch(uFilter, nearest, 0).rgb;
    albedo = texelFetch(uAlbedoHistory, nearest, 0).rgb;
    totalWeight = 1.0;
  }
  vec3 light = illumination / totalWeight;
  vec3 surface = albedo / totalWeight;
  outColor = vec4(toneMap(light * max(surface, vec3(${MINIMUM_ALBEDO}))), 1.0);
}`;

/**
 * Creates the denoiser for a tracing size and an output size. `run` takes the textures of the frame just traced and the
 * one before it and draws the result to the default framebuffer (the canvas).
 */
export function createTemporalDenoiser(gl, { traceWidth, traceHeight, outputWidth, outputHeight, historyLimit = DEFAULT_HISTORY_LIMIT, filterIterations = DEFAULT_FILTER_ITERATIONS }) {
  const accumulatePass = createPass(gl, ACCUMULATE_FRAGMENT);
  const atrousPass = createPass(gl, ATROUS_FRAGMENT);
  const presentPass = createPass(gl, PRESENT_FRAGMENT);
  const makePair = () => [createFloatTexture(gl, traceWidth, traceHeight), createFloatTexture(gl, traceWidth, traceHeight)];
  const colors = makePair();
  const moments = makePair();
  const albedos = makePair();
  const filters = makePair();
  const accumulateFramebuffers = [0, 1].map(index => createFramebuffer(gl, [
    { slot: 0, texture: colors[index] }, { slot: 1, texture: moments[index] }, { slot: 2, texture: albedos[index] }, { slot: 3, texture: filters[0] },
  ]));
  const filterFramebuffers = filters.map(texture => createFramebuffer(gl, [{ slot: 0, texture }]));
  let current = 0;

  const bindGuides = (pass, inputs) => {
    bindInput(gl, pass, 'uRadiance', 0, inputs.radiance);
    bindInput(gl, pass, 'uNormal', 1, inputs.normal);
    gl.uniform2i(pass.locate('uTraceSize'), traceWidth, traceHeight);
    gl.uniform1f(pass.locate('uFarDistance'), inputs.farDistance);
  };

  const accumulate = (inputs) => {
    const previous = 1 - current;
    gl.useProgram(accumulatePass.program);
    bindGuides(accumulatePass, inputs);
    bindInput(gl, accumulatePass, 'uAlbedo', 2, inputs.albedo);
    bindInput(gl, accumulatePass, 'uPreviousRadiance', 3, inputs.previousRadiance);
    bindInput(gl, accumulatePass, 'uPreviousNormal', 4, inputs.previousNormal);
    bindInput(gl, accumulatePass, 'uHistoryColor', 5, colors[previous]);
    bindInput(gl, accumulatePass, 'uHistoryMoments', 6, moments[previous]);
    bindInput(gl, accumulatePass, 'uHistoryAlbedo', 7, albedos[previous]);
    uploadCameraPair(gl, accumulatePass.locate, inputs.camera, inputs.previousCamera);
    gl.uniform1i(accumulatePass.locate('uResetHistory'), inputs.resetHistory ? 1 : 0);
    gl.uniform1f(accumulatePass.locate('uHistoryLimit'), historyLimit);
    drawFullscreen(gl, accumulateFramebuffers[current], traceWidth, traceHeight);
  };

  const filter = (inputs) => {
    gl.useProgram(atrousPass.program);
    bindGuides(atrousPass, inputs);
    uploadCameraPair(gl, atrousPass.locate, inputs.camera, inputs.previousCamera);
    let source = 0;
    for (let iteration = 0; iteration < filterIterations; iteration++) {
      bindInput(gl, atrousPass, 'uFilter', 2, filters[source]);
      gl.uniform1i(atrousPass.locate('uStep'), 1 << iteration);
      drawFullscreen(gl, filterFramebuffers[1 - source], traceWidth, traceHeight);
      source = 1 - source;
    }
    return filters[source];
  };

  const present = (inputs, filtered) => {
    gl.useProgram(presentPass.program);
    bindGuides(presentPass, inputs);
    bindInput(gl, presentPass, 'uFilter', 2, filtered);
    bindInput(gl, presentPass, 'uAlbedoHistory', 3, albedos[current]);
    gl.uniform2i(presentPass.locate('uOutputSize'), outputWidth, outputHeight);
    drawFullscreen(gl, null, outputWidth, outputHeight);
  };

  return {
    run(inputs) {
      accumulate(inputs);
      const filtered = filter(inputs);
      present(inputs, filtered);
      current = 1 - current;
    },
    dispose() {
      for (const texture of [...colors, ...moments, ...albedos, ...filters]) gl.deleteTexture(texture);
      for (const framebuffer of [...accumulateFramebuffers, ...filterFramebuffers]) gl.deleteFramebuffer(framebuffer);
      for (const pass of [accumulatePass, atrousPass, presentPass]) gl.deleteProgram(pass.program);
    },
  };
}
