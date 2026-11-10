import { buildTriangleBvh } from './triangle-bvh.js';
import { createTracer } from './ray-query.js';
import { SUN_BIT, POINT_FIRST_BIT, SPOT_FIRST_BIT, AREA_FIRST_BIT } from './light-link-bits.js';
import { boxProjectedGeometry, columnLengths } from './export-box-uv.js';
import { resolveTraceVolume, prepareMeshVolume } from './path-tracer-volume.js';
import { resolveLocalVolumes } from './local-volumes.js';
import { bindLocalVolumeParts } from './local-volume-parts.js';
import { resolveTraceSubsurface } from './path-tracer-subsurface.js';
import { lightShapeSupport } from './shader-registry.js';
import { flushOrderOf } from './depth-layer.js';

// The scene a path trace reads: every part flattened into one world-space triangle soup with per-vertex normals, UVs
// and colours, one resolved material per part, the lights in plain arrays, and the environment map as a sampling table.

export const MAX_TRACE_TRIANGLES = 400_000;
export const MAX_TRACE_PARTS = 1024;
export const MAX_TRACE_LIGHTS = 32;
// A Blender sun of 1 degree, which is what the reference harness gives Cycles.
export const SUN_ANGULAR_RADIUS = Math.PI / 360;

const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const REPEAT_WRAP = 10497;

function addWeightedTransform(output, offset, palette, joint, weight, x, y, z, translationWeight) {
  const base = joint * 16;
  output[offset] += weight * (palette[base] * x + palette[base + 4] * y + palette[base + 8] * z + palette[base + 12] * translationWeight);
  output[offset + 1] += weight * (palette[base + 1] * x + palette[base + 5] * y + palette[base + 9] * z + palette[base + 13] * translationWeight);
  output[offset + 2] += weight * (palette[base + 2] * x + palette[base + 6] * y + palette[base + 10] * z + palette[base + 14] * translationWeight);
}

/** The geometry of a skinned part at its current pose, as plain positions and normals. */
export function skinnedGeometry(part) {
  const { geometry, skin } = part;
  const vertexCount = geometry.positions.length / 3;
  const positions = new Float32Array(geometry.positions.length);
  const normals = new Float32Array(geometry.normals.length);
  const influenceCount = geometry.skinWeights.length / vertexCount;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * 3;
    for (let influence = 0; influence < influenceCount; influence++) {
      const weight = geometry.skinWeights[vertex * influenceCount + influence];
      if (weight === 0) continue;
      const joint = geometry.skinIndices[vertex * influenceCount + influence];
      addWeightedTransform(positions, offset, skin.jointMatrices, joint, weight, geometry.positions[offset], geometry.positions[offset + 1], geometry.positions[offset + 2], 1);
      addWeightedTransform(normals, offset, skin.jointMatrices, joint, weight, geometry.normals[offset], geometry.normals[offset + 1], geometry.normals[offset + 2], 0);
    }
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]) || 1;
    for (let axis = 0; axis < 3; axis++) normals[offset + axis] /= length;
  }
  return { ...geometry, positions, normals };
}

/** Normal matrix (cofactors of the upper 3x3, signed so that mirrored parts keep outward normals), row major. */
function normalMatrix(matrix) {
  const [a, b, c, , d, e, f, , g, h, i] = matrix;
  const cofactors = [
    e * i - f * h, f * g - d * i, d * h - e * g,
    c * h - b * i, a * i - c * g, b * g - a * h,
    b * f - c * e, c * d - a * f, a * e - b * d,
  ];
  const sign = a * cofactors[0] + b * cofactors[1] + c * cofactors[2] < 0 ? -1 : 1;
  return cofactors.map(value => value * sign);
}

function srgbToLinearTable() {
  const table = new Float32Array(256);
  for (let value = 0; value < 256; value++) {
    const encoded = value / 255;
    table[value] = encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  }
  return table;
}

const SRGB_TO_LINEAR = srgbToLinearTable();

// Pixels read back from browser images, kept per image so parts that share a texture read it once.
const drawablePixels = new WeakMap();

/**
 * RGBA8 pixels of a texture image: its own `data`, or, for a decoded glTF texture (an ImageBitmap, an image element or a
 * canvas), the pixels read back through a 2D canvas. GPU-compressed images and runtimes without a canvas give null.
 */
export function texturePixels(image, createCanvas = defaultCanvas) {
  if (!image?.width || !image.height) return null;
  if (image.data) return image.data;
  if (image.compressed || typeof image !== 'object') return null;
  if (drawablePixels.has(image)) return drawablePixels.get(image);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas?.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  drawablePixels.set(image, pixels);
  return pixels;
}

function defaultCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = globalThis.document?.createElement('canvas');
  if (!canvas) return null;
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function resolveTexture(descriptor) {
  const image = descriptor?.image;
  const data = texturePixels(image);
  if (!data) return null;
  return {
    width: image.width,
    height: image.height,
    data,
    colorLookup: descriptor.colorSpace === 'linear' ? null : SRGB_TO_LINEAR,
    // A map without a wrap mode repeats: the rasteriser and glTF both default to repeat.
    repeat: (descriptor.wrapS ?? REPEAT_WRAP) === REPEAT_WRAP,
  };
}

// A part without a mask is lit by every light.
const ALL_LIGHTS = -1;

// A graph opacity output is texture alpha on a blended material. The tracer has no blending, so it cuts out at half.
function graphOpacityCutoff(material) {
  const graph = material.pattern?.type === 'graph' ? material.pattern.graph : null;
  return material.alphaMode === 'blend' && graph && Object.hasOwn(graph, 'opacity') ? 0.5 : 0;
}

function resolveMaterial(material) {
  const emissionColor = material.emissiveColor ?? material.color;
  const emissionStrength = material.emission ?? 0;
  return {
    color: material.color ?? [1, 1, 1],
    metallic: material.metallic ?? 0,
    roughness: material.roughness ?? 0.5,
    emission: emissionColor.map(channel => channel * emissionStrength),
    emissiveTexture: emissionStrength > 0 ? resolveTexture(material.emissiveMap) : null,
    clearcoat: material.clearcoat ?? 0,
    clearcoatTexture: resolveTexture(material.layerMaps?.clearcoatTexture),
    transmissionTexture: resolveTexture(material.transmissionMap),
    clearcoatRoughness: material.clearcoatRoughness ?? 0,
    transmission: material.transmission ?? 0,
    subsurface: resolveTraceSubsurface(material.subsurface),
    ior: material.ior ?? 1.5,
    texture: resolveTexture(material.map),
    normalTexture: resolveTexture(material.normalMap),
    normalScale: material.normalScale ?? [1, 1],
    surfaceTexture: resolveTexture(material.metallicRoughnessMap),
    lightMask: material.lightMask ?? ALL_LIGHTS,
    alphaCutoff: material.alphaMode === 'mask' ? material.alphaCutoff ?? 0.5 : graphOpacityCutoff(material),
  };
}

function requireFiniteNumbers(values, expectedLength, label) {
  if (!values || (expectedLength !== undefined && values.length !== expectedLength)) throw new TypeError(`${label} must hold ${expectedLength} numbers.`);
  for (let index = 0; index < values.length; index++) {
    if (!Number.isFinite(values[index])) throw new RangeError(`${label} must be finite numbers.`);
  }
}

function validatePart(part, geometry) {
  const label = `Part ${part.name ?? ''}`.trim();
  requireFiniteNumbers(part.matrix ?? IDENTITY_MATRIX, 16, `${label} matrix`);
  requireFiniteNumbers(geometry.positions, undefined, `${label} positions`);
  if (geometry.positions.length % 3 !== 0 || geometry.indices.length % 3 !== 0) throw new RangeError(`${label} positions and indices must come in threes.`);
  const vertexCount = geometry.positions.length / 3;
  if (geometry.normals?.length !== geometry.positions.length) throw new RangeError(`${label} needs one normal for every position.`);
  requireFiniteNumbers(geometry.normals, undefined, `${label} normals`);
  for (let slot = 0; slot < geometry.indices.length; slot++) {
    if (!(geometry.indices[slot] < vertexCount)) throw new RangeError(`${label} has an index past its last vertex.`);
  }
  if (geometry.uvs && geometry.uvs.length !== vertexCount * 2) throw new RangeError(`${label} needs one UV pair for every position.`);
  if (geometry.colors && geometry.colors.length !== vertexCount * 3) throw new RangeError(`${label} needs one colour for every position.`);
}

/**
 * The geometry a part is traced with. A box-projected material has no UVs, so it gets the UVs of its projection (the
 * ones the glTF export writes), and every map then reads them like those of an authored material.
 */
function traceGeometry(part) {
  // Faces hidden under a face on the same plane are cut away for the rasteriser (flush-resolve.js); rays get the same
  // geometry, or the two faces would split the hits between them.
  const geometry = part.skin ? skinnedGeometry(part) : flushOrderOf(part)?.geometry ?? part.geometry;
  const { boxMapScale = 0, boxMapAxis = 1 } = part.material ?? {};
  if (!(boxMapScale > 0)) return geometry;
  return boxProjectedGeometry(geometry, columnLengths(part.matrix ?? IDENTITY_MATRIX), boxMapScale, boxMapAxis);
}

function flattenParts(parts) {
  let vertexTotal = 0;
  let indexTotal = 0;
  const geometries = parts.map(traceGeometry);
  parts.forEach((part, index) => validatePart(part, geometries[index]));
  for (const geometry of geometries) {
    vertexTotal += geometry.positions.length / 3;
    indexTotal += geometry.indices.length;
  }
  if (indexTotal / 3 > MAX_TRACE_TRIANGLES) throw new RangeError(`A path trace takes at most ${MAX_TRACE_TRIANGLES} triangles in total.`);
  const world = {
    positions: new Float32Array(vertexTotal * 3),
    normals: new Float32Array(vertexTotal * 3),
    uvs: new Float32Array(vertexTotal * 2),
    colors: new Float32Array(vertexTotal * 3).fill(1),
    indices: new Uint32Array(indexTotal),
    triangleMaterial: new Uint32Array(indexTotal / 3),
  };
  let vertexOffset = 0;
  let triangleOffset = 0;
  parts.forEach((part, partIndex) => {
    const geometry = geometries[partIndex];
    const matrix = part.matrix ?? IDENTITY_MATRIX;
    const normals = normalMatrix(matrix);
    const vertexCount = geometry.positions.length / 3;
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const x = geometry.positions[vertex * 3];
      const y = geometry.positions[vertex * 3 + 1];
      const z = geometry.positions[vertex * 3 + 2];
      const target = (vertexOffset + vertex) * 3;
      world.positions[target] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      world.positions[target + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      world.positions[target + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
      const normalX = geometry.normals[vertex * 3];
      const normalY = geometry.normals[vertex * 3 + 1];
      const normalZ = geometry.normals[vertex * 3 + 2];
      const worldX = normals[0] * normalX + normals[3] * normalY + normals[6] * normalZ;
      const worldY = normals[1] * normalX + normals[4] * normalY + normals[7] * normalZ;
      const worldZ = normals[2] * normalX + normals[5] * normalY + normals[8] * normalZ;
      const length = Math.hypot(worldX, worldY, worldZ) || 1;
      world.normals[target] = worldX / length;
      world.normals[target + 1] = worldY / length;
      world.normals[target + 2] = worldZ / length;
    }
    if (geometry.uvs) world.uvs.set(geometry.uvs, (vertexOffset) * 2);
    if (geometry.colors) world.colors.set(geometry.colors, vertexOffset * 3);
    for (let slot = 0; slot < geometry.indices.length; slot++) world.indices[triangleOffset * 3 + slot] = geometry.indices[slot] + vertexOffset;
    world.triangleMaterial.fill(partIndex, triangleOffset, triangleOffset + geometry.indices.length / 3);
    vertexOffset += vertexCount;
    triangleOffset += geometry.indices.length / 3;
  });
  return world;
}

function normalized(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

// The 16 relative values of the light's IES profile, or null for a light with none.
function traceProfile(light) {
  return light.ies === undefined ? null : lightShapeSupport.profile(light.ies);
}

function resolveLights(environment) {
  const sunPower = Math.max(...(environment.keyColor ?? [0, 0, 0]));
  const lightCount = (environment.pointLights?.length ?? 0) + (environment.spotLights?.length ?? 0) + (environment.areaLights?.length ?? 0);
  if (lightCount > MAX_TRACE_LIGHTS) throw new RangeError(`A path trace takes at most ${MAX_TRACE_LIGHTS} point, spot and area lights.`);
  return {
    sun: sunPower > 0 ? { bit: SUN_BIT, direction: normalized(environment.lightDirection ?? [0, 1, 0]), color: environment.keyColor, angularRadius: environment.sunAngularRadius ?? SUN_ANGULAR_RADIUS } : null,
    points: (environment.pointLights ?? []).map((light, index) => ({ bit: POINT_FIRST_BIT + index, position: light.position, color: light.color, intensity: light.intensity, radius: light.radius ?? 0, range: light.range ?? 0 })),
    spots: (environment.spotLights ?? []).map((light, index) => ({
      bit: SPOT_FIRST_BIT + index, position: light.position, color: light.color, intensity: light.intensity, radius: light.radius ?? 0, range: light.range ?? 0,
      direction: normalized(light.direction),
      cosineHalfAngle: Math.cos(light.angle),
      profile: traceProfile(light),
      blend: (1 - Math.cos(light.angle)) * (light.penumbra ?? 0),
    })),
    areas: (environment.areaLights ?? []).map((light, index) => {
      const normal = normalized(light.direction);
      const guide = normalized(light.up ?? [0, 1, 0]);
      const across = normalized([guide[1] * normal[2] - guide[2] * normal[1], guide[2] * normal[0] - guide[0] * normal[2], guide[0] * normal[1] - guide[1] * normal[0]]);
      const along = [normal[1] * across[2] - normal[2] * across[1], normal[2] * across[0] - normal[0] * across[2], normal[0] * across[1] - normal[1] * across[0]];
      return { bit: AREA_FIRST_BIT + index, position: light.position, color: light.color, intensity: light.intensity, width: light.width, height: light.height, normal, across, along, profile: traceProfile(light) };
    }),
  };
}

/**
 * The environment map as radiance lookups plus a luminance-weighted table, so a direction can be drawn in proportion
 * to the light it brings. `pdf` is per steradian.
 */
function resolveEnvironment(map) {
  if (!map) return null;
  const { width, height, channels, data, intensity, rotation } = map;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const rowCumulative = new Float64Array(height);
  const pixelCumulative = new Float64Array(width * height);
  let total = 0;
  for (let row = 0; row < height; row++) {
    const rowWeight = Math.sin(Math.PI * (row + 0.5) / height);
    let rowTotal = 0;
    for (let column = 0; column < width; column++) {
      const base = (row * width + column) * channels;
      rowTotal += (0.2126 * data[base] + 0.7152 * data[base + 1] + 0.0722 * data[base + 2] + 1e-6) * rowWeight;
      pixelCumulative[row * width + column] = rowTotal;
    }
    total += rowTotal;
    rowCumulative[row] = total;
  }
  return { width, height, channels, data, intensity, cosine, sine, rowCumulative, pixelCumulative, total };
}

/** A scene that crossed a thread boundary has lost its ray query function: build it again from the arrays. */
export function attachTracer(scene) {
  return { ...scene, tracer: createTracer({ positions: scene.positions, indices: scene.indices, bvh: scene.bvh }) };
}

/** Local volumes are traced by the CPU path tracer only. Every other tracer entry point calls this so none drops them silently. */
export function refuseLocalVolumes(scene, tracerName) {
  if (!scene.localVolumes) return;
  throw new RangeError(`environment.localVolumes is traced by the CPU path tracer only; ${tracerName} cannot draw them. Use backend "cpu" or remove the volumes.`);
}

// The volumes of the trace, and the hidden parts that only bound a mesh volume: the rasterizer does not draw a part with
// `visible: false`, and the trace leaves it out of the geometry too, so a part can shape smoke without becoming a wall.
function resolveTraceLocalVolumes(input, parts) {
  if (!input?.length) return { volumes: null, boundsOnlyParts: [] };
  const resolved = resolveLocalVolumes(input, 'environment.localVolumes');
  const meshPartNames = new Set(resolved.filter(volume => volume.shape === 'mesh').map(volume => volume.part));
  const volumes = bindLocalVolumeParts(resolved, parts).map((volume, index) => (volume.part ? prepareMeshVolume(volume, `environment.localVolumes[${index}]`) : volume));
  return { volumes, boundsOnlyParts: parts.filter(part => meshPartNames.has(part.name) && part.visible === false) };
}

export function buildTraceScene(allParts, environment = {}) {
  const { volumes: localVolumes, boundsOnlyParts } = resolveTraceLocalVolumes(environment.localVolumes, allParts);
  const parts = boundsOnlyParts.length ? allParts.filter(part => !boundsOnlyParts.includes(part)) : allParts;
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > MAX_TRACE_PARTS) throw new RangeError(`A path trace takes 1 to ${MAX_TRACE_PARTS} parts.`);
  const geometry = flattenParts(parts);
  const bvh = buildTriangleBvh(geometry.positions, geometry.indices);
  let extent = 1e-3;
  for (let index = 0; index < geometry.positions.length; index++) extent = Math.max(extent, Math.abs(geometry.positions[index]));
  return attachTracer({
    ...geometry,
    bvh,
    materials: parts.map(part => resolveMaterial(part.material ?? {})),
    lights: resolveLights(environment),
    environment: resolveEnvironment(environment.map),
    volume: resolveTraceVolume(environment.volumeFog),
    localVolumes,
    surfaceOffset: extent * 1e-5,
    farDistance: extent * 1e4,
  });
}
