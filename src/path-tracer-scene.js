import { buildTriangleBvh } from './triangle-bvh.js';
import { createTracer } from './ray-query.js';
import { SUN_BIT, POINT_FIRST_BIT, SPOT_FIRST_BIT, AREA_FIRST_BIT } from './light-link-bits.js';
import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS } from './light-limits.js';
import { boxProjectedGeometry, columnLengths } from './export-box-uv.js';
import { resolveTraceVolume, prepareMeshVolume } from './path-tracer-volume.js';
import { resolveLocalVolumes } from './local-volumes.js';
import { bindLocalVolumeParts } from './local-volume-parts.js';
import { resolveTraceSubsurface } from './path-tracer-subsurface.js';
import { lightShapeSupport } from './shader-registry.js';
import { flushOrderOf } from './depth-layer.js';
import { liftRankedTriangles } from './flush-lift.js';

// The scene a path trace reads: every part flattened into one world-space triangle soup with per-vertex normals, UVs
// and colours, one resolved material per part, the lights in plain arrays, and the environment map as a sampling table.

export const MAX_TRACE_TRIANGLES = 400_000;
// The bound a scene built for the native "cycles" tracer may ask for with `options.maximumTriangles` (unique triangles of an
// instanced scene, all triangles of a flattened one). The CPU and WebGL tracers never pass it and keep MAX_TRACE_TRIANGLES.
export const MAX_NATIVE_TRACE_TRIANGLES = 4_000_000;
// With that option an instanced scene also counts every copy: at most this many times `maximumTriangles` triangles in total.
export const NATIVE_INSTANCED_TOTAL_FACTOR = 4;
export const MAX_TRACE_PARTS = 1024;
// An instanced trace counts triangles once per shared geometry and bounds the copies on their own.
export const MAX_TRACE_INSTANCES = 65_536;
// The bound a scene built for the native "cycles" tracer may ask for with `options.maximumInstances`. The CPU and WebGL tracers
// never pass it and keep MAX_TRACE_INSTANCES.
export const MAX_NATIVE_TRACE_INSTANCES = 1_000_000;
export const MAX_TRACE_LIGHTS = 32;
// The bound a scene built for the native "cycles" tracer may ask for with `options.maximumLights`. That kernel picks lights
// through a light tree and has no list per kind, so the per kind limits of a drawn frame (light-limits.js) do not apply.
export const MAX_NATIVE_TRACE_LIGHTS = 256;
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

/** True when the matrix mirrors (negative determinant of its upper 3x3), which turns every triangle inside out. */
function mirrorsGeometry(matrix) {
  const [a, b, c, , d, e, f, , g, h, i] = matrix;
  return a * (e * i - f * h) + b * (f * g - d * i) + c * (d * h - e * g) < 0;
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

/** Pixels and sampling of a texture descriptor for the trace, or null when its image cannot be read. */
export function resolveTexture(descriptor) {
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
    emissionFresnel: material.emissionFresnel ?? 0,
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

function partLabel(part) {
  return `Part ${part.name ?? ''}`.trim();
}

function validateMatrix(part) {
  requireFiniteNumbers(part.matrix ?? IDENTITY_MATRIX, 16, `${partLabel(part)} matrix`);
}

function validateGeometry(part, geometry) {
  const label = partLabel(part);
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

function validatePart(part, geometry) {
  validateMatrix(part);
  validateGeometry(part, geometry);
}

/**
 * The geometry a part is traced with. A box-projected material has no UVs, so it gets the UVs of its projection (the
 * ones the glTF export writes), and every map then reads them like those of an authored material.
 */
function traceGeometry(part) {
  // Faces hidden under a face on the same plane are cut away for the rasteriser (flush-resolve.js); rays get the same
  // geometry, or the two faces would split the hits between them.
  const traced = part.skin ? skinnedGeometry(part) : flushOrderOf(part)?.geometry ?? part.geometry;
  const geometry = liftRankedTriangles(part, traced);
  const { boxMapScale = 0, boxMapAxis = 1 } = part.material ?? {};
  if (!(boxMapScale > 0)) return geometry;
  return boxProjectedGeometry(geometry, columnLengths(part.matrix ?? IDENTITY_MATRIX), boxMapScale, boxMapAxis);
}

function allocateWorld(vertexTotal, indexTotal) {
  return {
    positions: new Float32Array(vertexTotal * 3),
    normals: new Float32Array(vertexTotal * 3),
    uvs: new Float32Array(vertexTotal * 2),
    colors: new Float32Array(vertexTotal * 3).fill(1),
    indices: new Uint32Array(indexTotal),
    triangleMaterial: new Uint32Array(indexTotal / 3),
  };
}

// Writes one part, moved by its matrix, into the world arrays at the given vertex and triangle offsets.
function writeWorldPart(world, part, geometry, partIndex, vertexOffset, triangleOffset) {
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
  // A mirrored part keeps outward vertex normals, so its triangles swap their last two corners to keep the winding
  // (and the cross-product normal) outward too.
  const mirrored = mirrorsGeometry(matrix);
  const cornerOrder = mirrored ? [0, 2, 1] : [0, 1, 2];
  for (let slot = 0; slot < geometry.indices.length; slot++) {
    const sourceSlot = slot - (slot % 3) + cornerOrder[slot % 3];
    world.indices[triangleOffset * 3 + slot] = geometry.indices[sourceSlot] + vertexOffset;
  }
  world.triangleMaterial.fill(partIndex, triangleOffset, triangleOffset + geometry.indices.length / 3);
}

/**
 * The triangle bounds of one build: the CPU and WebGL default, or the native bound an exporter for the "cycles" kernel
 * asks for with `maximumTriangles`. A bad value is refused here so a typo cannot lift the bound.
 */
function resolveTriangleLimits(options) {
  const requested = options?.maximumTriangles;
  if (requested === undefined) return { native: false, unique: MAX_TRACE_TRIANGLES, total: Infinity };
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_NATIVE_TRACE_TRIANGLES) {
    throw new RangeError(`buildTraceScene option maximumTriangles is an integer from 1 to ${MAX_NATIVE_TRACE_TRIANGLES} for the native path tracer, got ${requested}. Leave it out for the CPU and WebGL path tracers, which take at most ${MAX_TRACE_TRIANGLES} triangles.`);
  }
  return { native: true, unique: requested, total: requested * NATIVE_INSTANCED_TOTAL_FACTOR };
}

/** The instance bound of one build: the CPU and WebGL default, or the native bound asked for with `maximumInstances`. */
function resolveInstanceLimit(options) {
  const requested = options?.maximumInstances;
  if (requested === undefined) return { native: false, count: MAX_TRACE_INSTANCES };
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_NATIVE_TRACE_INSTANCES) {
    throw new RangeError(`buildTraceScene option maximumInstances is an integer from 1 to ${MAX_NATIVE_TRACE_INSTANCES} for the native path tracer, got ${requested}. Leave it out for the CPU and WebGL path tracers, which take at most ${MAX_TRACE_INSTANCES} instances.`);
  }
  return { native: true, count: requested };
}

function flattenParts(parts, geometries = parts.map(traceGeometry), limits = resolveTriangleLimits()) {
  let vertexTotal = 0;
  let indexTotal = 0;
  parts.forEach((part, index) => validatePart(part, geometries[index]));
  for (const geometry of geometries) {
    vertexTotal += geometry.positions.length / 3;
    indexTotal += geometry.indices.length;
  }
  if (indexTotal / 3 > limits.unique) {
    throw new RangeError(limits.native
      ? `A native path trace takes at most ${limits.unique} triangles in total, got ${indexTotal / 3}. Share geometry between copies (they stay instances) or simplify the meshes.`
      : `A path trace takes at most ${MAX_TRACE_TRIANGLES} triangles in total.`);
  }
  const world = allocateWorld(vertexTotal, indexTotal);
  let vertexOffset = 0;
  let triangleOffset = 0;
  parts.forEach((part, partIndex) => {
    const geometry = geometries[partIndex];
    writeWorldPart(world, part, geometry, partIndex, vertexOffset, triangleOffset);
    vertexOffset += geometry.positions.length / 3;
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

// A point or spot light with a radius is a sphere unless it asks for the oriented disk of Blender's Soft Falloff. Only the `cycles` native kernel draws the disk.
function softFalloffOf(light, label) {
  if (light.softFalloff === undefined) return {};
  if (typeof light.softFalloff !== 'boolean') {
    throw new TypeError(`${label}.softFalloff must be true (a disk, as Blender's Soft Falloff) or false (a sphere), got ${JSON.stringify(light.softFalloff)}. Leave it out for the sphere.`);
  }
  return light.softFalloff ? { softFalloff: true } : {};
}

function resolveAreaLight(light, index) {
  const normal = normalized(light.direction);
  const guide = normalized(light.up ?? [0, 1, 0]);
  const across = normalized([guide[1] * normal[2] - guide[2] * normal[1], guide[2] * normal[0] - guide[0] * normal[2], guide[0] * normal[1] - guide[1] * normal[0]]);
  const along = [normal[1] * across[2] - normal[2] * across[1], normal[2] * across[0] - normal[0] * across[2], normal[0] * across[1] - normal[1] * across[0]];
  return { bit: AREA_FIRST_BIT + index, position: light.position, color: light.color, intensity: light.intensity, width: light.width, height: light.height, normal, across, along, profile: traceProfile(light) };
}

/**
 * A portal is a rect area light with `portal: true`. It emits nothing: the native cycles kernel draws environment light
 * through its rectangle, with the normal pointing into the room. The other tracers ignore it (describeIgnoredFeatures).
 */
function resolvePortal(light, lightIndex) {
  const path = `environment.areaLights[${lightIndex}]`;
  if (light.shape !== undefined && light.shape !== 'rect') {
    throw new RangeError(`${path}.portal is only supported on a rect area light, got shape ${JSON.stringify(light.shape)}. Remove \`portal\` or use a rect light.`);
  }
  for (const field of ['width', 'height']) {
    if (!(light[field] > 0)) throw new RangeError(`${path}.portal needs a ${field} above 0, got ${JSON.stringify(light[field])}. Pass the size of the opening in scene units.`);
  }
  const { across, along, normal } = resolveAreaLight(light, lightIndex);
  return { position: light.position, width: light.width, height: light.height, normal, across, along };
}

/** The light bound of one build: the CPU and WebGL default, or the native bound asked for with `maximumLights`. */
function resolveLightLimit(options) {
  const requested = options?.maximumLights;
  if (requested === undefined) return { native: false, count: MAX_TRACE_LIGHTS };
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_NATIVE_TRACE_LIGHTS) {
    throw new RangeError(`buildTraceScene option maximumLights is an integer from 1 to ${MAX_NATIVE_TRACE_LIGHTS} for the native path tracer, got ${requested}. Leave it out for the CPU and WebGL path tracers, which take at most ${MAX_TRACE_LIGHTS} lights.`);
  }
  return { native: true, count: requested };
}

// Light linking keeps one mask bit per light, laid out by the per kind limits of a drawn frame. A scene with more lights of
// one kind than that has lights without a bit of their own, so a part that names its lights cannot be honoured.
function refuseLinkingBeyondMaskBits(environment, parts) {
  const overKinds = [['pointLights', MAX_POINT_LIGHTS], ['spotLights', MAX_SPOT_LIGHTS], ['areaLights', MAX_AREA_LIGHTS]]
    .filter(([field, maximum]) => (environment[field]?.length ?? 0) > maximum);
  if (overKinds.length === 0) return;
  const linkedPart = parts.find(part => part.material?.lightMask !== undefined && part.material.lightMask !== ALL_LIGHTS);
  if (linkedPart === undefined) return;
  const [field, maximum] = overKinds[0];
  throw new RangeError(`Light linking (a light with \`affects\`, or a part with \`material.lightMask\`, here "${linkedPart.name}") needs at most ${maximum} ${field}, got ${environment[field].length}: each linked light keeps one mask bit. Remove the links, or keep ${field} to ${maximum}.`);
}

function resolveLights(environment, limit = resolveLightLimit(), parts = []) {
  const areaLights = environment.areaLights ?? [];
  const sunPower = Math.max(...(environment.keyColor ?? [0, 0, 0]));
  const lightCount = (environment.pointLights?.length ?? 0) + (environment.spotLights?.length ?? 0) + (environment.areaLights?.filter(light => light.portal !== true).length ?? 0);
  if (!limit.native && lightCount > MAX_TRACE_LIGHTS) throw new RangeError(`A path trace takes at most ${MAX_TRACE_LIGHTS} point, spot and area lights.`);
  if (limit.native) {
    if (lightCount > limit.count) {
      throw new RangeError(`A native path trace takes at most ${limit.count} point, spot and area lights, got ${lightCount} (${lightCount - limit.count} too many). Drop lights, or give the extra emitters as meshes with an emissive material, which have no count limit.`);
    }
    refuseLinkingBeyondMaskBits(environment, parts);
  }
  return {
    sun: sunPower > 0 ? { bit: SUN_BIT, direction: normalized(environment.lightDirection ?? [0, 1, 0]), color: environment.keyColor, angularRadius: environment.sunAngularRadius ?? SUN_ANGULAR_RADIUS } : null,
    points: (environment.pointLights ?? []).map((light, index) => ({ bit: POINT_FIRST_BIT + index, position: light.position, color: light.color, intensity: light.intensity, radius: light.radius ?? 0, range: light.range ?? 0, ...softFalloffOf(light, `environment.pointLights[${index}]`) })),
    spots: (environment.spotLights ?? []).map((light, index) => ({
      bit: SPOT_FIRST_BIT + index, position: light.position, color: light.color, intensity: light.intensity, radius: light.radius ?? 0, range: light.range ?? 0, ...softFalloffOf(light, `environment.spotLights[${index}]`),
      direction: normalized(light.direction),
      cosineHalfAngle: Math.cos(light.angle),
      profile: traceProfile(light),
      blend: (1 - Math.cos(light.angle)) * (light.penumbra ?? 0),
    })),
    areas: areaLights.map((light, index) => (light.portal === true ? null : resolveAreaLight(light, index))).filter(Boolean),
    portals: areaLights.map((light, index) => (light.portal === true ? resolvePortal(light, index) : null)).filter(Boolean),
  };
}

/**
 * The environment map as radiance lookups plus a luminance-weighted table, so a direction can be drawn in proportion
 * to the light it brings. `pdf` is per steradian.
 */
function resolveEnvironment(map, cameraIntensity) {
  requireCameraIntensity(map, cameraIntensity);
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
  const resolved = { width, height, channels, data, intensity, cosine, sine, rowCumulative, pixelCumulative, total };
  // Only the native "cycles" kernel reads it; absent means the sky is seen at the strength that lights the scene.
  if (cameraIntensity !== undefined) resolved.cameraIntensity = cameraIntensity;
  return resolved;
}

/** `environment.cameraIntensity` is the sky strength a camera ray sees (through glass too), in the units of the map intensity. */
function requireCameraIntensity(map, cameraIntensity) {
  if (cameraIntensity === undefined) return;
  if (typeof cameraIntensity !== 'number' || !Number.isFinite(cameraIntensity) || cameraIntensity < 0) {
    throw new RangeError(`environment.cameraIntensity must be a finite number of 0 or more (got ${cameraIntensity}). Pass 0.2 to draw the view through a window at 0.2 of the sky, or leave it out to use the map intensity.`);
  }
  if (!map) {
    throw new RangeError('environment.cameraIntensity needs environment.map: it scales the sky a camera ray sees, and there is no sky. Add an environment map or remove cameraIntensity.');
  }
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
function resolveTraceLocalVolumes(input, parts, volumeTime = 0) {
  if (!input?.length) return { volumes: null, boundsOnlyParts: [] };
  const resolved = resolveLocalVolumes(input, 'environment.localVolumes');
  const meshPartNames = new Set(resolved.filter(volume => volume.shape === 'mesh').map(volume => volume.part));
  const volumes = bindLocalVolumeParts(resolved, parts, { time: volumeTime }).map((volume, index) => (volume.part ? prepareMeshVolume(volume, `environment.localVolumes[${index}]`) : volume));
  return { volumes, boundsOnlyParts: parts.filter(part => meshPartNames.has(part.name) && part.visible === false) };
}

// FORMAT-v2 instance visibility bits, the same names a part's `rayVisibility` takes.
export const RAY_VISIBILITY_BITS = Object.freeze({ camera: 1, diffuse: 2, glossy: 4, transmission: 8, shadow: 16, volumeScatter: 32 });
const ALL_RAY_KINDS = 63;

function describePart(part, index) {
  return typeof part?.name === 'string' && part.name ? `part "${part.name}"` : `part ${index}`;
}

function requireRayVisibilityObject(rayVisibility, label) {
  if (rayVisibility === null || typeof rayVisibility !== 'object' || Array.isArray(rayVisibility)) {
    throw new TypeError(`${label} rayVisibility must be an object such as { shadow: false } with keys from ${Object.keys(RAY_VISIBILITY_BITS).join(', ')}, got ${JSON.stringify(rayVisibility)}.`);
  }
}

function rayKindBit(kind, value, label) {
  const bit = RAY_VISIBILITY_BITS[kind];
  if (bit === undefined) {
    throw new TypeError(`${label} rayVisibility has the unknown ray kind "${kind}": use ${Object.keys(RAY_VISIBILITY_BITS).join(', ')}.`);
  }
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} rayVisibility.${kind} must be true or false, got ${JSON.stringify(value)}.`);
  }
  return bit;
}

/**
 * The FORMAT-v2 visibility bits of one part: `rayVisibility: { camera, diffuse, glossy, transmission, shadow, volumeScatter }`
 * (a kind set to false hides the part from those rays) and `shadowOnly` as camera off. `castShadow` is a raster flag that
 * library code sets by default, so it never reaches these bits. A part that hides from nothing gets 63, every ray kind.
 */
export function partRayVisibilityFlags(part, index = 0) {
  const label = describePart(part, index);
  let flags = ALL_RAY_KINDS;
  if (part.rayVisibility !== undefined) {
    requireRayVisibilityObject(part.rayVisibility, label);
    for (const [kind, value] of Object.entries(part.rayVisibility)) {
      const bit = rayKindBit(kind, value, label);
      if (value === false) flags &= ~bit;
    }
  }
  requireEmitterStaysVisibleToBounces(part, flags, label);
  if (part.shadowOnly === true) {
    if ((flags & RAY_VISIBILITY_BITS.shadow) === 0) {
      throw new TypeError(`${label} sets shadowOnly with rayVisibility.shadow: false, which would hide it from every ray: keep shadow rays on, or drop shadowOnly.`);
    }
    flags &= ~RAY_VISIBILITY_BITS.camera;
  }
  return flags;
}

const BOUNCE_RAY_BITS = RAY_VISIBILITY_BITS.diffuse | RAY_VISIBILITY_BITS.glossy | RAY_VISIBILITY_BITS.transmission;

/**
 * The kernel samples an emissive mesh by next-event estimation with a multiple-importance weight below 1 and weights its
 * bounce hits to match. Hiding the emitter from a bounce ray culls those hits while the sampled share stays, so part of its
 * light would vanish. Camera, shadow and volume rays do not take part in that weighting, so those stay allowed.
 */
function requireEmitterStaysVisibleToBounces(part, flags, label) {
  if ((flags & BOUNCE_RAY_BITS) === BOUNCE_RAY_BITS) return;
  if (!(part.material?.emission > 0)) return;
  throw new TypeError(`${label} emits light and sets rayVisibility.diffuse, glossy or transmission to false, which would drop part of its light. Hide an emitter with camera: false or shadow: false instead, or keep diffuse, glossy and transmission true.`);
}

// True when the part's rayVisibility turns at least one ray kind off; an empty object or all true is the default.
function hidesFromSomeRay(part) {
  return part.rayVisibility !== undefined && Object.values(part.rayVisibility).includes(false);
}

// One byte per part for a flattened scene, or null when no part hides from a ray kind (shadowOnly alone keeps its own path).
function flattenedRayVisibility(parts) {
  const flags = parts.map((part, index) => partRayVisibilityFlags(part, index));
  if (!parts.some(hidesFromSomeRay)) return null;
  return Uint8Array.from(flags);
}

/**
 * True when the part keeps the geometry object it was authored with, so its copies can share one bottom-level structure.
 * A skinned, flush-lifted or box-mapped part gets a geometry of its own from `traceGeometry`, and a geometry with
 * per-triangle materials would be read differently by the instanced packer, so those stay baked into world space.
 */
function sharesAuthoredGeometry(part, traced) {
  return traced === part.geometry && !traced.triangleMaterial;
}

function countSharedGeometries(parts, geometries) {
  const useCounts = new Map();
  parts.forEach((part, index) => {
    if (sharesAuthoredGeometry(part, geometries[index])) useCounts.set(geometries[index], (useCounts.get(geometries[index]) ?? 0) + 1);
  });
  return [...useCounts.values()].filter(count => count > 1).length;
}

/** Validates each part's matrix, and each distinct geometry once, then returns the unique geometry and triangle totals. */
function measureInstancedParts(parts, geometries) {
  const seen = new Set();
  let uniqueGeometries = 0;
  let uniqueTriangles = 0;
  let totalTriangles = 0;
  parts.forEach((part, index) => {
    const geometry = geometries[index];
    validateMatrix(part);
    totalTriangles += geometry.indices.length / 3;
    if (sharesAuthoredGeometry(part, geometry)) {
      if (seen.has(geometry)) return;
      seen.add(geometry);
    }
    validateGeometry(part, geometry);
    uniqueGeometries++;
    uniqueTriangles += geometry.indices.length / 3;
  });
  return { uniqueGeometries, uniqueTriangles, totalTriangles };
}

function requireInstancedCaps(parts, { uniqueGeometries, uniqueTriangles, totalTriangles }, limits) {
  if (parts.length > limits.instances.count) {
    throw new RangeError(`An instanced ${limits.instances.native ? 'native ' : ''}path trace takes at most ${limits.instances.count} instances, got ${parts.length}. Pass fewer parts, or merge small copies into one mesh.`);
  }
  if (uniqueGeometries > MAX_TRACE_PARTS) {
    throw new RangeError(`An instanced path trace takes at most ${MAX_TRACE_PARTS} distinct geometries, got ${uniqueGeometries}. Share one geometry object between copies instead of building a new one per part.`);
  }
  if (uniqueTriangles > limits.unique) {
    throw new RangeError(`An instanced path trace takes at most ${limits.unique} unique triangles, counted once per shared geometry, got ${uniqueTriangles}. Share geometry between copies or simplify the meshes.`);
  }
  if (totalTriangles > limits.total) {
    throw new RangeError(`An instanced native path trace takes at most ${limits.total} triangles with every copy counted, got ${totalTriangles}. Pass fewer copies of the large meshes or simplify them.`);
  }
}

// A part that cannot share its geometry is moved into world space once and traced with an identity matrix.
function bakeWorldGeometry(part, geometry) {
  const world = allocateWorld(geometry.positions.length / 3, geometry.indices.length);
  writeWorldPart(world, part, geometry, 0, 0, 0);
  delete world.triangleMaterial;
  return world;
}

function instanceFor(part, geometry, partIndex, material) {
  const shared = sharesAuthoredGeometry(part, geometry);
  const instance = {
    geometry: shared ? geometry : bakeWorldGeometry(part, geometry),
    matrix: shared ? part.matrix ?? IDENTITY_MATRIX : IDENTITY_MATRIX,
    materialIndex: partIndex,
    objectId: partIndex,
    lightMask: material.lightMask,
  };
  if (part.material?.lightMaskHi !== undefined) instance.lightMaskHi = part.material.lightMaskHi;
  const visibilityFlags = partRayVisibilityFlags(part, partIndex);
  if (visibilityFlags !== ALL_RAY_KINDS) instance.visibilityFlags = visibilityFlags;
  return instance;
}

// The largest coordinate any instance reaches, from the corners of each geometry's box, so it never reads a whole copy.
function instancedExtent(instances) {
  const boxes = new Map();
  let extent = 1e-3;
  for (const { geometry, matrix } of instances) {
    if (!boxes.has(geometry)) boxes.set(geometry, boundingBoxOf(geometry.positions));
    const { low, high } = boxes.get(geometry);
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? high[0] : low[0];
      const y = corner & 2 ? high[1] : low[1];
      const z = corner & 4 ? high[2] : low[2];
      extent = Math.max(extent,
        Math.abs(matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]),
        Math.abs(matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]),
        Math.abs(matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]));
    }
  }
  return extent;
}

function boundingBoxOf(positions) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], positions[offset + axis]);
      high[axis] = Math.max(high[axis], positions[offset + axis]);
    }
  }
  return { low, high };
}

/**
 * The scene with copies of one geometry kept as instances: `instances` (geometry, matrix, materialIndex, visibility) over
 * the unique geometries, and `materials` indexed by part (`traceMaterials` are the same parts' resolved materials alone, the
 * list a flattened scene calls `materials`), with no world-space triangle arrays and no CPU BVH. Only
 * `buildNativeInputV2` reads this shape, for the native "cycles" kernel.
 */
function buildInstancedTraceScene(parts, geometries, environment, localVolumes, limits) {
  requireInstancedCaps(parts, measureInstancedParts(parts, geometries), limits);
  const traceMaterials = parts.map(part => resolveMaterial(part.material ?? {}));
  const materials = parts.map((part, index) => ({ ...(part.material ?? {}), ...traceMaterials[index] }));
  const instances = parts.map((part, index) => instanceFor(part, geometries[index], index, materials[index]));
  const extent = instancedExtent(instances);
  return {
    instances,
    materials,
    traceMaterials,
    lights: resolveLights(environment, limits.lights, parts),
    environment: resolveEnvironment(environment.map, environment.cameraIntensity),
    volume: resolveTraceVolume(environment.volumeFog),
    localVolumes,
    surfaceOffset: extent * 1e-5,
    farDistance: extent * 1e4,
  };
}

/**
 * Builds the scene a path trace reads. With `options.instancing` and at least one geometry shared by two parts, the result
 * holds `instances` instead of flattened triangles (see `buildInstancedTraceScene`); with no shared geometry, or without the
 * option, it is the flattened scene, unchanged. `options.maximumTriangles` (an integer up to MAX_NATIVE_TRACE_TRIANGLES) is for
 * a scene exported to the native "cycles" tracer only: it replaces the 400,000 triangle bound of the CPU and WebGL tracers.
 * `options.maximumInstances` (an integer up to MAX_NATIVE_TRACE_INSTANCES) does the same for the 65,536 instances of an
 * instanced scene; a flattened scene has no instances and keeps its part bound. `options.maximumLights` (an integer up to
 * MAX_NATIVE_TRACE_LIGHTS) replaces the 32 lights of the CPU and WebGL tracers in the same way; light linking then still
 * needs every kind of light within the limits of a drawn frame.
 */
export function buildTraceScene(allParts, environment = {}, options = {}) {
  const limits = { ...resolveTriangleLimits(options), instances: resolveInstanceLimit(options), lights: resolveLightLimit(options) };
  const { volumes: localVolumes, boundsOnlyParts } = resolveTraceLocalVolumes(environment.localVolumes, allParts, environment.volumeTime ?? 0);
  const parts = boundsOnlyParts.length ? allParts.filter(part => !boundsOnlyParts.includes(part)) : allParts;
  const tryInstancing = options.instancing === true && Array.isArray(parts) && parts.length > 0;
  const geometries = tryInstancing ? parts.map(traceGeometry) : undefined;
  if (tryInstancing && countSharedGeometries(parts, geometries) > 0) return buildInstancedTraceScene(parts, geometries, environment, localVolumes, limits);
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > MAX_TRACE_PARTS) throw new RangeError(`A path trace takes 1 to ${MAX_TRACE_PARTS} parts.`);
  const geometry = flattenParts(parts, geometries, limits);
  const bvh = buildTriangleBvh(geometry.positions, geometry.indices);
  let extent = 1e-3;
  for (let index = 0; index < geometry.positions.length; index++) extent = Math.max(extent, Math.abs(geometry.positions[index]));
  return attachTracer({
    ...geometry,
    bvh,
    materials: parts.map(part => resolveMaterial(part.material ?? {})),
    // The parts' own materials: the fields resolveMaterial leaves out, which the native "cycles" kernel shades.
    partMaterials: parts.map(part => part.material ?? {}),
    shadowOnlyParts: parts.some(part => part.shadowOnly === true) ? Uint8Array.from(parts, part => (part.shadowOnly === true ? 1 : 0)) : null,
    // Per part FORMAT-v2 visibility bits for the native "cycles" kernel; the "legacy" kernel and the other tracers do not read them.
    partRayVisibility: flattenedRayVisibility(parts),
    lights: resolveLights(environment, limits.lights, parts),
    environment: resolveEnvironment(environment.map, environment.cameraIntensity),
    volume: resolveTraceVolume(environment.volumeFog),
    localVolumes,
    surfaceOffset: extent * 1e-5,
    farDistance: extent * 1e4,
  });
}
