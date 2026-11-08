import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS } from './light-limits.js';
import { finiteRange } from './volumetric.js';

// What the fog march takes from the scene's local lights. Points come first, then spots.
export const FOG_LIGHT_LIMIT = 8;
export const DEFAULT_FLOW_STRENGTH = 1;
export const DEFAULT_FLOW_PERIOD = 2;
// What a fog without detail controls uses: one octave, no warp, the noise as is, the layer top fading from half its height.
const DEFAULT_DETAIL = { detailOctaves: 1, detailAmount: 0.5, warp: 0, contrast: 1, profileSoftness: 0.5, keyScattering: 1 };
const DETAIL_LIMITS = {
  detailOctaves: [1, 3, 'Volume detail octaves'],
  detailAmount: [0, 1, 'Volume detail amount'],
  warp: [0, 4, 'Volume warp'],
  contrast: [0, 4, 'Volume contrast'],
  profileSoftness: [0, 0.95, 'Volume profile softness'],
  keyScattering: [0, 10, 'Volume key scattering'],
};

/** The six detail fields of a resolved volume fog with defaults filled in. Anything unset or out of range throws like the core fields. */
export function resolveFogDetail(volume) {
  const detail = { ...DEFAULT_DETAIL };
  for (const [field, [minimum, maximum, label]] of Object.entries(DETAIL_LIMITS)) {
    if (volume[field] !== undefined) detail[field] = finiteRange(volume[field], minimum, maximum, label);
  }
  if (!Number.isInteger(detail.detailOctaves)) throw new RangeError('Volume detail octaves must be an integer');
  return detail;
}

/** True when the density noise differs from the plain single lookup, so the frame needs the post program with the detail step. */
export function fogUsesDetail(volume) {
  const detail = resolveFogDetail(volume);
  return detail.detailOctaves > 1 || detail.warp > 0 || detail.contrast !== 1;
}
// A light's own radius is a few centimetres, and inside fog that would put a spike of glow around it.
const FOG_LIGHT_MINIMUM_RADIUS = 0.1;

export function createFogLightBuffers() {
  return {
    count: 0,
    positions: new Float32Array(FOG_LIGHT_LIMIT * 4),
    colors: new Float32Array(FOG_LIGHT_LIMIT * 4),
    directions: new Float32Array(FOG_LIGHT_LIMIT * 4),
    cones: new Float32Array(FOG_LIGHT_LIMIT * 4),
  };
}

function writePoint(buffers, slot, lighting, index) {
  const offset = slot * 4;
  const source = index * 4;
  buffers.positions.set(lighting.positions.subarray(source, source + 4), offset);
  const intensity = lighting.colors[source + 3];
  for (let channel = 0; channel < 3; channel++) buffers.colors[offset + channel] = lighting.colors[source + channel] * intensity;
  buffers.colors[offset + 3] = Math.max(lighting.radii[index], FOG_LIGHT_MINIMUM_RADIUS);
  buffers.directions.fill(0, offset, offset + 4);
  buffers.cones.fill(0, offset, offset + 4);
}

function writeSpot(buffers, slot, lighting, index) {
  const offset = slot * 4;
  const source = index * 4;
  buffers.positions.set(lighting.spotPositions.subarray(source, source + 4), offset);
  const intensity = lighting.spotColors[source + 3];
  for (let channel = 0; channel < 3; channel++) buffers.colors[offset + channel] = lighting.spotColors[source + channel] * intensity;
  buffers.colors[offset + 3] = Math.max(lighting.spotParameters[source], FOG_LIGHT_MINIMUM_RADIUS);
  buffers.directions.set(lighting.spotDirections.subarray(source, source + 4), offset);
  buffers.cones[offset] = lighting.spotParameters[source + 1];
  buffers.cones[offset + 1] = 1;
  buffers.cones[offset + 2] = 0;
  buffers.cones[offset + 3] = 0;
}

/** Copies up to FOG_LIGHT_LIMIT point and spot lights from the lighting state into the fog's uniform buffers. */
export function packFogLights(lighting, buffers) {
  let slot = 0;
  for (let index = 0; index < Math.min(lighting.pointCount, MAX_POINT_LIGHTS) && slot < FOG_LIGHT_LIMIT; index++) {
    if (lighting.colors[index * 4 + 3] === 0) continue;
    writePoint(buffers, slot++, lighting, index);
  }
  for (let index = 0; index < Math.min(lighting.spotCount, MAX_SPOT_LIGHTS) && slot < FOG_LIGHT_LIMIT; index++) {
    if (lighting.spotColors[index * 4 + 3] === 0) continue;
    writeSpot(buffers, slot++, lighting, index);
  }
  buffers.count = slot;
  return slot;
}

/**
 * The fog field as one RGBA16F texture, linear filtered and clamped at the edges. The same size writes into the texture it
 * has (texSubImage2D); a new size allocates new storage. The caller may rewrite the Float32Array between frames, so every
 * frame that carries a field uploads it.
 */
export class FogFieldTexture {
  constructor(context) {
    this.context = context;
    this.texture = null;
    this.width = 0;
    this.height = 0;
  }

  upload(field) {
    const context = this.context;
    if (!this.texture) {
      this.texture = context.createTexture();
      context.bindTexture(context.TEXTURE_2D, this.texture);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    } else {
      context.bindTexture(context.TEXTURE_2D, this.texture);
    }
    if (field.width === this.width && field.height === this.height) {
      context.texSubImage2D(context.TEXTURE_2D, 0, 0, 0, field.width, field.height, context.RGBA, context.FLOAT, field.data);
      return;
    }
    context.texImage2D(context.TEXTURE_2D, 0, context.RGBA16F, field.width, field.height, 0, context.RGBA, context.FLOAT, field.data);
    this.width = field.width;
    this.height = field.height;
  }

  dispose() {
    if (this.texture) this.context.deleteTexture(this.texture);
    this.texture = null;
    this.width = 0;
    this.height = 0;
  }
}

const derivedShadowAmbients = new WeakMap();

/**
 * The share of the fog's ambient that survives in the sun's shadow. A set value wins. Otherwise it follows how open the sky is
 * from the middle of the fog: a closed room keeps 0.15, open ground under the sky keeps all of it.
 * `measureOpenness(parts, point)` is the `skyOpenness` option of the renderer (src/closed-room.js), kept out of the core
 * bundle; without it, or for a scene too large to test, the scene counts as enclosed. It runs once per scene and fog box.
 */
export function volumeShadowAmbient(volume, parts, measureOpenness) {
  if (volume.shadowAmbient !== undefined) {
    return volume.shadowAmbient;
  }
  const key = `${volume.minimum}|${volume.maximum}`;
  const cached = derivedShadowAmbients.get(parts);
  if (cached?.key === key) {
    return cached.value;
  }
  const centre = volume.minimum.map((low, axis) => (low + volume.maximum[axis]) / 2);
  const value = 0.15 + 0.85 * (measureOpenness?.(parts, centre) ?? 0);
  derivedShadowAmbients.set(parts, { key, value });
  return value;
}
