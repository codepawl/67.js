// Splat data shared by the Crucible and three.js pages of the benchmark, so both draw the same splats.

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Splats on the six faces of a room 8 m wide and deep and 4 m tall, so the view holds several layers of overlap, like a captured room.
export function syntheticRoom(count) {
  const random = seededRandom(7);
  const size = [8, 4, 8];
  const splatScale = 0.67 * Math.sqrt(160 / count);
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const scales = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const areas = [size[1] * size[2], size[1] * size[2], size[0] * size[2], size[0] * size[2], size[0] * size[1], size[0] * size[1]];
  const totalArea = areas.reduce((sum, area) => sum + area, 0);
  for (let index = 0; index < count; index++) {
    let pick = random() * totalArea;
    let face = 0;
    while (pick > areas[face]) pick -= areas[face++];
    const axis = face >> 1;
    const point = [random() - 0.5, random() - 0.5, random() - 0.5].map((value, dimension) => value * size[dimension]);
    point[axis] = (face & 1 ? 0.5 : -0.5) * size[axis];
    positions.set([point[0], point[1] + 2, point[2]], index * 3);
    const tone = 0.35 + 0.4 * random();
    colors.set([tone * 255, (tone * (0.8 + 0.2 * random())) * 255, tone * 0.7 * 255, 150 + random() * 100], index * 4);
    const axisScale = splatScale * (0.6 + 0.8 * random());
    scales.set([axisScale, axisScale, axisScale], index * 3);
    rotations.set([1, 0, 0, 0], index * 4);
  }
  const bounds = { minimum: [-4, 0, -4], maximum: [4, 4, 4] };
  return { count, positions, colors, scales, rotations, bounds };
}

// Places the captured millipede, which is y-down, about 4 m wide, 2 m behind the part.
export function millipedeMatrix(bounds) {
  const extent = [0, 1, 2].map(axis => bounds.maximum[axis] - bounds.minimum[axis]);
  const center = [0, 1, 2].map(axis => (bounds.minimum[axis] + bounds.maximum[axis]) / 2);
  const scale = 4 / Math.max(...extent);
  return [scale, 0, 0, 0, 0, -scale, 0, 0, 0, 0, -scale, 0, -center[0] * scale + 0.5, center[1] * scale + 1.6, center[2] * scale - 2.2, 1];
}

const PLY_PROPERTIES = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const SPHERICAL_HARMONIC_DC = 0.28209479177387814;

// Writes parsed splat data back as a standard 3DGS PLY, for loaders that only read files.
export function splatsToPly({ count, positions, colors, scales, rotations }) {
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${count}`, ...PLY_PROPERTIES.map(name => `property float ${name}`), 'end_header', ''].join('\n');
  const headerBytes = new TextEncoder().encode(header);
  const values = new Float32Array(count * PLY_PROPERTIES.length);
  for (let index = 0; index < count; index++) {
    const row = index * PLY_PROPERTIES.length;
    for (let axis = 0; axis < 3; axis++) {
      values[row + axis] = positions[index * 3 + axis];
      values[row + 3 + axis] = (colors[index * 4 + axis] / 255 - 0.5) / SPHERICAL_HARMONIC_DC;
      values[row + 7 + axis] = Math.log(scales[index * 3 + axis]);
    }
    const opacity = Math.min(254 / 255, Math.max(1 / 255, colors[index * 4 + 3] / 255));
    values[row + 6] = Math.log(opacity / (1 - opacity));
    for (let component = 0; component < 4; component++) values[row + 10 + component] = rotations[index * 4 + component];
  }
  const file = new Uint8Array(headerBytes.length + values.byteLength);
  file.set(headerBytes, 0);
  file.set(new Uint8Array(values.buffer), headerBytes.length);
  return file.buffer;
}

