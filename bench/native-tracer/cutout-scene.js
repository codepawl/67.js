// The cutout test scene shared by the Node run (cutout.mjs) and the browser harness: a ground plane under masked leaf cards.
const TEXTURE_SIZE = 64;

// A green disc in a transparent square: texels outside the disc have alpha 0, so a cutout that is ignored shows squares.
function leafTexture(solid = false) {
  const data = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let row = 0; row < TEXTURE_SIZE; row++) {
    for (let column = 0; column < TEXTURE_SIZE; column++) {
      const offsetX = (column + 0.5) / TEXTURE_SIZE - 0.5;
      const offsetY = (row + 0.5) / TEXTURE_SIZE - 0.5;
      const inside = solid || Math.hypot(offsetX, offsetY) < 0.45;
      data.set([60, 170, 70, inside ? 255 : 0], (row * TEXTURE_SIZE + column) * 4);
    }
  }
  return { image: { data, width: TEXTURE_SIZE, height: TEXTURE_SIZE }, colorSpace: 'srgb', wrapS: 33071 };
}

function quad(center, along, across, size) {
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([first, second]) => center.map((value, axis) => value + (along[axis] * first + across[axis] * second) * size));
  const normal = [along[1] * across[2] - along[2] * across[1], along[2] * across[0] - along[0] * across[2], along[0] * across[1] - along[1] * across[0]];
  return {
    positions: new Float32Array(corners.flat()),
    normals: new Float32Array([...normal, ...normal, ...normal, ...normal]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

let randomState = 12345;
function random() {
  randomState = (randomState * 1664525 + 1013904223) >>> 0;
  return randomState / 4294967296;
}

function tiltedAxes() {
  const angle = random() * Math.PI * 2;
  const tilt = (random() - 0.5) * 1.6;
  const along = [Math.cos(angle), 0, Math.sin(angle)];
  const across = [-Math.sin(angle) * Math.cos(tilt), Math.sin(tilt), Math.cos(angle) * Math.cos(tilt)];
  return { along, across };
}

export const CUTOUT_CAMERA = { eye: [0, 3.2, 6], target: [0, 0.8, 0], fov: 45 };
export const CUTOUT_ENVIRONMENT = { keyColor: [3, 2.8, 2.5], lightDirection: [0.4, 0.8, 0.35], pointLights: [], areaLights: [] };

export function buildCutoutParts(leafCount, masked = true, solidTexture = false) {
  randomState = 12345;
  const texture = leafTexture(solidTexture);
  const parts = [{ name: 'ground', geometry: quad([0, 0, 0], [1, 0, 0], [0, 0, -1], 8), material: { color: [0.6, 0.55, 0.45], roughness: 0.9 } }];
  for (let leaf = 0; leaf < leafCount; leaf++) {
    const { along, across } = tiltedAxes();
    const center = [(random() - 0.5) * 5, 0.2 + random() * 1.6, (random() - 0.5) * 5];
    parts.push({ name: `leaf-${leaf}`, geometry: quad(center, along, across, 0.35),
      material: { color: [1, 1, 1], roughness: 0.7, ...(masked ? { map: texture, alphaMode: 'mask', alphaCutoff: 0.5 } : {}) } });
  }
  return parts;
}
