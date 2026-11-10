// Lightens an already prepared hero GLB (meshopt compressed, instanced, WebP) for a camera that flies a known route.
// Every instance gets the coarsest copy of its mesh whose error stays under `--pixels` on screen at the nearest the camera comes
// to it, so a shelf the camera never nears is drawn with a few thousand triangles while one it passes keeps its detail.
// Instanced nodes are split by level (one node per mesh and level), so the page needs no level-of-detail code.
//
//   node scripts/simplify-hero-glb.mjs <scene id> <input.glb> <output.glb> [--pixels 1.2] [--levels 0.0008,0.005,0.025,0.1]
//        [--max-texture 1024] [--prop-texture 512] [--prop-pattern '^m_'] [--webp-quality 78] [--height 900]
//
// The route is read from src/hero-lab/loop/scenes.js, so rerun this after a flight changes.
// --levels         relative errors (share of the mesh's own size) the copies are simplified to; the first is applied to every mesh
// --prop-pattern   materials whose name matches get --prop-texture instead of --max-texture
// Nothing is read from the network and no input script is run.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, EXTMeshGPUInstancing } from '@gltf-transform/extensions';
import { weld, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { SCENES } from '../src/hero-lab/loop/scenes.js';
import { createCameraSpline } from '../src/hero-lab/camera-spline.js';

const DEFAULTS = { pixels: 1.2, levels: '0.0008,0.005,0.025,0.1', maxTexture: 1024, propTexture: 512, propPattern: '^m_', webpQuality: 78, height: 900 };
const ROUTE_SAMPLES = 240;
const MINIMUM_TRIANGLES = 12;
const UNUSED = 0xffffffff;

function parseArguments(argv) {
  const options = { ...DEFAULTS };
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!name.startsWith('--')) {
      positional.push(name);
      continue;
    }
    const key = name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!(key in DEFAULTS)) throw new Error(`Unknown option ${name}.`);
    const raw = argv[++index];
    options[key] = typeof DEFAULTS[key] === 'number' ? Number(raw) : raw;
  }
  if (positional.length !== 3) throw new Error('Pass <scene id>, <input.glb> and <output.glb>.');
  const [sceneId, input, output] = positional;
  return { sceneId, input, output, options, levels: options.levels.split(',').map(Number) };
}

// The camera's eye along the whole flight, plus the narrowest field of view (it asks the most of the meshes).
function sampleRoute(sceneId) {
  const scene = SCENES.find(entry => entry.id === sceneId);
  if (!scene) throw new Error(`No scene ${sceneId} in scenes.js.`);
  const route = createCameraSpline(scene.keys);
  const eyes = [];
  let narrowest = Infinity;
  for (let index = 0; index <= ROUTE_SAMPLES; index++) {
    const pose = route(index / ROUTE_SAMPLES);
    eyes.push(pose.eye);
    narrowest = Math.min(narrowest, pose.fov);
  }
  return { eyes, narrowestFov: narrowest };
}

function distanceToRoute(eyes, point) {
  let nearest = Infinity;
  for (const eye of eyes) nearest = Math.min(nearest, Math.hypot(eye[0] - point[0], eye[1] - point[1], eye[2] - point[2]));
  return nearest;
}

function triangleTotal(document) {
  let total = 0;
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const instancing = node.getExtension('EXT_mesh_gpu_instancing');
    const instances = instancing ? instancing.listAttributes()[0].getCount() : 1;
    for (const primitive of mesh.listPrimitives()) {
      const count = primitive.getIndices()?.getCount() ?? primitive.getAttribute('POSITION').getCount();
      total += (count / 3) * instances;
    }
  }
  return Math.round(total);
}

function positionsOf(accessor) {
  if (!(accessor.getArray() instanceof Float32Array)) throw new Error('Simplifying needs float POSITION data.');
  return Float32Array.from(accessor.getArray());
}

// A new accessor holding the listed source elements (raw values, so normalised data stays encoded). `slots[source]` is the target slot.
function pickElements(document, source, slots, count) {
  const size = source.getElementSize();
  const raw = source.getArray();
  const array = new raw.constructor(count * size);
  for (let index = 0; index < slots.length; index++) {
    if (slots[index] !== UNUSED) array.set(raw.subarray(index * size, (index + 1) * size), slots[index] * size);
  }
  return document.createAccessor().setType(source.getType()).setNormalized(source.getNormalized()).setArray(array);
}

// A copy of one primitive simplified until its error reaches relativeError of its own size; the same primitive when nothing is gained.
function simplifiedPrimitive(document, primitive, relativeError) {
  const indices = primitive.getIndices();
  if (!indices || (primitive.getMode() ?? 4) !== 4 || primitive.listTargets().length) return primitive;
  const source = Uint32Array.from(indices.getArray());
  const [reduced] = MeshoptSimplifier.simplify(source, positionsOf(primitive.getAttribute('POSITION')), 3, Math.min(MINIMUM_TRIANGLES * 3, source.length), relativeError, ['Permissive']);
  if (reduced.length > source.length * 0.97) return primitive;
  const [remap, unique] = MeshoptSimplifier.compactMesh(reduced);
  const copy = document.createPrimitive().setMaterial(primitive.getMaterial()).setMode(4);
  for (const semantic of primitive.listSemantics()) copy.setAttribute(semantic, pickElements(document, primitive.getAttribute(semantic), remap, unique));
  const indexArray = unique <= 65535 ? Uint16Array.from(reduced) : reduced;
  return copy.setIndices(document.createAccessor().setType('SCALAR').setArray(indexArray));
}

function meshDiagonal(mesh) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const primitive of mesh.listPrimitives()) {
    const accessor = primitive.getAttribute('POSITION');
    const minimum = accessor.getMin([0, 0, 0]);
    const maximum = accessor.getMax([0, 0, 0]);
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], minimum[axis]);
      high[axis] = Math.max(high[axis], maximum[axis]);
    }
  }
  return Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]);
}

function transformPoint(matrix, point) {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ];
}

function largestScale(matrix) {
  return Math.max(Math.hypot(matrix[0], matrix[1], matrix[2]), Math.hypot(matrix[4], matrix[5], matrix[6]), Math.hypot(matrix[8], matrix[9], matrix[10]));
}

// The level each instance of a node needs, as one number per instance.
function levelsForInstances(node, eyes, pixelsPerRadian, options, levels) {
  const world = node.getWorldMatrix();
  const instancing = node.getExtension('EXT_mesh_gpu_instancing');
  const count = instancing ? instancing.listAttributes()[0].getCount() : 1;
  const translation = instancing?.getAttribute('TRANSLATION');
  const scaling = instancing?.getAttribute('SCALE');
  const baseSize = meshDiagonal(node.getMesh()) * largestScale(world);
  const chosen = new Uint8Array(count);
  const local = [0, 0, 0];
  const scale = [1, 1, 1];
  for (let index = 0; index < count; index++) {
    if (translation) translation.getElement(index, local);
    if (scaling) scaling.getElement(index, scale);
    const size = Math.max(baseSize * Math.max(scale[0], scale[1], scale[2]), 1e-4);
    const distance = Math.max(0.05, distanceToRoute(eyes, transformPoint(world, local)) - size / 2);
    const tolerable = (options.pixels * distance) / pixelsPerRadian / size;
    let level = 0;
    for (let candidate = 0; candidate < levels.length; candidate++) if (levels[candidate] <= tolerable) level = candidate;
    chosen[index] = level;
  }
  return chosen;
}

function sliceInstancing(document, extension, instancing, members) {
  const instanced = extension.createInstancedMesh();
  for (const semantic of instancing.listSemantics()) {
    const source = instancing.getAttribute(semantic);
    const size = source.getElementSize();
    const raw = source.getArray();
    const array = new raw.constructor(members.length * size);
    members.forEach((instance, slot) => array.set(raw.subarray(instance * size, (instance + 1) * size), slot * size));
    instanced.setAttribute(semantic, document.createAccessor().setType(source.getType()).setNormalized(source.getNormalized()).setArray(array));
  }
  return instanced;
}

function splitNodeByLevel(document, node, chosen, variantOf, extension) {
  const mesh = node.getMesh();
  const instancing = node.getExtension('EXT_mesh_gpu_instancing');
  const groups = new Map();
  chosen.forEach((level, instance) => {
    if (!groups.has(level)) groups.set(level, []);
    groups.get(level).push(instance);
  });
  const created = [];
  for (const [level, members] of groups) {
    const replacement = document.createNode(`${node.getName()}-level${level}`)
      .setTranslation(node.getTranslation()).setRotation(node.getRotation()).setScale(node.getScale())
      .setMesh(variantOf(mesh, level));
    if (instancing) replacement.setExtension('EXT_mesh_gpu_instancing', sliceInstancing(document, extension, instancing, members));
    for (const parent of node.listParents()) if (typeof parent.addChild === 'function') parent.addChild(replacement);
    created.push(replacement);
  }
  node.listChildren().forEach(child => created[0].addChild(child));
  node.setExtension('EXT_mesh_gpu_instancing', null).setMesh(null);
  node.dispose();
}

async function scaleTextures(document, options) {
  const pattern = new RegExp(options.propPattern);
  const propTextures = new Set();
  const largeTextures = new Set();
  for (const material of document.getRoot().listMaterials()) {
    const bucket = pattern.test(material.getName()) ? propTextures : largeTextures;
    for (const texture of [material.getBaseColorTexture(), material.getNormalTexture(), material.getOcclusionTexture(), material.getEmissiveTexture(), material.getMetallicRoughnessTexture()]) {
      if (texture) bucket.add(texture);
    }
  }
  for (const texture of propTextures) if (largeTextures.has(texture)) propTextures.delete(texture);
  for (const [textures, limit] of [[propTextures, options.propTexture], [largeTextures, options.maxTexture]]) {
    for (const texture of textures) {
      const [width, height] = texture.getSize() ?? [0, 0];
      if (Math.max(width, height) <= limit) continue;
      const scale = limit / Math.max(width, height);
      const resized = await sharp(Buffer.from(texture.getImage()))
        .resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), { kernel: 'lanczos3' })
        .webp({ quality: options.webpQuality })
        .toBuffer();
      texture.setImage(new Uint8Array(resized));
      texture.setMimeType('image/webp');
    }
  }
}

const { sceneId, input, output, options, levels } = parseArguments(process.argv.slice(2));
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO()
  .registerExtensions([...ALL_EXTENSIONS, EXTMeshoptCompression])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const document = await io.read(input);
const before = triangleTotal(document);
await document.transform(weld({ tolerance: 0 }));

const { eyes, narrowestFov } = sampleRoute(sceneId);
const pixelsPerRadian = options.height / (2 * Math.tan((narrowestFov * Math.PI) / 360));
const extension = document.createExtension(EXTMeshGPUInstancing);
const variants = new Map();
const meshIndex = new Map(document.getRoot().listMeshes().map((mesh, index) => [mesh, index]));
function variantOf(mesh, level) {
  const key = `${meshIndex.get(mesh)}:${level}`;
  if (!variants.has(key)) {
    const variant = document.createMesh(`${mesh.getName()}-level${level}`);
    mesh.listPrimitives().forEach(primitive => variant.addPrimitive(simplifiedPrimitive(document, primitive, levels[level])));
    variants.set(key, variant);
  }
  return variants.get(key);
}
const levelCounts = new Array(levels.length).fill(0);
for (const node of document.getRoot().listNodes().filter(candidate => candidate.getMesh())) {
  const chosen = levelsForInstances(node, eyes, pixelsPerRadian, options, levels);
  chosen.forEach(level => levelCounts[level]++);
  splitNodeByLevel(document, node, chosen, variantOf, extension);
}
await scaleTextures(document, options);
await document.transform(prune({ keepLeaves: false }));
document.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
await io.write(output, document);
const after = triangleTotal(document);
console.log(`${sceneId}: triangles ${before} -> ${after} (${((after / before) * 100).toFixed(1)}%); instances per level ${levelCounts.join('/')}; meshes ${variants.size}`);
