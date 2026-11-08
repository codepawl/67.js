import { registerShaderFeatureCode, lightShapeSupport } from './shader-registry.js';
import { MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS } from './light-limits.js';
// The same values as in lighting.js, which this module does not import so the core bundle keeps its own chunk layout.
const NO_SHADOW_TILE = -1;
const SPOT_FACE = -1;
const SHADOW_ATLAS_TILES = 24;
import { PROFILE_SAMPLE_COUNT, resolveIesProfile, profileSamples } from './light-profile.js';

export { PROFILE_SAMPLE_COUNT, IES_PROFILE_NAMES, resolveIesProfile, profileSamples, profileGain } from './light-profile.js';

// Soft area light shadows and IES light profiles: the shader code, the file reader and the uniform upload. The profile math is in light-profile.js.
// The code loads on demand, so a scene with neither never carries it.
const PROFILE_LIGHT_COUNT = MAX_SPOT_LIGHTS + MAX_AREA_LIGHTS;
const ATLAS_NEAR = 0.05;
const ATLAS_FAR = 30;
/**
 * Reads the text of an IES file (LM-63) into { angles, candela }: the vertical angles, with the candela averaged over
 * the horizontal angles and times the file's multiplier. A file with TILT=INCLUDE is refused.
 */
export function parseIesPhotometry(text) {
  const tiltIndex = text.search(/^TILT=/im);
  if (tiltIndex < 0) throw new RangeError('The file has no TILT line, so it is not an IES file.');
  const afterTilt = text.slice(tiltIndex);
  const lineEnd = afterTilt.indexOf('\n');
  if (!/^TILT=NONE/i.test(afterTilt)) throw new RangeError('IES files with TILT=INCLUDE or TILT=filename are not supported.');
  const numbers = afterTilt.slice(lineEnd + 1).split(/[\s,]+/).filter(Boolean).map(Number);
  if (numbers.some(entry => !Number.isFinite(entry))) throw new RangeError('The IES file holds text where numbers belong.');
  const multiplier = numbers[2];
  const verticalCount = numbers[3];
  const horizontalCount = numbers[4];
  const header = 13;
  if (!(verticalCount >= 2) || !(horizontalCount >= 1) || numbers.length < header + verticalCount + horizontalCount + verticalCount * horizontalCount) {
    throw new RangeError('The IES file is shorter than its header says.');
  }
  const angles = numbers.slice(header, header + verticalCount);
  const candelaStart = header + verticalCount + horizontalCount;
  const candela = angles.map((angle, row) => {
    let sum = 0;
    for (let column = 0; column < horizontalCount; column++) sum += numbers[candelaStart + column * verticalCount + row];
    return (sum / horizontalCount) * multiplier;
  });
  return resolveIesProfile({ angles, candela }, 'IES file');
}

const SOFT_AREA_SHADOW = `
float areaShadowNoise() {
  return 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
}
vec2 areaShadowDisk(int index, int count, float rotation) {
  float angle = float(index) * 2.399963 + rotation;
  return sqrt((float(index) + 0.5) / float(count)) * vec2(cos(angle), sin(angle));
}
float areaShadowLinearDepth(float stored) {
  return 2.0 * ${ATLAS_NEAR.toFixed(2)} * ${ATLAS_FAR.toFixed(1)} / (${ATLAS_FAR.toFixed(1)} + ${ATLAS_NEAR.toFixed(2)} - (stored * 2.0 - 1.0) * (${ATLAS_FAR.toFixed(1)} - ${ATLAS_NEAR.toFixed(2)}));
}
float softLocalShadow(float tile, vec3 position, vec3 normal, float lightDistance, float lightHalfSize) {
  int tileIndex = int(tile);
  float texelAngle = localShadowTexelAngles[tileIndex];
  vec4 clip = localShadowMatrices[tileIndex] * vec4(position + normal * (lightDistance * texelAngle * 2.0), 1.0);
  if (clip.w <= 0.0) return 1.0;
  vec3 projected = clip.xyz / clip.w * 0.5 + 0.5;
  if (projected.z > 1.0 || any(lessThan(projected.xy, vec2(0.0))) || any(greaterThan(projected.xy, vec2(1.0)))) return 1.0;
  ivec2 tileOrigin = ivec2(tileIndex % 4, tileIndex / 4) * 512;
  vec2 pixel = projected.xy * 512.0;
  float receiverDepth = projected.z - 0.00002;
  float rotation = areaShadowNoise();
  float texelSize = texelAngle * clip.w;
  float searchTexels = clamp(lightHalfSize * 2.0 / texelSize, 2.0, 20.0);
  float blockerSum = 0.0;
  float blockers = 0.0;
  for (int tap = 0; tap < 16; tap++) {
    ivec2 texel = clamp(ivec2(floor(pixel + areaShadowDisk(tap, 16, rotation) * searchTexels)), ivec2(0), ivec2(511));
    float stored = texelFetch(localShadowAtlas, tileOrigin + texel, 0).r;
    if (stored < receiverDepth) {
      blockerSum += areaShadowLinearDepth(stored);
      blockers += 1.0;
    }
  }
  if (blockers == 0.0) return 1.0;
  float blockerDepth = blockerSum / blockers;
  float penumbraTexels = clamp(lightHalfSize * (clip.w - blockerDepth) / (blockerDepth * texelSize), 1.0, 24.0);
  float lit = 0.0;
  for (int tap = 0; tap < 32; tap++) {
    ivec2 texel = clamp(ivec2(floor(pixel + areaShadowDisk(tap, 32, rotation) * penumbraTexels)), ivec2(0), ivec2(511));
    lit += step(receiverDepth, texelFetch(localShadowAtlas, tileOrigin + texel, 0).r);
  }
  return lit / 32.0;
}
`;

const PROFILE_DECLARATIONS = `
uniform float lightProfileTable[${PROFILE_LIGHT_COUNT * PROFILE_SAMPLE_COUNT}];
float lightProfileGain(int light, vec3 fromLight, vec3 axis) {
  float cosine = dot(fromLight, axis);
  if (cosine <= 0.0) return 0.0;
  float position = acos(min(cosine, 1.0)) * ${((PROFILE_SAMPLE_COUNT - 1) / (Math.PI / 2)).toFixed(7)};
  int lower = int(floor(position));
  int upper = min(lower + 1, ${PROFILE_SAMPLE_COUNT - 1});
  return mix(lightProfileTable[light * ${PROFILE_SAMPLE_COUNT} + lower], lightProfileTable[light * ${PROFILE_SAMPLE_COUNT} + upper], fract(position));
}
`;

registerShaderFeatureCode('areaShadows', {
  declarations: SOFT_AREA_SHADOW,
  areaRadiance: '      if (USES_LOCAL_SHADOWS && areaLightPositions[index].w >= 0.0) lightRadiance *= shadowBlind > 0.5 ? 1.0 : softLocalShadow(areaLightPositions[index].w, worldPosition, normal, length(fromCenter), max(halfSize.x, halfSize.y));\n',
});

registerShaderFeatureCode('lightProfiles', {
  declarations: PROFILE_DECLARATIONS,
  linkSpot: '      attenuation *= lightProfileGain(index, -toLight, spotLightDirections[index].xyz);\n',
  areaRadiance: `      lightRadiance *= lightProfileGain(${MAX_SPOT_LIGHTS} + index, -toLight, lightNormal);\n`,
});

const profileTable = new Float32Array(PROFILE_LIGHT_COUNT * PROFILE_SAMPLE_COUNT);
const tableLocations = new WeakMap();

// Spot lights fill the first rows of the table and area lights the rows after them; a light with no profile has a row of ones.
function fillProfileTable(environment) {
  profileTable.fill(1);
  const rows = [...(environment.spotLights ?? []).map((light, index) => [index, light]), ...(environment.areaLights ?? []).map((light, index) => [MAX_SPOT_LIGHTS + index, light])];
  for (const [row, light] of rows) {
    if (light.ies !== undefined) profileTable.set(profileSamples(resolveIesProfile(light.ies, 'ies')), row * PROFILE_SAMPLE_COUNT);
  }
}

function uploadProfileTable(renderer) {
  const context = renderer.context;
  if (!tableLocations.has(renderer.program)) tableLocations.set(renderer.program, context.getUniformLocation(renderer.program, 'lightProfileTable[0]'));
  fillProfileTable(renderer.environment);
  context.uniform1fv(tableLocations.get(renderer.program), profileTable);
}

// Called by updateLightingState after the point, spot and area lights are written. A shadowed area light takes the
// atlas tile after the spot lights' tiles; its position's w holds the tile, and the widest tile view looks along its emitting side.
lightShapeSupport.update = (state, spotLights, areaLights) => {
  const features = [];
  areaLights.forEach((light, index) => {
    if (light.castShadow !== undefined && typeof light.castShadow !== 'boolean') throw new TypeError('Area light castShadow must be true or false');
    state.areaPositions[index * 4 + 3] = NO_SHADOW_TILE;
    if (!light.castShadow) return;
    if (state.shadowCasters.length >= SHADOW_ATLAS_TILES) throw new RangeError(`Shadow casting lights need more than the ${SHADOW_ATLAS_TILES} atlas tiles (a point light uses 6, a spot or area light one)`);
    state.areaPositions[index * 4 + 3] = state.shadowCasters.length;
    const direction = state.areaNormals.slice(index * 4, index * 4 + 3);
    state.shadowCasters.push({ light: { position: light.position, direction, range: 0, angle: Math.PI / 2 - 0.01 }, face: SPOT_FACE });
    if (!features.includes('areaShadows')) features.push('areaShadows');
  });
  if ([...spotLights, ...areaLights].some(light => light.ies !== undefined)) {
    features.push('lightProfiles');
    state.bind = uploadProfileTable;
  } else {
    state.bind = undefined;
  }
  state.extraFeatures = features;
};

function checkedShape(light, label) {
  if (light.castShadow !== undefined && typeof light.castShadow !== 'boolean') throw new TypeError(`${label} castShadow must be boolean.`);
  return light.ies === undefined ? undefined : resolveIesProfile(light.ies, `${label} ies`);
}

// Called by normalizeAgentLook: the sun angle, and the castShadow of area lights and the ies of spot and area lights, which the core light readers leave out.
lightShapeSupport.normalize = (input, environment) => {
  const radius = input.sunAngularRadius;
  if (radius !== undefined) {
    if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0.0005 || radius > 0.2) throw new RangeError('sunAngularRadius must be between 0.0005 and 0.2');
    environment.sunAngularRadius = radius;
  }
  for (const [field, label] of [['spotLights', 'spot light'], ['areaLights', 'area light']]) {
    (input[field] ?? []).forEach((light, index) => {
      const profile = checkedShape(light, label);
      if (profile !== undefined) environment[field][index].ies = profile;
      if (field === 'areaLights' && light.castShadow) environment[field][index].castShadow = true;
    });
  }
};
