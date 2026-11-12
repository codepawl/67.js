import { createStage, sharedFragmentHeader } from './camera-effects.js';
import { numberInRange, groupOf, onlyKeys, triple } from './post-fields.js';
import { invalidField } from './field-error.js';

// Two named post steps that agents place in the scene and time: `distortion` bends the picture behind it (a shock ring that
// expands, or heat haze in a box or an ellipsoid) and `flash` lifts light around a point for a moment. Both read the depth
// buffer, run on the HDR frame before glare and bloom, and take their time from the scene clock (or from their own `time`
// field for a still), so a seek repeats the same pixels. Every list and number is bounded.

export const MAXIMUM_AIR_SOURCES = 4;
const MAXIMUM_SCENE_TIME = 3600;
const MAXIMUM_COORDINATE = 100000;
// The largest picture shift at full strength, as a fraction of the image height.
const RING_MAXIMUM_SHIFT = 0.1;
const HAZE_MAXIMUM_SHIFT = 0.04;
const MAXIMUM_NODE_ID_LENGTH = 128;

const PLACEMENT_FIELDS = ['centre', 'node', 'time'];
const RING_FIELDS = ['startTime', 'speed', 'thickness', 'strength', 'falloff', 'maxRadius'];
const HAZE_FIELDS = ['region', 'size', 'noiseScale', 'scroll', 'strength'];
const FLASH_FIELDS = ['startTime', 'attack', 'decay', 'intensity', 'color', 'radius'];
const HAZE_REGIONS = ['box', 'sphere'];

function sourceList(value, step) {
  const sources = Array.isArray(value) ? value : [value];
  if (sources.length > MAXIMUM_AIR_SOURCES) {
    throw new RangeError(`${step} takes at most ${MAXIMUM_AIR_SOURCES} sources, got ${sources.length}. Fix: keep the ${MAXIMUM_AIR_SOURCES} that matter, or split the shot.`);
  }
  return sources;
}

function resolvePlacement(group, name) {
  if (group.node !== undefined && (typeof group.node !== 'string' || group.node.length === 0 || group.node.length > MAXIMUM_NODE_ID_LENGTH)) {
    throw new TypeError(`${name}.node must be the ID of a node in the recipe, such as "bomb". Fix: pass a node ID, or centre as three numbers.`);
  }
  return {
    centre: triple(group.centre, [0, 0, 0], -MAXIMUM_COORDINATE, MAXIMUM_COORDINATE, `${name}.centre`),
    ...(group.node === undefined ? {} : { node: group.node }),
    time: numberInRange(group.time, 0, 0, MAXIMUM_SCENE_TIME, `${name}.time`),
  };
}

function resolveRing(group, name) {
  onlyKeys(group, ['shape', ...PLACEMENT_FIELDS, ...RING_FIELDS], name);
  return {
    shape: 'ring',
    ...resolvePlacement(group, name),
    startTime: numberInRange(group.startTime, 0, 0, MAXIMUM_SCENE_TIME, `${name}.startTime`),
    speed: numberInRange(group.speed, 40, 0, 10000, `${name}.speed`),
    thickness: numberInRange(group.thickness, 1.5, 0.01, 1000, `${name}.thickness`),
    strength: numberInRange(group.strength, 0.5, 0, 1, `${name}.strength`),
    falloff: numberInRange(group.falloff, 0.4, 0, 20, `${name}.falloff`),
    maxRadius: numberInRange(group.maxRadius, 200, 0.01, MAXIMUM_COORDINATE, `${name}.maxRadius`),
  };
}

function resolveHaze(group, name) {
  onlyKeys(group, ['shape', ...PLACEMENT_FIELDS, ...HAZE_FIELDS], name);
  const region = group.region ?? 'box';
  if (!HAZE_REGIONS.includes(region)) throw new TypeError(`${name}.region must be one of ${HAZE_REGIONS.join(', ')}. Fix: pass "box" or "sphere".`);
  return {
    shape: 'haze',
    ...resolvePlacement(group, name),
    region,
    size: triple(group.size, [2, 2, 2], 0.01, 1000, `${name}.size`),
    noiseScale: numberInRange(group.noiseScale, 1.5, 0.01, 100, `${name}.noiseScale`),
    scroll: numberInRange(group.scroll, 1, 0, 100, `${name}.scroll`),
    strength: numberInRange(group.strength, 0.3, 0, 1, `${name}.strength`),
  };
}

function resolveDistortionSource(input, index) {
  const name = `distortion[${index}]`;
  const group = groupOf(input, name);
  if (group.shape !== 'ring' && group.shape !== 'haze') {
    throw new TypeError(`${name}.shape must be "ring" or "haze". Fix: "ring" is an expanding shock ring, "haze" is heat shimmer in a box or sphere.`);
  }
  const wrongFields = (group.shape === 'ring' ? HAZE_FIELDS : RING_FIELDS).filter(field => group[field] !== undefined && !(group.shape === 'ring' ? RING_FIELDS : HAZE_FIELDS).includes(field));
  if (wrongFields.length > 0) {
    throw new TypeError(`${name}.${wrongFields[0]} does not apply to shape "${group.shape}". Fix: ${group.shape === 'ring' ? 'a ring takes ' + RING_FIELDS.join(', ') : 'a haze takes ' + HAZE_FIELDS.join(', ')}.`);
  }
  return group.shape === 'ring' ? resolveRing(group, name) : resolveHaze(group, name);
}

/** The `distortion` step: one source or a list of up to four, each resolved with its defaults. */
export function resolveDistortion(input) {
  return sourceList(input, 'distortion').map(resolveDistortionSource);
}

function resolveFlashSource(input, index) {
  const name = `flash[${index}]`;
  const group = groupOf(input, name);
  onlyKeys(group, [...PLACEMENT_FIELDS, ...FLASH_FIELDS], name);
  return {
    ...resolvePlacement(group, name),
    startTime: numberInRange(group.startTime, 0, 0, MAXIMUM_SCENE_TIME, `${name}.startTime`),
    attack: numberInRange(group.attack, 0.05, 0, 60, `${name}.attack`),
    decay: numberInRange(group.decay, 0.4, 0.01, 60, `${name}.decay`),
    intensity: numberInRange(group.intensity, 4, 0, 1000, `${name}.intensity`),
    color: triple(group.color, [1, 0.85, 0.6], 0, 1, `${name}.color`),
    radius: numberInRange(group.radius, 50, 0.01, MAXIMUM_COORDINATE, `${name}.radius`),
  };
}

/** The `flash` step: one source or a list of up to four, each resolved with its defaults. */
export function resolveFlash(input) {
  return sourceList(input, 'flash').map(resolveFlashSource);
}

/** Gives each source the scene clock time, and the world position of the node it follows. */
export function placeAirSteps(effects, sceneTime, parts) {
  for (const source of [...effects.distortion ?? [], ...effects.flash ?? []]) {
    if (sceneTime !== null && sceneTime !== undefined) source.time = sceneTime;
    const part = source.node === undefined ? null : parts.find(candidate => candidate.name === source.node);
    if (part) source.centre = [part.matrix[12], part.matrix[13], part.matrix[14]];
  }
  return effects;
}

/** Refuses a source that follows a node the recipe does not have, naming the nodes it has. */
export function checkAirStepNodes(recipe) {
  const nodeIds = recipe.nodes.map(node => node.id);
  for (const step of ['distortion', 'flash']) {
    for (const source of recipe.effects?.[step] ?? []) {
      if (source.node !== undefined && !nodeIds.includes(source.node)) {
        throw invalidField(`effects.${step}.node`, source.node, `one of the nodes of this recipe: ${nodeIds.join(', ') || 'none yet'}; or pass centre as three numbers`);
      }
    }
  }
}

/** The ring at this source's time, or null before it starts and once it passes `maxRadius`. */
export function ringState(source) {
  const age = source.time - source.startTime;
  if (age < 0) return null;
  const radius = source.speed * age;
  if (radius > source.maxRadius) return null;
  return { radius, amplitude: source.strength * Math.exp(-source.falloff * age) };
}

/** Flash brightness at this source's time: rises over `attack` seconds, then falls to zero over `decay` seconds. */
export function flashLevel(source) {
  const age = source.time - source.startTime;
  if (age < 0) return 0;
  if (age < source.attack) return source.intensity * (age / source.attack);
  const remaining = 1 - (age - source.attack) / source.decay;
  return remaining > 0 ? source.intensity * remaining * remaining : 0;
}

const airHeader = `${sharedFragmentHeader}
vec3 rayPointAt(vec2 coordinate, float clipDepth) {
  vec4 point = inverseViewProjection * vec4(coordinate * 2.0 - 1.0, clipDepth, 1.0);
  return point.xyz / point.w;
}
vec3 rayDirectionAt(vec2 coordinate) {
  return normalize(rayPointAt(coordinate, 1.0) - rayPointAt(coordinate, -1.0));
}
// Metres from the camera to the surface under the pixel; the sky is far away.
float surfaceDistanceAt(vec2 coordinate) {
  if (texture(sceneDepth, coordinate).r >= 1.0) return 1e9;
  return distance(worldPointAt(coordinate), rayPointAt(coordinate, -1.0));
}
`;

export const distortionFragment = `${airHeader}
uniform int sourceCount;
uniform vec4 placement[${MAXIMUM_AIR_SOURCES}];
uniform vec4 shape[${MAXIMUM_AIR_SOURCES}];
uniform vec3 extent[${MAXIMUM_AIR_SOURCES}];
float hashAt(vec3 cell) {
  vec3 scaled = fract(cell * 0.3183099 + 0.1) * 17.0;
  return fract(scaled.x * scaled.y * scaled.z * (scaled.x + scaled.y + scaled.z));
}
float noiseAt(vec3 point) {
  vec3 cell = floor(point);
  vec3 blend = fract(point);
  blend = blend * blend * (3.0 - 2.0 * blend);
  float low = mix(mix(hashAt(cell), hashAt(cell + vec3(1, 0, 0)), blend.x), mix(hashAt(cell + vec3(0, 1, 0)), hashAt(cell + vec3(1, 1, 0)), blend.x), blend.y);
  float high = mix(mix(hashAt(cell + vec3(0, 0, 1)), hashAt(cell + vec3(1, 0, 1)), blend.x), mix(hashAt(cell + vec3(0, 1, 1)), hashAt(cell + vec3(1, 1, 1)), blend.x), blend.y);
  return mix(low, high, blend.z);
}
void main() {
  vec3 origin = rayPointAt(textureCoordinate, -1.0);
  vec3 direction = rayDirectionAt(textureCoordinate);
  float surface = surfaceDistanceAt(textureCoordinate);
  vec3 rightDelta = rayDirectionAt(textureCoordinate + vec2(1.0 / resolution.x, 0.0)) - direction;
  vec3 upDelta = rayDirectionAt(textureCoordinate + vec2(0.0, 1.0 / resolution.y)) - direction;
  vec2 shift = vec2(0.0);
  float guardDistance = 1e9;
  for (int index = 0; index < ${MAXIMUM_AIR_SOURCES}; index++) {
    if (index >= sourceCount) break;
    vec3 centre = placement[index].xyz;
    if (placement[index].w < 0.5) {
      // Ring: the pixel's ray passes the centre at some distance; the picture bends where that distance equals the ring radius.
      float along = dot(centre - origin, direction);
      if (along <= 0.0) continue;
      vec3 radial = origin + direction * along - centre;
      float axisDistance = length(radial);
      float band = (axisDistance - shape[index].x) / shape[index].y;
      float shellDistance = along - sqrt(max(shape[index].x * shape[index].x - axisDistance * axisDistance, 0.0));
      float weight = exp(-band * band) * (1.0 - smoothstep(surface - shape[index].y, surface, shellDistance));
      if (weight < 0.002 || axisDistance < 0.0001) continue;
      vec2 onScreen = vec2(dot(radial, rightDelta), dot(radial, upDelta));
      if (length(onScreen) < 1e-9) continue;
      shift += normalize(onScreen) * weight * shape[index].z * ${RING_MAXIMUM_SHIFT.toFixed(3)} * resolution.y;
      guardDistance = min(guardDistance, shellDistance);
    } else {
      // Haze: walk the ray through the box or ellipsoid and shift by noise taken at the middle of the stretch inside it.
      vec3 scaledOrigin = (origin - centre) / extent[index];
      vec3 scaledDirection = direction / extent[index];
      float enter;
      float leave;
      if (placement[index].w < 1.5) {
        vec3 first = (-1.0 - scaledOrigin) / scaledDirection;
        vec3 second = (1.0 - scaledOrigin) / scaledDirection;
        enter = max(max(min(first.x, second.x), min(first.y, second.y)), min(first.z, second.z));
        leave = min(min(max(first.x, second.x), max(first.y, second.y)), max(first.z, second.z));
      } else {
        float quadratic = dot(scaledDirection, scaledDirection);
        float alongHalf = dot(scaledOrigin, scaledDirection);
        float discriminant = alongHalf * alongHalf - quadratic * (dot(scaledOrigin, scaledOrigin) - 1.0);
        if (discriminant < 0.0) continue;
        enter = (-alongHalf - sqrt(discriminant)) / quadratic;
        leave = (-alongHalf + sqrt(discriminant)) / quadratic;
      }
      enter = max(enter, 0.0);
      leave = min(leave, surface);
      if (leave <= enter) continue;
      vec3 middle = origin + direction * (enter + leave) * 0.5;
      vec3 inside = abs((middle - centre) / extent[index]);
      float edge = placement[index].w < 1.5 ? max(inside.x, max(inside.y, inside.z)) : length(inside);
      float weight = clamp((leave - enter) / min(extent[index].x, min(extent[index].y, extent[index].z)), 0.0, 1.0) * (1.0 - smoothstep(0.5, 1.0, edge));
      vec3 sampleAt = (middle - vec3(0.0, shape[index].y, 0.0)) * shape[index].x;
      vec2 wobble = vec2(noiseAt(sampleAt), noiseAt(sampleAt + vec3(17.3, 5.1, 9.7))) * 2.0 - 1.0;
      shift += wobble * weight * shape[index].z * ${HAZE_MAXIMUM_SHIFT.toFixed(3)} * resolution.y;
      guardDistance = min(guardDistance, enter);
    }
  }
  vec2 warped = textureCoordinate - shift / resolution;
  // A surface in front of the bending air must not be dragged along with it: keep the pixel where it is.
  if (guardDistance < 1e8 && surfaceDistanceAt(warped) < guardDistance - 0.05) warped = textureCoordinate;
  outputColor = texture(sourceTexture, warped);
}`;

export const flashFragment = `${airHeader}
uniform int sourceCount;
uniform vec4 flashPlacement[${MAXIMUM_AIR_SOURCES}];
uniform vec3 flashLift[${MAXIMUM_AIR_SOURCES}];
void main() {
  vec4 source = texture(sourceTexture, textureCoordinate);
  bool isSky = texture(sceneDepth, textureCoordinate).r >= 1.0;
  vec3 origin = rayPointAt(textureCoordinate, -1.0);
  vec3 direction = rayDirectionAt(textureCoordinate);
  vec3 lift = vec3(0.0);
  for (int index = 0; index < ${MAXIMUM_AIR_SOURCES}; index++) {
    if (index >= sourceCount) break;
    vec3 centre = flashPlacement[index].xyz;
    vec3 toCentre = centre - origin;
    // Sky has no surface, so the light is measured from the pixel's ray; surfaces are measured from the point they sit at.
    float reach = isSky ? length(toCentre - direction * max(dot(toCentre, direction), 0.0)) : distance(worldPointAt(textureCoordinate), centre);
    float ratio = reach / flashPlacement[index].w;
    lift += flashLift[index] / (1.0 + ratio * ratio);
  }
  outputColor = vec4(source.rgb + lift, source.a);
}`;

/** Packs the active sources of a distortion step into the uniform arrays of its shader. */
export function packDistortion(sources) {
  const placement = new Float32Array(MAXIMUM_AIR_SOURCES * 4);
  const shape = new Float32Array(MAXIMUM_AIR_SOURCES * 4);
  const extent = new Float32Array(MAXIMUM_AIR_SOURCES * 3).fill(1);
  const active = [];
  for (const source of sources) {
    if (source.shape === 'ring') {
      const state = ringState(source);
      if (state && state.amplitude > 0) active.push({ source, row: [state.radius, source.thickness, state.amplitude, 0], kind: 0 });
    } else if (source.strength > 0) {
      active.push({ source, row: [source.noiseScale, source.scroll * source.time, source.strength, 0], kind: source.region === 'box' ? 1 : 2 });
    }
  }
  active.forEach(({ source, row, kind }, index) => {
    placement.set([...source.centre, kind], index * 4);
    shape.set(row, index * 4);
    if (source.shape === 'haze') extent.set(source.size, index * 3);
  });
  return { count: active.length, placement, shape, extent };
}

/** Packs the lit sources of a flash step into the uniform arrays of its shader. */
export function packFlash(sources) {
  const placement = new Float32Array(MAXIMUM_AIR_SOURCES * 4);
  const lift = new Float32Array(MAXIMUM_AIR_SOURCES * 3);
  let count = 0;
  for (const source of sources) {
    const level = flashLevel(source);
    if (level <= 0) continue;
    placement.set([...source.centre, source.radius], count * 4);
    lift.set(source.color.map(component => component * level), count * 3);
    count++;
  }
  return { count, placement, lift };
}

export function createDistortionStage(stepsOf) {
  return createStage({
    name: 'Distortion',
    fragment: distortionFragment,
    uniformNames: ['sourceCount', 'placement', 'shape', 'extent'],
    isActive: (effects, frame) => packDistortion(stepsOf(frame).distortion ?? []).count > 0,
    setUniforms(context, uniforms, renderer, frame) {
      const packed = packDistortion(stepsOf(frame).distortion);
      context.uniform1i(uniforms.sourceCount, packed.count);
      context.uniform4fv(uniforms.placement, packed.placement);
      context.uniform4fv(uniforms.shape, packed.shape);
      context.uniform3fv(uniforms.extent, packed.extent);
    },
  });
}

export function createFlashStage(stepsOf) {
  return createStage({
    name: 'Flash',
    fragment: flashFragment,
    uniformNames: ['sourceCount', 'flashPlacement', 'flashLift'],
    isActive: (effects, frame) => packFlash(stepsOf(frame).flash ?? []).count > 0,
    setUniforms(context, uniforms, renderer, frame) {
      const packed = packFlash(stepsOf(frame).flash);
      context.uniform1i(uniforms.sourceCount, packed.count);
      context.uniform4fv(uniforms.flashPlacement, packed.placement);
      context.uniform3fv(uniforms.flashLift, packed.lift);
    },
  });
}
