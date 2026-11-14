// Moves meshes between a three.js object tree and Crucible parts.
//   fromThreeObject(root)        three.js Object3D tree -> { parts, warnings }
//   toThreeObject(parts, THREE)  Crucible parts -> { object, warnings }, a Group of Mesh + MeshStandardMaterial
// It imports neither three.js nor Crucible. It reads three.js objects by their shape (matrixWorld, geometry.attributes,
// material fields) and builds three.js objects from the THREE namespace you pass in. For a GLB, give the parts to
// exportGlb() from Crucible.
// Anything it cannot map is listed in `warnings`; a custom shader or a skinned mesh without bones throws.

const DEFAULT_LIMITS = Object.freeze({ maxParts: 10000, maxVertices: 4000000 });
const HARD_LIMITS = Object.freeze({ maxParts: 100000, maxVertices: 20000000 });
const NORMAL_TOLERANCE = 1e-6;

// three.js wrap constants -> the GL constants a Crucible texture descriptor uses.
const GL_WRAP = Object.freeze({ 1000: 10497, 1001: 33071, 1002: 33648 });
const THREE_WRAP_NAMES = Object.freeze({ 10497: 'RepeatWrapping', 33071: 'ClampToEdgeWrapping', 33648: 'MirroredRepeatWrapping' });
const DOUBLE_SIDE = 2;
const BACK_SIDE = 1;

// three.js physical field -> Crucible material field, with the three.js default that means "not set".
const LAYER_FIELDS = Object.freeze([
  ['clearcoat', 'clearcoat', 0],
  ['clearcoatRoughness', 'clearcoatRoughness', 0],
  ['transmission', 'transmission', 0],
  ['thickness', 'thickness', 0],
  ['ior', 'ior', 1.5],
  ['specularIntensity', 'specular', 1],
]);

// Properties that three.js has and a Crucible material cannot show, checked on every material.
const UNSUPPORTED_MATERIAL_PROPERTIES = Object.freeze({
  envMap: 'Pass the image based light to CrucibleRenderer with createEnvironmentMap().',
  bumpMap: 'Convert it to a normal map.',
  displacementMap: 'Model the relief in the geometry.',
  alphaMap: 'Put the alpha in the alpha channel of the base colour map.',
  lightMap: 'Bake the light into the base colour map or use the Crucible light bake.',
  wireframe: 'Crucible has no wireframe view.',
  flatShading: 'Give the geometry split vertices.',
});

const SHADER_MATERIALS = ['isShaderMaterial', 'isRawShaderMaterial'];

class ThreeBridgeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ThreeBridgeError';
  }
}

function describe(object) {
  return `${object.type ?? 'Object3D'} "${object.name || '(unnamed)'}"`;
}

function resolveLimits(options) {
  const known = [...Object.keys(DEFAULT_LIMITS), 'skipUnsupported'];
  for (const key of Object.keys(options)) {
    if (!known.includes(key)) throw new ThreeBridgeError(`Unknown option "${key}". Pass ${known.join(', ')}.`);
  }
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (options[key] === undefined) continue;
    if (!Number.isInteger(options[key]) || options[key] < 1 || options[key] > HARD_LIMITS[key]) {
      throw new ThreeBridgeError(`Option ${key} must be a whole number from 1 to ${HARD_LIMITS[key]}, not ${options[key]}.`);
    }
    limits[key] = options[key];
  }
  limits.skipUnsupported = options.skipUnsupported === true;
  return limits;
}

function multiply(left, right) {
  const product = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) product[column * 4 + row] += left[k * 4 + row] * right[column * 4 + k];
    }
  }
  return product;
}

// ---------------------------------------------------------------- import

function readAttribute(attribute, itemSize, count, label) {
  if (attribute.itemSize < itemSize) {
    throw new ThreeBridgeError(`${label} has ${attribute.itemSize} values per vertex, ${itemSize} are needed. Pass an attribute with itemSize ${itemSize}.`);
  }
  const values = new Float32Array(count * itemSize);
  const getters = ['getX', 'getY', 'getZ'].slice(0, itemSize);
  for (let vertex = 0; vertex < count; vertex += 1) {
    getters.forEach((getter, component) => {
      values[vertex * itemSize + component] = attribute[getter](vertex);
    });
  }
  return values;
}

function smoothNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let corner = 0; corner < indices.length; corner += 3) {
    const [a, b, c] = [indices[corner] * 3, indices[corner + 1] * 3, indices[corner + 2] * 3];
    const edgeOne = [0, 1, 2].map(axis => positions[b + axis] - positions[a + axis]);
    const edgeTwo = [0, 1, 2].map(axis => positions[c + axis] - positions[a + axis]);
    const face = [
      edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1],
      edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2],
      edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0],
    ];
    for (const vertex of [a, b, c]) face.forEach((value, axis) => { normals[vertex + axis] += value; });
  }
  return normals;
}

function normalizeNormals(normals, fallbackAxis = 1) {
  let changed = false;
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
    if (Math.abs(length - 1) <= NORMAL_TOLERANCE) continue;
    changed = true;
    if (length === 0) {
      normals[offset + fallbackAxis] = 1;
    } else {
      for (let axis = 0; axis < 3; axis += 1) normals[offset + axis] /= length;
    }
  }
  return changed;
}

function readIndices(geometry, count, object, limits) {
  const source = geometry.index;
  const length = source ? source.count : count;
  if (length < 3 || length % 3 !== 0) {
    throw new ThreeBridgeError(`${describe(object)} geometry.${source ? 'index' : 'attributes.position'} holds ${length} entries, which is not whole triangles. Pass triangle geometry.`);
  }
  if (length > limits.maxVertices * 3) throw new ThreeBridgeError(`${describe(object)} geometry has ${length} indices, above the limit of ${limits.maxVertices * 3}. Raise maxVertices or simplify the mesh.`);
  const indices = new Uint32Array(length);
  for (let entry = 0; entry < length; entry += 1) indices[entry] = source ? source.getX(entry) : entry;
  return indices;
}

function importGeometry(object, useVertexColors, limits, state) {
  const { geometry } = object;
  const position = geometry?.attributes?.position;
  if (!position) throw new ThreeBridgeError(`${describe(object)} has no geometry.attributes.position. Pass a BufferGeometry with a position attribute.`);
  if (position.count > limits.maxVertices) throw new ThreeBridgeError(`${describe(object)} geometry has ${position.count} vertices, above the limit of ${limits.maxVertices}. Raise maxVertices or simplify the mesh.`);
  state.vertices += position.count;
  if (state.vertices > limits.maxVertices * 4) throw new ThreeBridgeError(`The tree holds more than ${limits.maxVertices * 4} vertices in total. Raise maxVertices or import fewer objects.`);
  const positions = readAttribute(position, 3, position.count, `${describe(object)} geometry.attributes.position`);
  const indices = readIndices(geometry, position.count, object, limits);
  for (const index of indices) {
    if (index >= position.count) throw new ThreeBridgeError(`${describe(object)} geometry.index points at vertex ${index} but there are ${position.count}. Fix the index.`);
  }
  let normals;
  if (geometry.attributes.normal) {
    normals = readAttribute(geometry.attributes.normal, 3, position.count, `${describe(object)} geometry.attributes.normal`);
  } else {
    normals = smoothNormals(positions, indices);
    state.warnings.push(`${describe(object)}: geometry has no normal attribute, smooth normals were computed.`);
  }
  if (normalizeNormals(normals)) state.warnings.push(`${describe(object)}: normals were not unit length and were normalized.`);
  const imported = { positions, normals, indices };
  if (geometry.attributes.uv) imported.uvs = readAttribute(geometry.attributes.uv, 2, position.count, `${describe(object)} geometry.attributes.uv`);
  if (useVertexColors && geometry.attributes.color) {
    const colors = geometry.attributes.color;
    imported.colors = readAttribute(colors, 3, position.count, `${describe(object)} geometry.attributes.color`);
    if (colors.itemSize === 4) state.warnings.push(`${describe(object)}: vertex colour alpha is ignored.`);
  }
  if (geometry.morphAttributes && Object.keys(geometry.morphAttributes).length > 0) {
    state.warnings.push(`${describe(object)}: morph targets are not imported.`);
  }
  if (geometry.drawRange && (geometry.drawRange.start !== 0 || Number.isFinite(geometry.drawRange.count))) {
    state.warnings.push(`${describe(object)}: geometry.drawRange is ignored, every triangle is imported.`);
  }
  return imported;
}

function importTexture(texture, colorSpace, label, state) {
  if (!texture.image) throw new ThreeBridgeError(`${label} has no image yet. Wait until the texture has loaded before importing.`);
  const moved = texture.repeat && (texture.repeat.x !== 1 || texture.repeat.y !== 1);
  const offset = texture.offset && (texture.offset.x !== 0 || texture.offset.y !== 0);
  if (moved || offset || texture.rotation) state.warnings.push(`${label}: texture repeat, offset and rotation are not applied.`);
  return {
    image: texture.image,
    colorSpace,
    flipY: texture.flipY === true,
    wrapS: GL_WRAP[texture.wrapS] ?? 10497,
    wrapT: GL_WRAP[texture.wrapT] ?? 10497,
  };
}

function importMaterial(material, owner, state) {
  const label = `${describe(owner)} material "${material.name || material.type}"`;
  if (SHADER_MATERIALS.some(flag => material[flag])) {
    throw new ThreeBridgeError(`${label} is a ${material.type}, which Crucible cannot run. Replace it with MeshStandardMaterial, or pass skipUnsupported: true to leave the object out.`);
  }
  if (!material.isMeshStandardMaterial) {
    state.warnings.push(`${label}: ${material.type} has no roughness or metalness, so only its colour, map and opacity are used.`);
  }
  for (const [property, advice] of Object.entries(UNSUPPORTED_MATERIAL_PROPERTIES)) {
    if (material[property]) state.warnings.push(`${label}: ${property} is not imported. ${advice}`);
  }
  if (material.side === BACK_SIDE) state.warnings.push(`${label}: BackSide is imported as front side.`);
  const result = {
    color: [material.color?.r ?? 1, material.color?.g ?? 1, material.color?.b ?? 1],
    metallic: material.metalness ?? 0,
    roughness: material.roughness ?? 1,
  };
  const emissive = material.emissive;
  if (emissive && emissive.r + emissive.g + emissive.b > 0) {
    result.emission = material.emissiveIntensity ?? 1;
    result.emissiveColor = [emissive.r, emissive.g, emissive.b];
  }
  if (material.map) result.map = importTexture(material.map, 'srgb', `${label} map`, state);
  if (material.normalMap) {
    result.normalMap = importTexture(material.normalMap, 'linear', `${label} normalMap`, state);
    result.normalScale = material.normalScale?.x ?? 1;
  }
  if (material.aoMap) {
    result.occlusionMap = importTexture(material.aoMap, 'linear', `${label} aoMap`, state);
    result.occlusionStrength = material.aoMapIntensity ?? 1;
  }
  if (material.emissiveMap) result.emissiveMap = importTexture(material.emissiveMap, 'srgb', `${label} emissiveMap`, state);
  if (material.roughnessMap && material.roughnessMap === material.metalnessMap) {
    result.metallicRoughnessMap = importTexture(material.roughnessMap, 'linear', `${label} roughnessMap`, state);
  } else if (material.roughnessMap || material.metalnessMap) {
    state.warnings.push(`${label}: roughnessMap and metalnessMap are imported only when they are the same texture (glTF packs them in one image).`);
  }
  for (const [threeField, field, defaultValue] of LAYER_FIELDS) {
    if (material[threeField] !== undefined && material[threeField] !== defaultValue) result[field] = material[threeField];
  }
  if (material.sheen || material.iridescence || material.anisotropy) {
    state.warnings.push(`${label}: sheen, iridescence and anisotropy are not imported.`);
  }
  if (material.alphaTest > 0) {
    result.alphaMode = 'mask';
    result.alphaCutoff = material.alphaTest;
  } else if (material.transparent) {
    result.alphaMode = 'blend';
  }
  if (material.opacity !== undefined && material.opacity !== 1) result.opacity = material.opacity;
  if (material.side === DOUBLE_SIDE) result.doubleSided = true;
  return result;
}

function checkMesh(object, state) {
  if (object.isSkinnedMesh) {
    if (!object.skeleton?.bones?.length) {
      throw new ThreeBridgeError(`${describe(object)} is a SkinnedMesh without skeleton.bones. Bind a Skeleton first, or pass skipUnsupported: true to leave it out.`);
    }
    state.warnings.push(`${describe(object)}: skinning is not imported, the mesh is imported in its current pose.`);
  }
  if (object.isInstancedMesh && object.instanceColor) {
    state.warnings.push(`${describe(object)}: instanceColor is not imported.`);
  }
}

function uniqueName(object, fallback, state) {
  const base = object.name || fallback;
  let name = base;
  for (let copy = 1; state.names.has(name); copy += 1) name = `${base}-${copy}`;
  state.names.add(name);
  return name;
}

function importMesh(object, limits, state) {
  checkMesh(object, state);
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  const groups = Array.isArray(object.material) ? object.geometry.groups : [{ start: 0, count: Infinity, materialIndex: 0 }];
  if (!groups?.length) {
    throw new ThreeBridgeError(`${describe(object)} has a material array but geometry.groups is empty. Add groups with geometry.addGroup(start, count, materialIndex), or pass one material.`);
  }
  const instances = object.isInstancedMesh ? object.count : 1;
  if (state.parts.length + instances * groups.length > limits.maxParts) {
    throw new ThreeBridgeError(`${describe(object)} would take the tree past ${limits.maxParts} parts (${instances} instances x ${groups.length} materials). Raise maxParts (up to ${HARD_LIMITS.maxParts}) or import fewer instances.`);
  }
  const cacheKey = materials.some(material => material.vertexColors);
  const cached = state.geometries.get(object.geometry) ?? new Map();
  if (!cached.has(cacheKey)) cached.set(cacheKey, importGeometry(object, cacheKey, limits, state));
  state.geometries.set(object.geometry, cached);
  const whole = cached.get(cacheKey);
  const matrices = object.isInstancedMesh
    ? Array.from({ length: object.count }, (_, instance) => multiply(object.matrixWorld.elements, Array.from(object.instanceMatrix.array.subarray(instance * 16, instance * 16 + 16))))
    : [Array.from(object.matrixWorld.elements)];
  const found = [];
  for (const group of groups) {
    const material = materials[group.materialIndex];
    if (!material) throw new ThreeBridgeError(`${describe(object)} geometry.groups uses materialIndex ${group.materialIndex} but the material array has ${materials.length}. Fix the group.`);
    if (!state.materials.has(material)) state.materials.set(material, importMaterial(material, object, state));
    const geometry = Number.isFinite(group.count)
      ? { ...whole, indices: whole.indices.slice(group.start, group.start + group.count) }
      : whole;
    found.push({ geometry, material: state.materials.get(material) });
  }
  for (const matrix of matrices) {
    for (const { geometry, material } of found) {
      if (state.parts.length >= limits.maxParts) {
        throw new ThreeBridgeError(`The tree holds more than ${limits.maxParts} parts. Raise maxParts (up to ${HARD_LIMITS.maxParts}) or import a smaller subtree.`);
      }
      state.parts.push({ name: uniqueName(object, object.isInstancedMesh ? 'instance' : 'mesh', state), geometry, matrix, material });
    }
  }
}

function visit(object, limits, state) {
  if (object.visible === false) {
    state.warnings.push(`${describe(object)}: invisible objects are skipped, with their children.`);
    return;
  }
  if (object.isMesh) {
    try {
      importMesh(object, limits, state);
    } catch (error) {
      if (!limits.skipUnsupported || !(error instanceof ThreeBridgeError)) throw error;
      state.warnings.push(`${error.message} (skipped)`);
    }
  } else if (object.isPoints || object.isLine || object.isSprite) {
    state.warnings.push(`${describe(object)}: Crucible draws triangle meshes only, so this object is skipped.`);
  } else if (object.isLight || object.isCamera) {
    state.warnings.push(`${describe(object)}: lights and cameras are not parts. Set them as Crucible environment and frame fields.`);
  }
  for (const child of object.children ?? []) visit(child, limits, state);
}

/**
 * Walks a three.js Object3D tree and returns `{ parts, warnings }`. Each part is a Crucible part
 * `{ name, geometry, matrix, material }` with the world matrix of its mesh. Meshes that share a BufferGeometry share one
 * geometry object, so the renderer batches them. Options: `maxParts`, `maxVertices`, `skipUnsupported`.
 */
export function fromThreeObject(root, options = {}) {
  if (!root || typeof root !== 'object' || !Array.isArray(root.children)) {
    throw new ThreeBridgeError('fromThreeObject needs a three.js Object3D, such as a Group or a Scene. Pass the root of the tree you want to import.');
  }
  const limits = resolveLimits(options);
  root.updateWorldMatrix?.(true, true);
  const state = { parts: [], warnings: [], names: new Set(), geometries: new Map(), materials: new Map(), vertices: 0 };
  visit(root, limits, state);
  return { parts: state.parts, warnings: state.warnings };
}

// ---------------------------------------------------------------- export

function requireNamespace(THREE) {
  for (const name of ['Group', 'Mesh', 'BufferGeometry', 'BufferAttribute', 'MeshStandardMaterial']) {
    if (typeof THREE?.[name] !== 'function') {
      throw new ThreeBridgeError(`toThreeObject needs the three.js namespace as its second argument, with ${name}. Pass import * as THREE from 'three'.`);
    }
  }
}

function checkPart(part, index, limits) {
  const label = `parts[${index}]${part?.name ? ` "${part.name}"` : ''}`;
  const geometry = part?.geometry;
  if (!geometry?.positions || geometry.positions.length < 9 || geometry.positions.length % 3 !== 0) {
    throw new ThreeBridgeError(`${label} needs geometry.positions with XYZ triples for at least one triangle.`);
  }
  if (geometry.positions.length / 3 > limits.maxVertices) {
    throw new ThreeBridgeError(`${label} has ${geometry.positions.length / 3} vertices, above the limit of ${limits.maxVertices}. Raise maxVertices.`);
  }
  if (!geometry.indices || geometry.indices.length === 0 || geometry.indices.length % 3 !== 0) {
    throw new ThreeBridgeError(`${label} needs geometry.indices holding whole triangles (a Uint32Array).`);
  }
  if (part.matrix?.length !== 16 || Array.from(part.matrix).some(value => !Number.isFinite(value))) {
    throw new ThreeBridgeError(`${label} needs a matrix of 16 finite numbers (column-major).`);
  }
  if (!part.material || typeof part.material !== 'object') throw new ThreeBridgeError(`${label} needs a material object { color, metallic, roughness }.`);
  return label;
}

function buildGeometry(THREE, geometry) {
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(geometry.positions), 3));
  if (geometry.normals) result.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(geometry.normals), 3));
  if (geometry.uvs) result.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(geometry.uvs), 2));
  if (geometry.colors) result.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(geometry.colors), 3));
  result.setIndex(new THREE.BufferAttribute(Uint32Array.from(geometry.indices), 1));
  return result;
}

function buildTexture(THREE, descriptor, label, state) {
  if (!state.textures.has(descriptor)) {
    if (typeof THREE.Texture !== 'function') throw new ThreeBridgeError(`${label} has a texture but the THREE namespace has no Texture. Pass import * as THREE from 'three'.`);
    const texture = new THREE.Texture(descriptor.image);
    texture.colorSpace = descriptor.colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.flipY = descriptor.flipY === true;
    texture.wrapS = THREE[THREE_WRAP_NAMES[descriptor.wrapS]] ?? THREE.RepeatWrapping;
    texture.wrapT = THREE[THREE_WRAP_NAMES[descriptor.wrapT]] ?? THREE.RepeatWrapping;
    texture.needsUpdate = true;
    state.textures.set(descriptor, texture);
  }
  return state.textures.get(descriptor);
}

function buildMaterial(THREE, source, label, state) {
  const usesLayers = LAYER_FIELDS.some(([, field]) => source[field] !== undefined);
  const MaterialClass = usesLayers && typeof THREE.MeshPhysicalMaterial === 'function' ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  if (usesLayers && MaterialClass === THREE.MeshStandardMaterial) state.warnings.push(`${label}: the THREE namespace has no MeshPhysicalMaterial, so clearcoat, transmission and ior are dropped.`);
  const material = new MaterialClass();
  material.color.setRGB(...source.color);
  material.metalness = source.metallic ?? 0;
  material.roughness = source.roughness ?? 1;
  if ((source.emission ?? 0) > 0) {
    material.emissive.setRGB(...(source.emissiveColor ?? source.color));
    material.emissiveIntensity = source.emission;
  }
  const maps = { map: 'map', normalMap: 'normalMap', occlusionMap: 'aoMap', emissiveMap: 'emissiveMap' };
  for (const [field, threeField] of Object.entries(maps)) {
    if (source[field]) material[threeField] = buildTexture(THREE, source[field], `${label} ${field}`, state);
  }
  if (source.metallicRoughnessMap) {
    material.roughnessMap = buildTexture(THREE, source.metallicRoughnessMap, `${label} metallicRoughnessMap`, state);
    material.metalnessMap = material.roughnessMap;
  }
  if (source.normalScale !== undefined) material.normalScale.set(source.normalScale, source.normalScale);
  if (source.occlusionStrength !== undefined) material.aoMapIntensity = source.occlusionStrength;
  if (MaterialClass !== THREE.MeshStandardMaterial) {
    for (const [threeField, field] of LAYER_FIELDS) {
      if (source[field] !== undefined) material[threeField] = source[field];
    }
  }
  if (source.alphaMode === 'mask') {
    material.alphaTest = source.alphaCutoff ?? 0.5;
  } else if (source.alphaMode === 'blend' || source.alphaMode === 'add') {
    material.transparent = true;
    if (source.alphaMode === 'add' && THREE.AdditiveBlending !== undefined) material.blending = THREE.AdditiveBlending;
  }
  if (source.opacity !== undefined) material.opacity = source.opacity;
  if (source.doubleSided) material.side = THREE.DoubleSide ?? DOUBLE_SIDE;
  return material;
}

/**
 * Builds a Group of Mesh objects from Crucible parts and returns `{ object, warnings }`. THREE is the namespace of three.js
 * (`import * as THREE from 'three'`). Parts that share a geometry object share a BufferGeometry, and parts that share a
 * material object share a material. Each mesh takes its part matrix as is (`matrixAutoUpdate` is off), so the world
 * matrix matches the part exactly; copy `mesh.matrix` into position, quaternion and scale to animate it.
 * Options: `maxParts`, `maxVertices`, `name` of the group.
 */
export function toThreeObject(parts, THREE, options = {}) {
  requireNamespace(THREE);
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new ThreeBridgeError('toThreeObject needs a nonempty array of Crucible parts. Pass the parts of a scene, such as the parts of fromThreeObject().');
  }
  const { name = 'parts', ...limitOptions } = options;
  const limits = resolveLimits(limitOptions);
  if (parts.length > limits.maxParts) throw new ThreeBridgeError(`${parts.length} parts is above the limit of ${limits.maxParts}. Raise maxParts (up to ${HARD_LIMITS.maxParts}) or pass fewer parts.`);
  const state = { warnings: [], textures: new Map() };
  const geometries = new Map();
  const materials = new Map();
  const group = new THREE.Group();
  group.name = name;
  parts.forEach((part, index) => {
    const label = checkPart(part, index, limits);
    if (part.skin || part.morph) state.warnings.push(`${label}: skin and morph targets are not exported to three.js objects.`);
    if (!geometries.has(part.geometry)) geometries.set(part.geometry, buildGeometry(THREE, part.geometry));
    if (!materials.has(part.material)) materials.set(part.material, buildMaterial(THREE, part.material, label, state));
    const mesh = new THREE.Mesh(geometries.get(part.geometry), materials.get(part.material));
    mesh.name = part.name ?? `part-${index}`;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.fromArray(Array.from(part.matrix));
    mesh.castShadow = part.castShadow !== false;
    mesh.receiveShadow = true;
    group.add(mesh);
  });
  group.updateMatrixWorld(true);
  return { object: group, warnings: state.warnings };
}
