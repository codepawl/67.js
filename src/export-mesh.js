// OBJ (with MTL) and binary STL export of the same parts `exportGlb` takes, with world transforms applied.
// Both formats carry triangles only: no lights, cameras, animation, skins, morph weights or textures.

export const MAX_MESH_EXPORT_TRIANGLES = 1_000_000;
const MAX_NAME_LENGTH = 64;
const STL_HEADER_TEXT = 'Crucible binary STL';
const ALPHA_MODES = ['opaque', 'mask', 'blend', 'add'];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function checkFinite(values, label) {
  for (const value of values) {
    if (!Number.isFinite(value)) throw new RangeError(`OBJ export requires finite ${label}.`);
  }
}

function checkFactor(value, label, maximum = 1) {
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    throw new RangeError(`OBJ export requires ${label} to be a finite number ${maximum === 1 ? 'within [0,1]' : 'of at least 0'}.`);
  }
}

function checkColor(values, label) {
  if (!values || values.length !== 3) throw new TypeError(`OBJ export requires ${label} as three linear RGB components.`);
  for (const value of values) checkFactor(value, label);
}

// Only the OBJ writer reads UVs, normals and materials. Each is optional, and one that is present must be well formed.
function checkObjAttributes(part, vertexCount) {
  const { uvs, normals } = part.geometry;
  if (uvs?.length === vertexCount * 2) checkFinite(uvs, 'geometry.uvs');
  if (normals?.length === vertexCount * 3) checkFinite(normals, 'geometry.normals');
  const material = part.material;
  if (material === undefined) return;
  if (material === null || typeof material !== 'object') throw new TypeError('OBJ export requires part.material to be an object.');
  if (material.color !== undefined) checkColor(material.color, 'material.color');
  if (material.emissiveColor !== undefined) checkColor(material.emissiveColor, 'material.emissiveColor');
  if (material.roughness !== undefined) checkFactor(material.roughness, 'material.roughness');
  if (material.metallic !== undefined) checkFactor(material.metallic, 'material.metallic');
  if (material.emission !== undefined) checkFactor(material.emission, 'material.emission', Infinity);
  if (material.alphaMode !== undefined && !ALPHA_MODES.includes(material.alphaMode)) {
    throw new TypeError("OBJ export requires material.alphaMode to be 'opaque', 'mask', 'blend' or 'add'.");
  }
  if (material.opacity !== undefined) checkFactor(material.opacity, 'material.opacity');
}

function checkParts(parts, format) {
  if (!Array.isArray(parts) || parts.length === 0) throw new TypeError(`${format} export requires a nonempty parts array.`);
  let triangleCount = 0;
  for (const part of parts) {
    const { positions, indices } = part?.geometry ?? {};
    if (!positions || positions.length < 9 || positions.length % 3 !== 0) {
      throw new TypeError(`${format} export requires geometry.positions with XYZ vertices on every part.`);
    }
    for (const value of positions) {
      if (!Number.isFinite(value)) throw new RangeError(`${format} export requires finite positions.`);
    }
    if (!(indices instanceof Uint32Array) || indices.length === 0 || indices.length % 3 !== 0) {
      throw new TypeError(`${format} export requires geometry.indices as a nonempty Uint32Array of triangles.`);
    }
    const vertexCount = positions.length / 3;
    for (const index of indices) {
      if (index >= vertexCount) throw new RangeError(`${format} export found an index past the ${vertexCount} vertices.`);
    }
    if (part.matrix !== undefined && (part.matrix.length !== 16 || Array.from(part.matrix).some(value => !Number.isFinite(value)))) {
      throw new RangeError(`${format} export requires part.matrix with 16 finite components.`);
    }
    if (format === 'OBJ') checkObjAttributes(part, vertexCount);
    triangleCount += indices.length / 3;
    if (triangleCount > MAX_MESH_EXPORT_TRIANGLES) {
      throw new RangeError(`${format} export is limited to ${MAX_MESH_EXPORT_TRIANGLES} triangles. Simplify the scene or export fewer parts.`);
    }
  }
}

function worldTriangles(part) {
  const matrix = part.matrix ?? IDENTITY;
  const { positions, indices } = part.geometry;
  const vertexCount = positions.length / 3;
  const world = new Float64Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const x = positions[vertex * 3];
    const y = positions[vertex * 3 + 1];
    const z = positions[vertex * 3 + 2];
    for (let axis = 0; axis < 3; axis++) {
      world[vertex * 3 + axis] = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
    }
  }
  const determinant = matrix[0] * (matrix[5] * matrix[10] - matrix[9] * matrix[6])
    - matrix[4] * (matrix[1] * matrix[10] - matrix[9] * matrix[2])
    + matrix[8] * (matrix[1] * matrix[6] - matrix[5] * matrix[2]);
  // A mirrored transform reverses winding, so swap two corners to keep faces pointing outward.
  const mirrored = determinant < 0;
  const triangles = new Uint32Array(indices);
  if (mirrored) {
    for (let corner = 0; corner < triangles.length; corner += 3) {
      const swapped = triangles[corner + 1];
      triangles[corner + 1] = triangles[corner + 2];
      triangles[corner + 2] = swapped;
    }
  }
  return { world, triangles, matrix };
}

function faceNormal(world, first, second, third) {
  const edgeA = [0, 1, 2].map(axis => world[second * 3 + axis] - world[first * 3 + axis]);
  const edgeB = [0, 1, 2].map(axis => world[third * 3 + axis] - world[first * 3 + axis]);
  const cross = [edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1], edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2], edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0]];
  const length = Math.hypot(...cross);
  return length === 0 ? [0, 0, 0] : cross.map(value => value / length);
}

/** Returns a binary STL `ArrayBuffer` of every part's triangles in world space. Y stays up, units stay as authored. */
export function exportStl(parts) {
  checkParts(parts, 'STL');
  const prepared = parts.map(worldTriangles);
  const triangleCount = prepared.reduce((total, entry) => total + entry.triangles.length / 3, 0);
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);
  new Uint8Array(buffer, 0, 80).set(new TextEncoder().encode(STL_HEADER_TEXT));
  view.setUint32(80, triangleCount, true);
  let offset = 84;
  for (const { world, triangles } of prepared) {
    for (let corner = 0; corner < triangles.length; corner += 3) {
      const first = triangles[corner];
      const second = triangles[corner + 1];
      const third = triangles[corner + 2];
      for (const value of faceNormal(world, first, second, third)) {
        view.setFloat32(offset, value, true);
        offset += 4;
      }
      for (const vertex of [first, second, third]) {
        for (let axis = 0; axis < 3; axis++) {
          view.setFloat32(offset, world[vertex * 3 + axis], true);
          offset += 4;
        }
      }
      offset += 2;
    }
  }
  return buffer;
}

function formatNumber(value) {
  // Nine significant digits (more than Float32 holds), shortest text, no "-0": the same input always gives the same bytes.
  const rounded = Number(value.toPrecision(9));
  return String(rounded === 0 ? 0 : rounded);
}

function safeName(name, fallback) {
  const cleaned = String(name ?? '').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, MAX_NAME_LENGTH);
  return cleaned || fallback;
}

function materialKey(material) {
  return JSON.stringify([material?.color, material?.emissiveColor, material?.emission, material?.metallic, material?.roughness, dissolve(material)]);
}

// An opaque material ignores opacity, as in the GLB export; mask, blend and add write it as the MTL dissolve value.
function dissolve(material) {
  const alphaMode = material?.alphaMode ?? 'opaque';
  return alphaMode === 'opaque' ? 1 : material.opacity ?? 1;
}

function mtlBlock(name, material) {
  const color = material?.color ?? [0.8, 0.8, 0.8];
  const lines = [`newmtl ${name}`, `Kd ${color.map(formatNumber).join(' ')}`];
  if ((material?.emission ?? 0) > 0) {
    const emissive = (material.emissiveColor ?? color).map(value => value * Math.min(material.emission, 1));
    lines.push(`Ke ${emissive.map(formatNumber).join(' ')}`);
  }
  lines.push(`Pr ${formatNumber(material?.roughness ?? 0.5)}`, `Pm ${formatNumber(material?.metallic ?? 0)}`, `d ${formatNumber(dissolve(material))}`);
  return lines.join('\n');
}

/**
 * Returns `{ obj, mtl }` as text. The OBJ names the MTL by `mtlFilename` (default `model.mtl`); save both files side by side.
 * Colors in the MTL are the linear base colors of the parts, with roughness and metallic as `Pr` and `Pm`
 * and the opacity of a mask, blend or add material as `d`.
 */
export function exportObj(parts, options = {}) {
  checkParts(parts, 'OBJ');
  const mtlFilename = options.mtlFilename ?? 'model.mtl';
  if (typeof mtlFilename !== 'string' || !/^[A-Za-z0-9_.-]{1,64}\.mtl$/.test(mtlFilename)) {
    throw new TypeError('OBJ export mtlFilename must be a plain file name ending in .mtl, such as "model.mtl".');
  }
  const materialNames = new Map();
  const materialBlocks = [];
  const lines = [`Crucible OBJ export`, `mtllib ${mtlFilename}`];
  let vertexBase = 1;
  let uvBase = 1;
  let normalBase = 1;
  parts.forEach((part, partIndex) => {
    const { world, triangles, matrix } = worldTriangles(part);
    const key = materialKey(part.material);
    if (!materialNames.has(key)) {
      const name = `material_${materialNames.size}`;
      materialNames.set(key, name);
      materialBlocks.push(mtlBlock(name, part.material));
    }
    lines.push(`o ${safeName(part.name, `part_${partIndex}`)}`, `usemtl ${materialNames.get(key)}`);
    const vertexCount = world.length / 3;
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      lines.push(`v ${formatNumber(world[vertex * 3])} ${formatNumber(world[vertex * 3 + 1])} ${formatNumber(world[vertex * 3 + 2])}`);
    }
    const uvs = part.geometry.uvs?.length === vertexCount * 2 ? part.geometry.uvs : null;
    if (uvs) {
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        lines.push(`vt ${formatNumber(uvs[vertex * 2])} ${formatNumber(uvs[vertex * 2 + 1])}`);
      }
    }
    const normals = part.geometry.normals?.length === vertexCount * 3 ? worldNormals(part.geometry.normals, matrix) : null;
    if (normals) {
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        lines.push(`vn ${formatNumber(normals[vertex * 3])} ${formatNumber(normals[vertex * 3 + 1])} ${formatNumber(normals[vertex * 3 + 2])}`);
      }
    }
    for (let corner = 0; corner < triangles.length; corner += 3) {
      const face = [0, 1, 2].map(offset => {
        const vertex = triangles[corner + offset];
        const position = vertex + vertexBase;
        const normal = vertex + normalBase;
        if (uvs && normals) return `${position}/${vertex + uvBase}/${normal}`;
        if (uvs) return `${position}/${vertex + uvBase}`;
        return normals ? `${position}//${normal}` : `${position}`;
      });
      lines.push(`f ${face.join(' ')}`);
    }
    vertexBase += vertexCount;
    if (uvs) uvBase += vertexCount;
    if (normals) normalBase += vertexCount;
  });
  return { obj: `${lines.join('\n')}\n`, mtl: `# Crucible MTL export\n${materialBlocks.join('\n\n')}\n` };
}

// Normals use the inverse transpose of the upper 3x3 so non-uniform scale keeps them perpendicular to the surface.
function worldNormals(normals, matrix) {
  const [a, b, c, , d, e, f, , g, h, i] = matrix;
  const cofactor = [
    e * i - f * h, f * g - d * i, d * h - e * g,
    c * h - b * i, a * i - c * g, b * g - a * h,
    b * f - c * e, c * d - a * f, a * e - b * d,
  ];
  // Column-major matrix: the cofactor matrix is the inverse transpose up to the determinant's sign and size, which normalizing removes.
  const result = new Float64Array(normals.length);
  const sign = (a * cofactor[0] + b * cofactor[1] + c * cofactor[2]) < 0 ? -1 : 1;
  for (let vertex = 0; vertex < normals.length; vertex += 3) {
    const x = normals[vertex];
    const y = normals[vertex + 1];
    const z = normals[vertex + 2];
    const transformed = [0, 1, 2].map(row => sign * (cofactor[row] * x + cofactor[3 + row] * y + cofactor[6 + row] * z));
    const length = Math.hypot(...transformed) || 1;
    for (let axis = 0; axis < 3; axis++) result[vertex + axis] = transformed[axis] / length;
  }
  return result;
}
