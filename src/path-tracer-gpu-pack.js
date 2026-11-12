import { DATA_TEXTURE_WIDTH, TRIANGLE_TEXELS, MATERIAL_TEXELS, LIGHT_TEXELS } from './path-tracer-gpu-shader.js';
import { buildLightTree, LIGHT_TREE_NODE_TEXELS } from './path-tracer-light-tree.js';
import { SUBSURFACE_TEXELS } from './path-tracer-gpu-subsurface.js';

// Lays a traced scene (path-tracer-scene.js) out as the float textures the GPU kernel reads. Everything here is plain
// typed arrays, so it runs and is tested without a GPU. Each table is a run of RGBA texels, DATA_TEXTURE_WIDTH to a row.

export const ATLAS_WIDTH = 4096;
const MAXIMUM_TEXTURE_SIZE = 16384;

/** A table of `texelCount` RGBA texels, padded to whole rows. */
function createTable(texelCount, channels = 4) {
  const rows = Math.max(1, Math.ceil(texelCount / DATA_TEXTURE_WIDTH));
  if (rows > MAXIMUM_TEXTURE_SIZE) throw new RangeError('The scene is too large for the GPU path tracer tables.');
  return { width: DATA_TEXTURE_WIDTH, height: rows, channels, data: new Float32Array(DATA_TEXTURE_WIDTH * rows * channels) };
}

/** Two texels per node: (minimum, -leaf triangle count or right child) and (maximum, first triangle slot). */
export function packNodes(bvh) {
  const table = createTable(bvh.nodeCount * 2);
  const { data } = table;
  for (let node = 0; node < bvh.nodeCount; node++) {
    const target = node * 8;
    for (let axis = 0; axis < 3; axis++) {
      data[target + axis] = bvh.nodeBounds[node * 6 + axis];
      data[target + 4 + axis] = bvh.nodeBounds[node * 6 + 3 + axis];
    }
    const right = bvh.rightChild[node];
    data[target + 3] = right < 0 ? -bvh.rangeCount[node] : right;
    data[target + 7] = bvh.rangeStart[node];
  }
  return table;
}

/** Nine texels per triangle in leaf order: corner and material, two edges, three normals with u, three colours with v. */
export function packTriangles(scene) {
  const { positions, normals, uvs, colors, indices, triangleMaterial, bvh } = scene;
  const order = bvh.triangleOrder;
  const table = createTable(order.length * TRIANGLE_TEXELS);
  const { data } = table;
  for (let slot = 0; slot < order.length; slot++) {
    const triangle = order[slot];
    const base = slot * TRIANGLE_TEXELS * 4;
    const corners = [indices[triangle * 3], indices[triangle * 3 + 1], indices[triangle * 3 + 2]];
    for (let axis = 0; axis < 3; axis++) {
      const origin = positions[corners[0] * 3 + axis];
      data[base + axis] = origin;
      data[base + 4 + axis] = positions[corners[1] * 3 + axis] - origin;
      data[base + 8 + axis] = positions[corners[2] * 3 + axis] - origin;
    }
    data[base + 3] = triangleMaterial[triangle];
    for (let corner = 0; corner < 3; corner++) {
      const vertex = corners[corner];
      for (let axis = 0; axis < 3; axis++) {
        data[base + (3 + corner) * 4 + axis] = normals[vertex * 3 + axis];
        data[base + (6 + corner) * 4 + axis] = colors[vertex * 3 + axis];
      }
      data[base + (3 + corner) * 4 + 3] = uvs[vertex * 2];
      data[base + (6 + corner) * 4 + 3] = uvs[vertex * 2 + 1];
    }
  }
  return table;
}

/** Shelf-packs the distinct material textures into one RGBA8 atlas; returns where each one went. */
export function packAtlas(materials) {
  const fields = ['texture', 'normalTexture', 'surfaceTexture', 'emissiveTexture'];
  const placements = new Map();
  const textures = [];
  for (const material of materials) {
    for (const field of fields) {
      const texture = material[field];
      if (texture && !placements.has(texture.data)) {
        placements.set(texture.data, null);
        textures.push(texture);
      }
    }
  }
  if (textures.length === 0) return { placements, width: 1, height: 1, data: new Uint8Array(4) };
  textures.sort((first, second) => second.height - first.height);
  let shelfX = 0;
  let shelfY = 0;
  let shelfHeight = 0;
  for (const texture of textures) {
    if (texture.width > ATLAS_WIDTH) throw new RangeError('A material texture is wider than the GPU atlas.');
    if (shelfX + texture.width > ATLAS_WIDTH) {
      shelfY += shelfHeight;
      shelfX = 0;
      shelfHeight = 0;
    }
    placements.set(texture.data, { x: shelfX, y: shelfY });
    shelfX += texture.width;
    shelfHeight = Math.max(shelfHeight, texture.height);
  }
  const height = shelfY + shelfHeight;
  if (height > MAXIMUM_TEXTURE_SIZE) throw new RangeError('The material textures do not fit the GPU atlas.');
  const data = new Uint8Array(ATLAS_WIDTH * height * 4);
  for (const texture of textures) {
    const { x, y } = placements.get(texture.data);
    for (let row = 0; row < texture.height; row++) {
      data.set(texture.data.subarray(row * texture.width * 4, (row + 1) * texture.width * 4), ((y + row) * ATLAS_WIDTH + x) * 4);
    }
  }
  return { placements, width: ATLAS_WIDTH, height, data };
}

// The float of a material record that holds the shadow-only flag: texel 5, second channel (its first channel is the emission map flag).
export const SHADOW_ONLY_SLOT = 21;

function textureFlags(texture) {
  return (texture.repeat ? 1 : 0) + (texture.colorLookup ? 2 : 0);
}

/**
 * Ten texels per material: surface values, texture flags, then one atlas rectangle per map. A material of a shadow-only part
 * (`shadowOnlyParts[index] === 1`) also gets 1 in SHADOW_ONLY_SLOT, which camera rays read to step through it.
 */
export function packMaterials(materials, atlas, shadowOnlyParts = null) {
  const table = createTable(materials.length * MATERIAL_TEXELS);
  const { data } = table;
  const fields = ['texture', 'normalTexture', 'surfaceTexture', 'emissiveTexture'];
  materials.forEach((material, index) => {
    const base = index * MATERIAL_TEXELS * 4;
    const mask = material.lightMask < 0 ? 0xffffffff : material.lightMask >>> 0;
    data.set([...material.color, material.metallic], base);
    data.set([...material.emission, material.roughness], base + 4);
    data.set([material.clearcoat, material.clearcoatRoughness, material.transmission, material.ior], base + 8);
    data.set([material.normalScale[0], material.normalScale[1], material.alphaCutoff, mask & 0xffff], base + 12);
    data[base + 16] = (mask >>> 16) & 0xffff;
    fields.forEach((field, fieldIndex) => {
      const texture = material[field];
      if (!texture) return;
      const place = atlas.placements.get(texture.data);
      data[base + 17 + fieldIndex] = textureFlags(texture);
      data.set([place.x, place.y, texture.width, texture.height], base + (6 + fieldIndex) * 4);
    });
    if (shadowOnlyParts?.[index] === 1) data[base + SHADOW_ONLY_SLOT] = 1;
  });
  return table;
}

/** True when a part has a subsurface weight above 0, which is when the kernel needs the random walk. */
export function sceneUsesSubsurface(materials) {
  return materials.some(material => material.subsurface);
}

/**
 * Two texels per material: (weight, mean free path in metres for red, green and blue) and (colour, unused). The colour red is
 * -1 for the base colour. A material without a block packs a weight of 0, which the kernel treats as the unchanged path.
 */
export function packSubsurface(materials) {
  const table = createTable(materials.length * SUBSURFACE_TEXELS);
  const { data } = table;
  materials.forEach((material, index) => {
    const base = index * SUBSURFACE_TEXELS * 4;
    const block = material.subsurface;
    if (!block) return;
    data.set([block.weight, ...block.meanFreePath], base);
    data.set([...(block.color ?? [-1, -1, -1]), 0], base + 4);
  });
  return table;
}

const LIGHT_TYPES = { point: 0, spot: 1, area: 2 };

/**
 * Six texels per point, spot or area light, in the order the tracer samples them. The third float of the last texel is 1 for a point or
 * spot light with `softFalloff` (an oriented disk, read by the `cycles` kernel only) and 0 for every other light.
 */
export function packLights(lights) {
  const entries = [
    ...lights.points.map(light => ({ light, type: LIGHT_TYPES.point })),
    ...lights.spots.map(light => ({ light, type: LIGHT_TYPES.spot })),
    ...lights.areas.map(light => ({ light, type: LIGHT_TYPES.area })),
  ];
  const table = createTable(Math.max(1, entries.length) * LIGHT_TEXELS);
  const { data } = table;
  entries.forEach(({ light, type }, index) => {
    const base = index * LIGHT_TEXELS * 4;
    data.set([...light.position, type], base);
    data.set([...light.color, light.bit], base + 4);
    if (type === LIGHT_TYPES.area) {
      data.set([...light.normal, light.width], base + 8);
      data.set([...light.across, light.height], base + 12);
      data.set([...light.along, 0], base + 16);
      data.set([light.intensity, 0, 0, 0], base + 20);
      return;
    }
    data.set([...(light.direction ?? [0, 0, 0]), light.radius], base + 8);
    data.set([0, 0, 0, light.cosineHalfAngle ?? 0], base + 12);
    data.set([0, 0, 0, light.blend ?? 0], base + 16);
    data.set([light.intensity, light.range, light.softFalloff === true ? 1 : 0, 0], base + 20);
  });
  return { table, count: entries.length };
}

/** The light tree (path-tracer-light-tree.js) as a table: four texels per node, in the node order of the tree. */
export function packLightTree(lights) {
  const tree = buildLightTree(lights);
  const table = createTable(Math.max(1, tree.nodeCount) * LIGHT_TREE_NODE_TEXELS);
  table.data.set(tree.data);
  return table;
}

/** The map as RGBA32F plus normalised cumulative tables, so the shader compares them with a unit random number. */
export function packEnvironment(environment) {
  if (!environment) return null;
  const { width, height, channels, data: source } = environment;
  const colors = new Float32Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    for (let channel = 0; channel < 3; channel++) colors[pixel * 4 + channel] = source[pixel * channels + channel];
    colors[pixel * 4 + 3] = 1;
  }
  const rows = createTable(height, 1);
  const pixels = createTable(width * height, 1);
  const rowTotal = environment.rowCumulative[height - 1];
  for (let row = 0; row < height; row++) rows.data[row] = environment.rowCumulative[row] / rowTotal;
  for (let row = 0; row < height; row++) {
    const rowEnd = environment.pixelCumulative[row * width + width - 1];
    for (let column = 0; column < width; column++) pixels.data[row * width + column] = environment.pixelCumulative[row * width + column] / rowEnd;
  }
  return { colors, width, height, rows, pixels };
}
