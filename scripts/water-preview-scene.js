// The scene of the water preview picture (scripts/measure-water-shadows.mjs --preview): a gravel bed, a wooden ladder standing in
// the water, a boulder and a small rock on the bed. The models are Poly Haven CC0 assets (boulder_01, rock_07 and the ladder of
// modular_wooden_pier) and the bed is the Poly Haven gravel_ground_01 material; they are read from a folder that is never committed.
import { CrucibleRenderer } from '../src/renderer.js';
import { box } from '../src/geometry.js';
import { loadGltf } from '../src/gltf.js';
import '../src/world-material-shader.js';

const SUN_DIRECTION = [-0.6, 1, 0];
const POOL_SIZE = 12;
const unitBox = box(0, 1);

async function loadImage(url) {
  return createImageBitmap(await (await fetch(url)).blob());
}

/** The sourced models and the gravel maps, read once. `folder` holds boulder_01, rock_07, modular_wooden_pier and textures/gravel_ground_01. */
export async function loadPreviewAssets(folder) {
  const model = async name => (await loadGltf(`${folder}/${name}/${name}_2k.gltf`)).parts;
  const [boulder, rock, pier] = await Promise.all([model('boulder_01'), model('rock_07'), model('modular_wooden_pier')]);
  const gravel = `${folder}/textures/gravel_ground_01/gravel_ground_01`;
  const [color, normal] = await Promise.all([loadImage(`${gravel}_diff_2k.jpg`), loadImage(`${gravel}_nor_gl_2k.jpg`)]);
  return { boulder, rock, ladder: pier.filter(part => part.name.startsWith('Plane062')), gravel: { color, normal } };
}

function boundsOf(parts) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const { positions } = part.geometry;
    for (let index = 0; index < positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value = part.matrix[axis] * positions[index] + part.matrix[4 + axis] * positions[index + 1] + part.matrix[8 + axis] * positions[index + 2] + part.matrix[12 + axis];
        low[axis] = Math.min(low[axis], value);
        high[axis] = Math.max(high[axis], value);
      }
    }
  }
  return { low, high };
}

// The model scaled to `height`, standing with its lowest point at `baseY` and its footprint centred on (x, z).
function placed(parts, { height, x, z, baseY }) {
  const { low, high } = boundsOf(parts);
  const scale = height / (high[1] - low[1]);
  const centreX = (low[0] + high[0]) / 2;
  const centreZ = (low[2] + high[2]) / 2;
  return parts.map(part => {
    const matrix = Float32Array.from(part.matrix);
    for (let column = 0; column < 12; column++) matrix[column] *= scale;
    matrix[12] = (part.matrix[12] - centreX) * scale + x;
    matrix[13] = (part.matrix[13] - low[1]) * scale + baseY;
    matrix[14] = (part.matrix[14] - centreZ) * scale + z;
    return Object.freeze({ ...part, matrix });
  });
}

function placedBox(name, center, size, material, castShadow) {
  const matrix = new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1]);
  return { name, geometry: unitBox, matrix, material, ...(castShadow === undefined ? {} : { castShadow }) };
}

/** The pool `depth` metres deep: gravel bed, a ladder from the bed to 1.2 m above the water, a boulder and a rock. */
export function previewParts(assets, depth, water, opacity) {
  const bed = { tag: 'surface', color: [1, 1, 1], metallic: 0, roughness: 0.9, emission: 0, boxMapScale: 0.45, boxMapAxis: 1,
    map: { image: assets.gravel.color, colorSpace: 'srgb' }, normalMap: { image: assets.gravel.normal, colorSpace: 'linear' }, normalScale: [1, 1] };
  const sheet = { tag: 'water', color: [0.02, 0.05, 0.08], metallic: 0, roughness: 0.1, emission: 0, ...water, ...(opacity < 1 ? { opacity, alphaMode: 'blend' } : {}) };
  return [
    placedBox('bed', [0, -depth - 0.5, 0], [POOL_SIZE, 1, POOL_SIZE], bed),
    ...placed(assets.ladder, { height: depth + 1.2, x: 0.3, z: 0, baseY: -depth }),
    ...placed(assets.boulder, { height: 1.1, x: -1.7, z: -1.4, baseY: -depth }),
    ...placed(assets.rock, { height: 0.5, x: 1.7, z: 1.3, baseY: -depth }),
    placedBox('water', [0, -0.05, 0], [POOL_SIZE, 0.1, POOL_SIZE], sheet, false),
  ];
}

/** Draws one frame on `canvas`; the caller reads the canvas before the next frame. */
export function drawPreviewPool(canvas, assets, depth, water, view, opacity = 0.35) {
  const parts = previewParts(assets, depth, water, opacity);
  const renderer = new CrucibleRenderer(canvas, parts, { depth: false, world: false, ground: false, pixelRatio: 1, samples: 4, environment: { lightDirection: SUN_DIRECTION, keyColor: [3, 3, 3] } });
  renderer.render({ ...view, fov: 40, time: 0.5, environment: { lightDirection: SUN_DIRECTION } });
  return renderer;
}
