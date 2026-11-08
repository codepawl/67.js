import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS } from './light-limits.js';

// What the fog march takes from the scene's local lights. Points come first, then spots.
export const FOG_LIGHT_LIMIT = 8;
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
