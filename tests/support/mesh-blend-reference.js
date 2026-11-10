// A CPU port of the fragment shader in src/mesh-blend.js, for tests on synthetic buffers. It reads the same inputs (part IDs,
// world positions rebuilt from depth, source colour) and follows the shader line by line, with the same tap pattern.
import { MESH_BLEND_TAPS } from '../../src/mesh-blend.js';

const MAXIMUM_PIXEL_RADIUS = 40;

function smoothstep(low, high, value) {
  const fraction = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return fraction * fraction * (3 - 2 * fraction);
}

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function dot(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function cross(first, second) {
  return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
}

// The shorter step of the two sides, skipping a zero step.
function shorterStep(first, second) {
  const firstLength = dot(first, first);
  const secondLength = dot(second, second);
  return secondLength < 1e-14 || (firstLength >= 1e-14 && firstLength < secondLength) ? first : second;
}

/**
 * buffers: { width, height, ids (Int32Array), positions (Float32Array xyz), colors (Float32Array rgb) }.
 * options: { radii: Map id -> metres, eye, pixelsPerMetre, orthographic }. Returns the blended colors.
 */
export function blendReference(buffers, options) {
  const { width, height, ids, positions, colors } = buffers;
  const clampX = x => Math.min(width - 1, Math.max(0, x));
  const clampY = y => Math.min(height - 1, Math.max(0, y));
  const indexOf = (x, y) => clampY(y) * width + clampX(x);
  const positionAt = (x, y) => Array.from(positions.subarray(indexOf(x, y) * 3, indexOf(x, y) * 3 + 3));
  const stepAlong = (x, y, dx, dy, center, part) => {
    const forward = subtract(positionAt(x + dx, y + dy), center);
    const backward = subtract(center, positionAt(x - dx, y - dy));
    const forwardSame = ids[indexOf(x + dx, y + dy)] === part;
    const backwardSame = ids[indexOf(x - dx, y - dy)] === part;
    if (forwardSame !== backwardSame) return forwardSame ? forward : backward;
    return shorterStep(forward, backward);
  };
  const normalAt = (x, y, center, part) => {
    const raw = cross(stepAlong(x, y, 1, 0, center, part), stepAlong(x, y, 0, 1, center, part));
    const toEyeRaw = subtract(options.eye, center);
    const toEye = toEyeRaw.map(component => component / Math.hypot(...toEyeRaw));
    if (dot(raw, raw) < 1e-20) return toEye;
    const normal = raw.map(component => component / Math.hypot(...raw));
    return dot(normal, toEye) < 0 ? normal.map(component => -component) : normal;
  };
  const output = new Float32Array(colors);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const part = ids[indexOf(x, y)];
      const radius = options.radii.get(part) ?? 0;
      if (part === 0 || radius <= 0) continue;
      const center = positionAt(x, y);
      const pixelRadius = Math.min(MAXIMUM_PIXEL_RADIUS, Math.max(1, radius * options.pixelsPerMetre / (options.orthographic ? 1 : Math.hypot(...subtract(center, options.eye)))));
      const reach = radius * 3;
      const colorSum = [0, 0, 0];
      let otherWeight = 0;
      let totalWeight = 0;
      let nearestTap = null;
      for (let index = 0; index < MESH_BLEND_TAPS.count; index++) {
        const fraction = Math.sqrt((index + 0.5) / MESH_BLEND_TAPS.count);
        const angle = index * MESH_BLEND_TAPS.angleStep;
        const tapX = x + Math.round(Math.cos(angle) * pixelRadius * fraction);
        const tapY = y + Math.round(Math.sin(angle) * pixelRadius * fraction);
        const weight = 1 - fraction;
        totalWeight += weight;
        const tapPart = ids[indexOf(tapX, tapY)];
        if (tapPart <= 0 || tapPart === part || (options.radii.get(tapPart) ?? 0) > 0) continue;
        if (Math.hypot(...subtract(positionAt(tapX, tapY), center)) > reach) continue;
        nearestTap ??= [tapX, tapY];
        for (let channel = 0; channel < 3; channel++) colorSum[channel] += weight * colors[indexOf(tapX, tapY) * 3 + channel];
        otherWeight += weight;
      }
      if (!nearestTap) continue;
      const nearestPosition = positionAt(...nearestTap);
      const creased = smoothstep(0.05, 0.4, 1 - dot(normalAt(x, y, center, part), normalAt(nearestTap[0], nearestTap[1], nearestPosition, ids[indexOf(nearestTap[0], nearestTap[1])])));
      const amount = smoothstep(0, 0.5, otherWeight / totalWeight) * creased;
      for (let channel = 0; channel < 3; channel++) {
        const source = colors[indexOf(x, y) * 3 + channel];
        output[indexOf(x, y) * 3 + channel] = source + (colorSum[channel] / otherWeight - source) * amount;
      }
    }
  }
  return output;
}
