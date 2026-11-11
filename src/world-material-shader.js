import { layerTextureSupport, registerShaderFeatureCode } from './shader-registry.js';

// Water bodies. A material with the water tag can carry `absorption` (RGB per metre: how fast each colour fades going down) and
// `turbidity` (0 clear to 1 murky: how much light the water scatters into shadows). The largest flat water part of a scene sets
// the water level. Every surface below it is dimmed by Beer-Lambert absorption of the column above it, and its shadows are lifted
// by in-scatter and widened with depth times turbidity (worldVisibility below). Absorption folds the way down and the way back up
// into one coefficient, so a bed `depth` metres down keeps exp(-absorption * depth) of its light.
/** Water the way people name it: where the light goes and how far a shadow stays sharp. */
export const WATER_PRESETS = Object.freeze({
  lake: Object.freeze({ absorption: Object.freeze([0.35, 0.07, 0.04]), turbidity: 0.02 }),
  sea: Object.freeze({ absorption: Object.freeze([0.4, 0.06, 0.02]), turbidity: 0.1 }),
  river: Object.freeze({ absorption: Object.freeze([0.8, 0.9, 1.6]), turbidity: 0.75 }),
});
export const WATER_DEFAULT_PRESET = 'lake';
export const WATER_MAXIMUM_ABSORPTION = 20;
// A water part counts as one level when it is this flat: thickness against its wider side.
const WATER_MAXIMUM_THICKNESS_RATIO = 0.02;

/** Resolves a material's water fields: an explicit absorption or turbidity beats the preset, which beats the default lake. */
export function resolveWaterMaterial({ waterPreset, absorption, turbidity } = {}) {
  const preset = waterPreset ?? WATER_DEFAULT_PRESET;
  if (!Object.hasOwn(WATER_PRESETS, preset)) {
    throw new RangeError(`waterPreset must be one of ${Object.keys(WATER_PRESETS).join(', ')}.`);
  }
  const resolvedAbsorption = absorption ?? WATER_PRESETS[preset].absorption;
  const absorptionValid = Array.isArray(resolvedAbsorption) && resolvedAbsorption.length === 3
    && resolvedAbsorption.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= WATER_MAXIMUM_ABSORPTION);
  if (!absorptionValid) {
    throw new RangeError(`absorption must be three numbers from 0 to ${WATER_MAXIMUM_ABSORPTION} (per metre).`);
  }
  const resolvedTurbidity = turbidity ?? WATER_PRESETS[preset].turbidity;
  if (!Number.isFinite(resolvedTurbidity) || resolvedTurbidity < 0 || resolvedTurbidity > 1) {
    throw new RangeError('turbidity must be within zero and one.');
  }
  return { waterPreset: preset, absorption: [...resolvedAbsorption], turbidity: resolvedTurbidity };
}

/** Copies a recipe material's water fields: a water material always carries the resolved absorption, turbidity and preset. */
export function copyWaterFields(value, result, toVector) {
  const given = ['waterPreset', 'absorption', 'turbidity'].filter(field => value[field] !== undefined);
  if (result.tag !== 'water') {
    if (given.length > 0) {
      throw new RangeError(`${given.join(', ')} need the water tag.`);
    }
    return;
  }
  const absorption = value.absorption === undefined ? undefined : toVector(value.absorption, 3, 'absorption');
  Object.assign(result, resolveWaterMaterial({ ...value, absorption }));
}

function partBounds(part) {
  const { positions } = part.geometry;
  const { matrix } = part;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < positions.length; vertex += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * positions[vertex] + matrix[4 + axis] * positions[vertex + 1] + matrix[8 + axis] * positions[vertex + 2] + matrix[12 + axis];
      minimum[axis] = Math.min(minimum[axis], value);
      maximum[axis] = Math.max(maximum[axis], value);
    }
  }
  return { minimum, maximum };
}

const boundsCache = new WeakMap();

// A part's bounds are read again only when its matrix changed.
function cachedBounds(part) {
  const cached = boundsCache.get(part);
  if (cached && cached.matrix.every((value, index) => value === part.matrix[index])) {
    return cached.bounds;
  }
  const bounds = partBounds(part);
  boundsCache.set(part, { matrix: Float32Array.from(part.matrix), bounds });
  return bounds;
}

/**
 * The water body of a set of parts, or null: the largest flat part with the water tag sets the level (its top) and the optics.
 * A water mesh that is not flat (a stream following the terrain) has no single level, so it sets none.
 */
export function findWaterBody(parts) {
  let best = null;
  for (const part of parts) {
    if (part.material.tag !== 'water') {
      continue;
    }
    const { minimum, maximum } = cachedBounds(part);
    const wider = Math.max(maximum[0] - minimum[0], maximum[2] - minimum[2]);
    const footprint = (maximum[0] - minimum[0]) * (maximum[2] - minimum[2]);
    const flat = wider > 0 && maximum[1] - minimum[1] <= wider * WATER_MAXIMUM_THICKNESS_RATIO;
    if (flat && (!best || footprint > best.footprint)) {
      best = { footprint, level: maximum[1], material: part.material, refractive: part.material.alphaMode === 'blend' };
    }
  }
  if (!best) {
    return null;
  }
  const { absorption, turbidity } = resolveWaterMaterial(best.material);
  return { level: best.level, absorption, turbidity, refractive: best.refractive };
}

const waterLocations = new WeakMap();
// The texture unit that holds the opaque scene for refraction (the splat mask unit: a scene with water and a splat ground never
// draws both in one batch).
const WATER_SCENE_UNIT = 14;

// The opaque scene is resolved into the renderer's frame texture the first time a blended batch of the frame draws, as the liquid
// pass does, and the water samples it.
function resolveOpaqueScene(renderer, locations) {
  const context = renderer.context;
  const { width, height } = renderer.canvas;
  context.bindFramebuffer(context.READ_FRAMEBUFFER, renderer.multisampleFramebuffer);
  context.bindFramebuffer(context.DRAW_FRAMEBUFFER, renderer.resolveFramebuffer);
  context.blitFramebuffer(0, 0, width, height, 0, 0, width, height, context.COLOR_BUFFER_BIT, context.NEAREST);
  context.bindFramebuffer(context.FRAMEBUFFER, renderer.multisampleFramebuffer);
  context.activeTexture(context.TEXTURE0 + WATER_SCENE_UNIT);
  context.bindTexture(context.TEXTURE_2D, renderer.frameTexture);
  context.uniform1i(locations.scene, WATER_SCENE_UNIT);
}

function bindWaterBody(renderer) {
  if (!renderer.shaderFeatures?.has('water')) {
    return;
  }
  const context = renderer.context;
  let locations = waterLocations.get(renderer);
  if (locations?.program !== renderer.program) {
    locations = { program: renderer.program, body: context.getUniformLocation(renderer.program, 'waterBody'), absorption: context.getUniformLocation(renderer.program, 'waterAbsorption'), scene: context.getUniformLocation(renderer.program, 'waterScene'), resolved: false };
    waterLocations.set(renderer, locations);
  }
  const waterParts = renderer.batches.flatMap(batch => (batch.parts[0].material.tag === 'water' ? batch.parts : []));
  const body = findWaterBody(waterParts);
  // The mirror and the render passes skip the underwater look: the mirror is clipped above the water, a pass reads raw surface data.
  const active = Boolean(body) && !renderer.renderingPass && !renderer.mirrorCulling;
  // Refraction needs the frame texture, so it is off for a transparent canvas, whose alpha is the picture's own.
  const refracts = active && body.refractive && !renderer.transparent && !renderer.benchmark && Boolean(renderer.frameTexture);
  context.uniform4f(locations.body, active ? body.level : 0, active ? body.turbidity : 0, active ? 1 : 0, refracts ? 1 : 0);
  context.uniform3f(locations.absorption, ...(active ? body.absorption : [0, 0, 0]));
  if (!context.isEnabled(context.BLEND)) {
    locations.resolved = false;
  } else if (refracts && !locations.resolved) {
    resolveOpaqueScene(renderer, locations);
    locations.resolved = true;
  }
}

const previousBind = layerTextureSupport.bind;
layerTextureSupport.bind = (renderer, mapState, layerState, batch) => {
  previousBind?.(renderer, mapState, layerState, batch);
  bindWaterBody(renderer);
};

// Wind for the foliage (4) and grass (7) tags, shared by the colour and shadow vertex shaders so both
// move identically. It depends only on local position, the card's uv, world position and time.
// The slow sway grows with height and with distance from the model's vertical axis (branch tips swing
// more than the crown centre) but is capped, because bark never moves and leaves must stay near their twigs.
// uv.y is 1 at a leaf's base and 0 at its tip, which drives the faster flutter.

// The GLSL of the world materials: water, foliage, grass, terrain, moss, fire and smoke. A renderer with a part of one of those
// tags (or with moss) needs this module; any other renderer never carries it. shaders.js splices each block at its slot:
// worldFunctions (the noise and moss masks), worldSurface (the surface changes), worldLight (extra light), worldAfterEmission
// (water's reflection) and worldFinal (fire and smoke, which replace the lit colour). Other optional features can use the
// same slots, or stub them out in shaders.js, to leave their code out of renderers that do not draw them.
export const worldMaterialSlots = {
  // The water body (level, turbidity, 1 when a flat water part sets one) and its absorption per metre, sent by bindWaterBody.
  // Shadow of a surface under murky water: the classic shadow map read over a wider disc. A cascaded map is read through
  // its own macro and keeps its filter.
  declarations: `uniform vec4 waterBody;
uniform vec3 waterAbsorption;
uniform sampler2D waterScene;
uniform mat4 viewProjection;
// The frame texture holds the picture as it leaves the shader: scaled by exposure and, outside HDR, tone mapped and encoded.
vec3 waterDecode(vec3 encoded) {
  vec3 linear = encoded;
  if (hdrEnabled < 0.5) {
    vec3 curve = pow(encoded, vec3(2.2));
    vec3 quadratic = 2.51 - 2.43 * curve;
    vec3 slope = 0.03 - 0.59 * curve;
    linear = (-slope + sqrt(max(slope * slope + 4.0 * quadratic * 0.14 * curve, 0.0))) / (2.0 * quadratic);
  }
  return linear / max(exposure, 0.0001);
}
// Refraction (n = 1.33): the view ray bends at the surface and meets the bed at the depth the opaque pass left in the alpha
// channel of everything below the level. The picture around that point is blurred by turbidity times depth. Where nothing
// below the level is seen, the water keeps its own colour (fallback).
vec3 refractedBackground(vec3 fallback, vec3 surfacePosition, vec3 normal, vec3 viewDirection) {
  vec2 size = vec2(textureSize(waterScene, 0));
  vec3 bent = refract(-viewDirection, normal, 0.7519);
  vec2 uv = gl_FragCoord.xy / size;
  float depth = 0.0;
  for (int pass = 0; pass < 2; pass++) {
    float stored = textureLod(waterScene, uv, 0.0).a;
    depth = stored < 0.999 ? (stored - 0.5) / 0.498 * 8.0 : 0.0;
    vec4 clip = viewProjection * vec4(surfacePosition + bent * (depth / max(-bent.y, 0.1)), 1.0);
    uv = clip.xy / clip.w * 0.5 + 0.5;
  }
  float radius = min(waterBody.y * depth * 0.02 * size.y, 48.0);
  vec3 seenColor = vec3(0.0);
  float seen = 0.0;
  for (int tap = 0; tap < 16; tap++) {
    float angle = float(tap) * 2.39996;
    vec2 offset = vec2(cos(angle), sin(angle)) * sqrt((float(tap) + 0.5) / 16.0) * radius / size;
    vec2 position = uv + offset;
    vec4 sampled = textureLod(waterScene, position, 0.0);
    // A lookup that leaves the picture has nothing to show, so the water keeps its own colour there.
    float inside = all(greaterThan(position, vec2(0.0))) && all(lessThan(position, vec2(1.0))) ? 1.0 : 0.0;
    float below = sampled.a < 0.999 ? inside : 0.0;
    seenColor += waterDecode(sampled.rgb) * below;
    seen += below;
  }
  // Average only the taps that saw something below the water: a tap past the bed edge must not pull the blur toward the water colour.
  return seen > 0.5 ? seenColor / seen : fallback;
}
#ifndef shadowVisibility
float softShadowVisibility(vec3 normal, float radiusTexels) {
  vec3 projected = shadowPosition.xyz / shadowPosition.w * 0.5 + 0.5;
  if (projected.z > 1.0 || projected.z < 0.0 || any(lessThan(projected.xy, vec2(0.0))) || any(greaterThan(projected.xy, vec2(1.0)))) return 1.0;
  float cosine = max(dot(normal, normalize(lightDirection)), 0.05);
  float bias = shadowBiasPerSlope * clamp(sqrt(1.0 - cosine * cosine) / cosine, 0.25, 4.0);
  vec2 texel = 1.0 / vec2(textureSize(shadowMap, 0));
  float lit = 0.0;
  for (int tap = 0; tap < 12; tap++) {
    float angle = float(tap) * 2.39996;
    vec2 offset = vec2(cos(angle), sin(angle)) * sqrt((float(tap) + 0.5) / 12.0) * radiusTexels;
    lit += texture(shadowMap, vec3(projected.xy + offset * texel, projected.z - bias));
  }
  return lit / 12.0;
}
#endif
// Sunlight under water: in-scatter lifts the shadow (the water scatters light into it) and widens its edge, both with
// turbidity times the depth of the column above the surface.
float underwaterVisibility(float visibility, vec3 normal, float depth) {
  float scattering = waterBody.y * depth;
  float filtered = visibility;
#ifndef shadowVisibility
  if (scattering > 0.03) filtered = softShadowVisibility(normal, 1.5 + min(scattering * 6.0, 8.0));
#endif
  return filtered;
}
`,
  worldVisibility: `  float waterDepth = 0.0;
  vec3 waterTransmittance = vec3(1.0);
  vec3 waterSunTransmittance = vec3(1.0);
  float waterScatterShare = 0.0;
  float waterShadowVisibility = 1.0;
  if (TAG_WATER) {
    // Only the light that enters the water and comes back is shadowed, and most of what the eye sees comes from deeper than
    // the shadow reaches, so a shadow on the surface is faint. The reflection mixed in later never sees the shadow.
    visibility = mix(visibility, 1.0, 0.7 + 0.2 * waterBody.y);
  } else if (waterBody.z > 0.5 && worldPosition.y < waterBody.x) {
    waterDepth = waterBody.x - worldPosition.y;
    waterTransmittance = exp(-waterAbsorption * waterDepth);
    visibility = underwaterVisibility(visibility, normal, waterDepth);
    waterShadowVisibility = visibility;
    // The sun reaches the bed along the refracted ray, depth / cos(theta) with Snell n = 1.33, so its leg is absorbed over a longer path than the eye's.
    float sunSine = sqrt(max(1.0 - pow(normalize(lightDirection).y, 2.0), 0.0)) / 1.33;
    waterSunTransmittance = exp(-(waterAbsorption + 0.9 * waterBody.y * (1.0 - waterBody.y)) * waterDepth / sqrt(1.0 - sunSine * sunSine));
    waterScatterShare = waterBody.y * (1.0 - exp(-0.4 * waterBody.y * waterDepth));
  }
  vec3 keyColor = keyColor * waterSunTransmittance;
`,
  // Spliced into the colour and shadow vertex shaders by shaders.js.
  worldVertexWind: `
// Grass bends by how far up the blade a vertex is (uv.y is 1 at the root), so it ignores terrain height.
// Gusts roll across the field as a travelling wave along the wind direction, like the rolling bands in a meadow.
// windHeading turns the wind about the vertical axis, in radians; 0 is the default heading toward +x.
uniform float windHeading;

vec3 grassWind(vec3 worldPoint, vec2 leafUv, float seconds, float strength) {
  float tip = clamp(1.0 - leafUv.y, 0.0, 1.0);
  float bendWeight = tip * tip;
  float headingCos = cos(windHeading);
  float headingSin = sin(windHeading);
  vec2 windDirection = vec2(0.94 * headingCos - 0.34 * headingSin, 0.94 * headingSin + 0.34 * headingCos);
  float along = dot(worldPoint.xz, windDirection);
  float gust = 0.5 + 0.5 * sin(along * 0.32 - seconds * 1.7 + 2.0 * sin(worldPoint.x * 0.05 - worldPoint.z * 0.04 + seconds * 0.23));
  float push = (0.3 + 0.7 * gust * gust) * strength;
  float flutter = sin(seconds * 4.7 + worldPoint.x * 2.3 + worldPoint.z * 1.9) * strength;
  vec2 offset = windDirection * (push * 0.42 + flutter * 0.05) + vec2(-windDirection.y, windDirection.x) * flutter * 0.04;
  return vec3(offset.x, -push * 0.14, offset.y) * bendWeight;
}

vec3 windOffset(vec3 localPosition, vec3 worldPoint, vec2 leafUv, float surfaceTag, float seconds, float strength) {
  // Grass without UVs (uv is (-1, -1)) has no blade coordinate, so it keeps the height-based sway below.
  if (surfaceTag == 7.0 && leafUv.x > -0.5) return grassWind(worldPoint, leafUv, seconds, strength);
  if (surfaceTag != 4.0 && surfaceTag != 7.0) return vec3(0.0);
  float heightReach = min(max(localPosition.y + 0.5, 0.0), 2.5);
  float branchReach = 1.0 + 0.3 * min(length(localPosition.xz), 3.0);
  float sway = sin(seconds * 1.2 + worldPoint.z * 0.31 + worldPoint.x * 0.17) * strength * 0.10 * heightReach * branchReach;
  float tip = clamp(1.0 - leafUv.y, 0.0, 1.0);
  float flutter = sin(seconds * 3.1 + worldPoint.x * 1.7 + worldPoint.z * 1.3 + localPosition.y * 2.0) * strength * 0.08 * tip;
  vec2 heading = vec2(cos(windHeading), sin(windHeading));
  vec2 push = heading * (sway + flutter) + vec2(-heading.y, heading.x) * (flutter * 0.6);
  return vec3(push.x, 0.0, push.y);
}
`,
  worldFunctions: `float terrainHash(vec2 position) {
  vec3 seed = fract(vec3(position.xyx) * 0.1031);
  seed += dot(seed, seed.yzx + 33.33);
  return fract((seed.x + seed.y) * seed.z);
}

// Value noise and its analytic gradient avoid extra texture fetches for sand relief.
vec3 terrainNoise(vec2 position) {
  vec2 cell = floor(position);
  vec2 fraction = fract(position);
  vec2 blend = fraction * fraction * (3.0 - 2.0 * fraction);
  vec2 derivative = 6.0 * fraction * (1.0 - fraction);
  float lowerLeft = terrainHash(cell);
  float lowerRight = terrainHash(cell + vec2(1.0, 0.0));
  float upperLeft = terrainHash(cell + vec2(0.0, 1.0));
  float upperRight = terrainHash(cell + vec2(1.0, 1.0));
  float lower = mix(lowerLeft, lowerRight, blend.x);
  float upper = mix(upperLeft, upperRight, blend.x);
  return vec3(mix(lower, upper, blend.y),
    mix(lowerRight - lowerLeft, upperRight - upperLeft, blend.y) * derivative.x,
    (upper - lower) * derivative.y);
}

// Wind ripples the mesh is too coarse to carry: eight travelling waves from 3 m down to 0.15 m, about 0.15 rms slope in all, which
// is what breaks a sun glint into facets. The wavelengths step by an irrational ratio and the directions by the golden angle, and
// each wave's phase and strength drift with slow noise, so no pair of waves repeats the same blob pattern over the water. A wave
// stays whole while a pixel is under a fifth of its length and is gone at half (two pixels per wave, the limit of one sample per
// pixel), so far water does not shimmer but keeps every wave a pixel can still show; the slope variance the faded waves
// took with them comes back as lostVariance, to widen the glint instead.
vec2 waterDetailSlope(vec2 position, float footprint, out float lostVariance) {
  vec2 slope = vec2(0.0);
  lostVariance = 0.0;
  float wavenumber = 2.1;
  float angle = 0.4;
  for (int index = 0; index < 8; index++) {
    float visible = 1.0 - smoothstep(0.2, 0.5, footprint * wavenumber / 6.2831853);
    vec2 direction = vec2(cos(angle), sin(angle));
    float drift = terrainNoise(position * wavenumber * 0.09 + float(index) * 9.17).x - 0.5;
    float strength = 0.15 + 1.7 * terrainNoise(position * wavenumber * 0.06 + float(index) * 23.9 + 4.0).x;
    float phase = dot(position, direction) * wavenumber + time * sqrt(9.81 * wavenumber) + float(index) * 1.7 + drift * 5.0;
    float amplitude = 0.085 * pow(wavenumber / 2.1, -0.3) * strength;
    slope += direction * cos(phase) * amplitude * visible;
    lostVariance += 0.5 * amplitude * amplitude * (1.0 - visible);
    wavenumber *= 1.7320508;
    angle += 2.399963;
  }
  return slope;
}
`,
  worldMossFunction: `// Moss is its own material over the base, not a tint: fully rough, a soft sheen at grazing angles and light that wraps
// through it. Two masks, as in offline moss shading: a sharp one decides where moss is shaded, and a blurred one lifts
// it into cushions, so its relief never turns into needles. Coverage favours up-facing surfaces.
void mossMasks(vec3 normal, float amount, out float sharpMask, out float softMask) {
  float facing = smoothstep(0.1, 0.7, normal.y);
  vec2 position = worldPosition.xz * 6.0 + worldPosition.y * vec2(2.3, -1.7);
  float patches = terrainNoise(position).x * 0.6 + terrainNoise(position * 2.7 + 5.1).x * 0.4;
  float threshold = 1.0 - amount;
  sharpMask = facing * smoothstep(threshold - 0.035, threshold + 0.035, patches);
  softMask = facing * smoothstep(threshold - 0.22, threshold + 0.18, patches);
}

`,
  worldSurface: `  float waterFoam = 0.0;
  float waterLostVariance = 0.0;
  if (TAG_WATER) {
    // Small ripples tilt the surface's own normal, so a sea mesh keeps its waves; a flat sheet (normal up) gets the same ripples as before.
    vec3 rippleTilt = vec3(-cos(worldPosition.x * 1.4 + time * 0.8) * 0.035, 0.0, -cos(worldPosition.z * 1.8 - time) * 0.036);
    float radius = length(worldPosition.xz - waterRipple.xz);
    float age = time - rippleTime;
    float wave = sin(radius * 11.0 - age * 8.0) * exp(-abs(radius - age * 1.4) * 1.5) * exp(-age * 0.7) * step(0.0, age);
    rippleTilt.xz += normalize(worldPosition.xz - waterRipple.xz + 0.001) * wave * 0.07;
    float footprint = length(fwidth(worldPosition.xz));
    vec2 detailSlope = waterDetailSlope(worldPosition.xz, footprint, waterLostVariance);
    rippleTilt.xz += detailSlope;
    vec3 crestNormal = normal;
    normal = normalize(normal + rippleTilt);
    // The body is deeper at grazing angles; the foam mask (the ocean's, stored as 1 - foam in the sky visibility channel) turns it white.
    // Foam: the mask is the heavy half of the ocean's foam (about 5% of a rough sea). Three octaves of noise stretched along the crest
    // make lace: the core stays bright and solid, the edge dissolves into holes and thin veins, and it grows less opaque outwards.
    // The threshold has a soft band at least one pixel wide (fwidth), so the edge is smooth and does not follow the mesh triangles.
    vec2 crestAcross = normalize(crestNormal.xz + vec2(0.0001));
    vec2 crestAlong = vec2(-crestAcross.y, crestAcross.x);
    vec2 crestPosition = vec2(dot(worldPosition.xz, crestAlong), dot(worldPosition.xz, crestAcross));
    float broadLace = terrainNoise(crestPosition * vec2(0.45, 2.4)).x;
    float midLace = terrainNoise(crestPosition * vec2(1.3, 6.5) + 7.3).x;
    float fineLace = terrainNoise(crestPosition * vec2(3.1, 14.0) + 3.9).x;
    float lace = broadLace * 0.5 + midLace * 0.3 + fineLace * 0.2;
    float foamMask = clamp(2.0 * (1.0 - vertexSkyVisibility) - 1.0, 0.0, 1.0);
    float foamDensity = foamMask * 1.25 + (lace - 0.5) * 0.9;
    float foamBand = 0.13 + 1.5 * fwidth(foamDensity);
    float foamBody = smoothstep(0.5 - foamBand, 0.5 + foamBand, foamDensity) * smoothstep(0.03, 0.25, foamMask);
    float foamVeins = pow(1.0 - abs(2.0 * midLace - 1.0), 3.0) * smoothstep(0.45, 0.9, foamMask) * (1.0 - foamBody) * 0.32;
    waterFoam = max(foamBody * mix(0.5, 1.0, smoothstep(0.3, 0.95, foamMask)) * (0.78 + 0.22 * smoothstep(0.25, 0.75, fineLace * 0.6 + midLace * 0.4)), foamVeins);
    float grazing = pow(1.0 - max(dot(normal, viewDirection), 0.0), 4.0);
    color = mix(color, vec3(0.0137, 0.147, 0.195), grazing * 0.85);
    color = mix(color, vec3(0.92, 0.95, 0.97) * (0.68 + 0.32 * (fineLace * 0.5 + midLace * 0.5)), waterFoam);
    roughness = mix(0.16, 0.8, waterFoam);
  }
  if (CANOPY_TAG) {
    float leaves = sin(worldPosition.x * 13.0 + sin(worldPosition.y * 9.0)) * sin(worldPosition.z * 11.0 - worldPosition.y * 5.0);
    color *= 0.78 + leaves * 0.16;
    normal = normalize(normal + vec3(sin(worldPosition.z * 12.0), sin(worldPosition.x * 9.0), cos(worldPosition.y * 11.0)) * 0.06);
  }
  if (TAG_TERRAIN) {
    vec2 terrainPosition = worldPosition.xz + worldPosition.y * vec2(0.31, 0.43);
    float footprint = max(fwidth(terrainPosition.x), fwidth(terrainPosition.y));
    vec3 broad = terrainNoise(terrainPosition * 0.32);
    vec3 ridges = terrainNoise(terrainPosition * 3.2 + vec2(5.2, 11.7));
    vec3 grains = terrainNoise(terrainPosition * 32.0 + vec2(17.1, 4.3));
    float ridgeWeight = 1.0 - smoothstep(0.25, 0.8, footprint * 3.2);
    float grainWeight = 1.0 - smoothstep(0.2, 0.7, footprint * 32.0);
    float ridgeColor = 1.0 - abs(ridges.x * 2.0 - 1.0);
    color *= 0.82 + broad.x * 0.26 + (ridgeColor - 0.5) * 0.12 * ridgeWeight + (grains.x - 0.5) * 0.1 * grainWeight;
    vec2 relief = ridges.yz * 0.08 * ridgeWeight + grains.yz * 0.11 * grainWeight;
    vec3 perturbation = vec3(-relief.x, 0.0, -relief.y);
    normal = normalize(normal + perturbation - normal * dot(perturbation, normal));
    roughness = clamp(roughness + (grains.x - 0.5) * 0.06 * grainWeight, 0.075, 1.0);
  }
  if (USES_MOSS) {
    float mossSoft;
    mossMasks(normal, materialMoss.x, mossCover, mossSoft);
    float mossFootprint = length(fwidth(worldPosition));
    vec3 cushion = terrainNoise(worldPosition.xz * 40.0 + worldPosition.y * 13.0);
    float cushionDetail = 1.0 - smoothstep(0.004, 0.03, mossFootprint);
    vec3 cushionTilt = vec3(-cushion.y, 0.0, -cushion.z) * 0.07 * mossSoft * cushionDetail;
    normal = normalize(normal + cushionTilt - normal * dot(cushionTilt, normal));
    mossTone = materialMoss.yzw * (0.7 + 0.6 * cushion.x);
    color = mix(color, mossTone, mossCover);
    roughness = mix(roughness, 1.0, mossCover);
    metallic = mix(metallic, 0.0, mossCover);
  }
`,
  worldLight: `  if (CANOPY_TAG) radiance += color * max(dot(gl_FrontFacing ? -normal : normal, normalize(lightDirection)), 0.0) * 0.5 * keyResponse * mix(visibility, 1.0, 0.7);
  if (mossCover > 0.001) {
    float sheen = pow(1.0 - max(dot(normal, viewDirection), 0.0), 4.0);
    float wrap = max(dot(normal, normalize(lightDirection)) + 0.5, 0.0) / 1.5;
    radiance += mossTone * (sheen * 0.8 + wrap * 0.35) * keyResponse * visibility * mossCover;
  }
  if (TAG_GRASS) {
    // Sun through thin blades: they glow yellow-green when the camera looks toward the light, most at the thin tips
    // (uv.y runs 1 at the root to 0 at the tip; grass without UVs gets a middle value).
    float towardSun = pow(max(dot(-viewDirection, normalize(lightDirection)), 0.0), 3.0);
    float thinness = textureUV.x > -0.5 ? 1.0 - textureUV.y * 0.8 : 0.6;
    radiance += color * vec3(1.1, 1.25, 0.55) * towardSun * thinness * 1.4 * keyResponse * visibility;
  }
`,
  worldAfterEmission: `  if (waterDepth > 0.0) {
    // The bed's light reaches the eye through the column, dimmed; the water adds the daylight it scattered toward the eye (clear water a little, murky water more), so deep objects fade into the water colour instead of going black.
    vec3 scatteredLight = (keyColor * max(normalize(lightDirection).y, 0.0) * 0.1 + vec3(0.04) * ambientIntensity) * exp(-waterAbsorption * 1.5);
    radiance = radiance * waterTransmittance + scatteredLight * (vec3(1.0) - waterTransmittance) * (0.25 + waterBody.y);
    // Murky water scatters sunlight toward the eye from the column above the bed, and the post shadows that column too, so a shadow keeps a floor of contrast at depth (Cycles keeps about a quarter at 4 m in a river). It never subtracts: the lit side only gains.
    radiance += color * keyResponse / max(waterSunTransmittance, vec3(0.0001)) * max(dot(normal, normalize(lightDirection)), 0.0) * waterShadowVisibility * waterScatterShare * 3.4 * exp(-waterAbsorption);
  }
  if (TAG_WATER) {
    // Fresnel (Schlick, water F0 0.02) of the sky or environment the surface mirrors; foam is rough and reflects little.
    float cosine = max(dot(normal, viewDirection), 0.0);
    float reflectivity = (0.02 + 0.98 * pow(1.0 - cosine, 5.0)) * (1.0 - waterFoam);
    vec3 mirrorDirection = reflect(-viewDirection, normal);
    mirrorDirection.y = max(mirrorDirection.y, 0.02);
    vec3 skyColor = ENVIRONMENT_ENABLED ? surroundingsColor(mirrorDirection, 0.05) : mix(vec3(0.12, 0.24, 0.28), vec3(0.40, 0.63, 0.78), clamp(mirrorDirection.y, 0.0, 1.0)) * daylight;
    radiance = mix(radiance * 0.6 + color * ambientIntensity * daylight * 1.7, skyColor * ambientIntensity, clamp(reflectivity, 0.0, 1.0));
    // Sun glint: a narrow lobe around the mirror direction, the width of open water slopes, bright enough to bloom.
    vec3 halfVector = normalize(normalize(lightDirection) + viewDirection);
    float glintSharpness = 1.0 / (1.0 / 500.0 + 0.35 * waterLostVariance);
    float glintShape = pow(max(dot(normal, halfVector), 0.0), glintSharpness);
    float glintFresnel = 0.02 + 0.98 * pow(1.0 - max(dot(halfVector, viewDirection), 0.0), 5.0);
    radiance += vec3(1.0, 0.9, 0.7) * glintShape * (0.5 + 40.0 * glintFresnel) * 6.0 * keyResponse * (1.0 - waterFoam);
    radiance += vec3(0.85, 0.9, 0.95) * waterFoam * (max(dot(normal, normalize(lightDirection)), 0.0) * keyResponse + 0.35 * daylight * ambientIntensity);
    if (waterBody.w > 0.5 && alphaMode > 1.5) {
      // Blended water draws its own background: the opaque scene refracted and blurred, not the one behind it unbent.
      radiance = radiance * alpha + refractedBackground(radiance, worldPosition, normal, viewDirection) * (1.0 - alpha);
      alpha = 1.0;
    }
  }
`,
  worldFinal: `  if (waterDepth > 0.0 && waterBody.w > 0.5 && alphaMode < 0.5) alpha = 0.5 + 0.498 * clamp(waterDepth / 8.0, 0.0, 1.0);
  if (TAG_FIRE) {
    float turbulence = sin(worldPosition.x * 3.0 + time * 4.0) * sin(worldPosition.y * 4.2 - time * 3.0) * sin(worldPosition.z * 3.7);
    float heat = pow(clamp(0.55 + turbulence * 0.5 - explosionProgress * 0.12, 0.0, 1.0), 3.0);
    radiance = mix(vec3(0.22, 0.003, 0.0002), vec3(8.0, 2.8, 0.15), heat) * max(0.2, surface.z * 0.10);
  }
  if (TAG_SMOKE) {
    float turbulence = sin(worldPosition.x * 2.0 + time) * sin(worldPosition.y * 3.3 - time * 0.6);
    radiance = color * (0.22 + turbulence * 0.12) + vec3(0.35, 0.05, 0.005) * max(0.0, 1.0 - explosionProgress) * max(0.0, -normal.y);
  }
`,
};

registerShaderFeatureCode('worldMaterials', worldMaterialSlots);

/**
 * Turns the foliage and grass wind to `radians` about the vertical axis (0 is the default heading toward +x).
 * The renderer never sets windHeading, so the value stays on the main and shadow programs between frames; call this
 * before each render, because a rebuilt program starts at 0. A turned heading marks the shadow map stale.
 */
export function applyWindHeading(renderer, radians) {
  const context = renderer.context;
  for (const program of [renderer.program, renderer.depthProgram]) {
    const location = context.getUniformLocation(program, 'windHeading');
    if (!location) continue;
    context.useProgram(program);
    context.uniform1f(location, radians);
  }
  if (renderer.windHeading !== radians) renderer.shadowsDirty = true;
  renderer.windHeading = radians;
}
