// The camera crop behind scripts/build-hero-first-view.mjs: keeps only the triangles the camera sees during the first seconds of a
// hero flight, and gives each distance band its own simplification, so what the camera passes close keeps its detail while the far
// yard is drawn with a fraction of its triangles. Nothing is read from the network.
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { SCENES } from '../src/hero-lab/loop/scenes.js';
import { createCameraSpline } from '../src/hero-lab/camera-spline.js';

const POSE_SAMPLES = 60;
const UNUSED = 0xffffffff;
const MINIMUM_INDEX_COUNT = 36;

export const CROP_DEFAULTS = {
  flightSeconds: 5,
  // Upper edges (metres from the nearest camera pose) of the distance bands; the last band has no edge.
  bandEdges: [100, 170, 260, 400, 650],
  nearPixels: 3,
  farPixels: 6,
  farFrom: 400,
  height: 900,
  aspect: 2.2,
  margin: 1.1,
};

// The camera poses of the flight from 0 to flightSeconds, with the basis of each one.
export function sampleFlightPoses(sceneId, flightSeconds) {
  const scene = SCENES.find(entry => entry.id === sceneId);
  if (!scene) throw new Error(`No scene ${sceneId} in scenes.js.`);
  const route = createCameraSpline(scene.keys);
  const poses = [];
  for (let index = 0; index <= POSE_SAMPLES; index++) {
    const seconds = (index / POSE_SAMPLES) * flightSeconds;
    const pose = route(seconds / scene.seconds);
    poses.push(poseWithBasis(pose));
  }
  return poses;
}

function poseWithBasis(pose) {
  const forward = normalized(subtract(pose.target, pose.eye));
  const right = normalized(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  return { eye: pose.eye, forward, right, up, tanVertical: Math.tan((pose.fov * Math.PI) / 360) };
}

function subtract(left, right) {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function dot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left, right) {
  return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
}

function normalized(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

// Nearest distance from the camera poses to a sphere that any of them sees; Infinity when none does.
export function nearestVisibleDistance(poses, center, radius, options) {
  let nearest = Infinity;
  for (const pose of poses) {
    const relative = subtract(center, pose.eye);
    const depth = dot(relative, pose.forward);
    if (depth + radius < 0) continue;
    const tanVertical = pose.tanVertical * options.margin;
    const tanHorizontal = tanVertical * options.aspect;
    const sideSlack = radius * Math.sqrt(1 + tanHorizontal * tanHorizontal);
    const upSlack = radius * Math.sqrt(1 + tanVertical * tanVertical);
    if (Math.abs(dot(relative, pose.right)) > tanHorizontal * depth + sideSlack) continue;
    if (Math.abs(dot(relative, pose.up)) > tanVertical * depth + upSlack) continue;
    nearest = Math.min(nearest, Math.max(0, Math.hypot(relative[0], relative[1], relative[2]) - radius));
  }
  return nearest;
}

function bandOf(distance, edges) {
  let band = 0;
  while (band < edges.length && distance >= edges[band]) band++;
  return band;
}

function worldPoint(matrix, array, vertex) {
  const x = array[vertex * 3];
  const y = array[vertex * 3 + 1];
  const z = array[vertex * 3 + 2];
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function largestScale(matrix) {
  return Math.max(Math.hypot(matrix[0], matrix[1], matrix[2]), Math.hypot(matrix[4], matrix[5], matrix[6]), Math.hypot(matrix[8], matrix[9], matrix[10]));
}

// Per-vertex texture coordinates and normals, so the simplifier does not smear a texture atlas or fold a surface it must keep.
function attributesFor(primitive) {
  const coordinates = primitive.getAttribute('TEXCOORD_0');
  const normals = primitive.getAttribute('NORMAL');
  if (!coordinates || !normals) return null;
  const count = coordinates.getCount();
  const values = new Float32Array(count * 5);
  const element = [0, 0, 0];
  for (let index = 0; index < count; index++) {
    coordinates.getElement(index, element);
    values[index * 5] = element[0];
    values[index * 5 + 1] = element[1];
    normals.getElement(index, element);
    values.set(element, index * 5 + 2);
  }
  return { values, weights: [1, 1, 0.5, 0.5, 0.5] };
}

function simplifyBand(indices, positions, attributes, absoluteError) {
  if (indices.length <= MINIMUM_INDEX_COUNT) return indices;
  const target = MINIMUM_INDEX_COUNT;
  const flags = ['LockBorder', 'ErrorAbsolute', 'Permissive', 'Sparse'];
  const [reduced] = attributes
    ? MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, attributes.values, 5, attributes.weights, null, target, absoluteError, flags)
    : MeshoptSimplifier.simplify(indices, positions, 3, target, absoluteError, flags);
  return reduced;
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

function bandError(band, options, metresPerPixelAtOneMetre) {
  const edges = options.bandEdges;
  const lowerEdge = band === 0 ? 0 : edges[band - 1];
  const pixels = lowerEdge >= options.farFrom ? options.farPixels : options.nearPixels;
  return pixels * Math.max(lowerEdge, 30) * metresPerPixelAtOneMetre;
}

// Crops and simplifies one primitive in place. Returns what it kept: triangles per band and the nearest distance seen.
export function cropPrimitive(document, node, primitive, poses, options, metresPerPixelAtOneMetre) {
  const source = primitive.getIndices().getArray();
  const raw = primitive.getAttribute('POSITION').getArray();
  const matrix = node.getWorldMatrix();
  const scale = largestScale(matrix);
  const bandIndices = Array.from({ length: options.bandEdges.length + 1 }, () => []);
  let nearest = Infinity;
  for (let triangle = 0; triangle < source.length; triangle += 3) {
    const corners = [0, 1, 2].map(corner => worldPoint(matrix, raw, source[triangle + corner]));
    const center = [0, 1, 2].map(axis => (corners[0][axis] + corners[1][axis] + corners[2][axis]) / 3);
    const radius = Math.max(...corners.map(corner => Math.hypot(corner[0] - center[0], corner[1] - center[1], corner[2] - center[2])));
    const distance = nearestVisibleDistance(poses, center, radius, options);
    if (distance === Infinity) continue;
    nearest = Math.min(nearest, distance);
    bandIndices[bandOf(distance, options.bandEdges)].push(source[triangle], source[triangle + 1], source[triangle + 2]);
  }
  const positions = Float32Array.from(raw);
  const attributes = attributesFor(primitive);
  const kept = [];
  const triangles = [];
  bandIndices.forEach((indices, band) => {
    const reduced = simplifyBand(Uint32Array.from(indices), positions, attributes, bandError(band, options, metresPerPixelAtOneMetre) / scale);
    triangles.push(reduced.length / 3);
    for (const index of reduced) kept.push(index);
  });
  if (kept.length === 0) return { empty: true, triangles, nearest };
  const finalIndices = Uint32Array.from(kept);
  const [remap, unique] = MeshoptSimplifier.compactMesh(finalIndices);
  for (const semantic of primitive.listSemantics()) {
    primitive.setAttribute(semantic, pickElements(document, primitive.getAttribute(semantic), remap, unique));
  }
  const indexArray = unique <= 65535 ? Uint16Array.from(finalIndices) : finalIndices;
  primitive.setIndices(document.createAccessor().setType('SCALAR').setArray(indexArray));
  return { empty: false, triangles, nearest };
}

// Crops every mesh of the document. Nodes with nothing in view are removed. Returns the nearest distance per material.
export function cropDocument(document, poses, options) {
  const narrowestFov = Math.min(...poses.map(pose => 2 * Math.atan(pose.tanVertical)));
  const metresPerPixelAtOneMetre = (2 * Math.tan(narrowestFov / 2)) / options.height;
  const nearestByMaterial = new Map();
  const totals = new Array(options.bandEdges.length + 1).fill(0);
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const primitive of mesh.listPrimitives()) {
      const result = cropPrimitive(document, node, primitive, poses, options, metresPerPixelAtOneMetre);
      result.triangles.forEach((count, band) => (totals[band] += count));
      if (result.empty) {
        mesh.removePrimitive(primitive);
        primitive.dispose();
        continue;
      }
      const material = primitive.getMaterial();
      nearestByMaterial.set(material, Math.min(nearestByMaterial.get(material) ?? Infinity, result.nearest));
    }
    if (mesh.listPrimitives().length === 0) {
      node.setMesh(null);
      mesh.dispose();
    }
  }
  return { nearestByMaterial, totals };
}

function texturesOf(material) {
  return [material.getBaseColorTexture(), material.getNormalTexture(), material.getOcclusionTexture(), material.getEmissiveTexture(), material.getMetallicRoughnessTexture()].filter(Boolean);
}

// Textures of materials seen from nearer than farFrom keep nearTexture pixels, the rest get farTexture.
export async function scaleTexturesByDistance(document, nearestByMaterial, options) {
  const limits = new Map();
  for (const [material, nearest] of nearestByMaterial) {
    const limit = nearest < options.farFrom ? options.nearTexture : options.farTexture;
    for (const texture of texturesOf(material)) limits.set(texture, Math.max(limits.get(texture) ?? 0, limit));
  }
  for (const [texture, limit] of limits) {
    const [width, height] = texture.getSize() ?? [0, 0];
    if (Math.max(width, height) <= limit) continue;
    const scale = limit / Math.max(width, height);
    const resized = await sharp(Buffer.from(texture.getImage()))
      .resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), { kernel: 'lanczos3' })
      .webp({ quality: options.webpQuality, effort: 6 })
      .toBuffer();
    texture.setImage(new Uint8Array(resized));
    texture.setMimeType('image/webp');
  }
}
