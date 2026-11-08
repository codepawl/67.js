import { createTracer } from './ray-query.js';
import { readTriangle } from './triangle-math.js';
import { registerShaderFeatureCode, layerTextureSupport } from './shader-registry.js';
import {
  MAX_BAKE_PARTS, buildWorld, createDirectIrradiance, createGatherer, diffuseAlbedo, emittedRadiance, hitNormal, normalizeLights, sceneScale, validatePart, withReach,
} from './light-bake.js';
import { worldBounds } from './probe-trace.js';
import { createGridMedium } from './grid-medium.js';

// A baked grid of diffuse light: at each node of a 3D grid the light that other surfaces bounce toward it (the sun's lit
// patches included, over several bounces), stored as first order spherical harmonics per colour channel. A lit surface reads
// it with one trilinear lookup and Lambert's cosine, so the warm light a sunlit floor sends up to the ceiling and walls costs
// no ray per frame. The sky is not in it: a ray that leaves the scene adds nothing, and the environment map keeps lighting
// that. The grid is static; it is traced again when the scene or its lights change.
// This module is optional. A scene without `bake.irradianceGrid` never loads it, and the renderer's only link to it is the
// material field `irradianceGrid`, which batches parts by grid.

export const IRRADIANCE_GRID_LIMITS = Object.freeze({ resolution: [8, 48], samples: [4, 128], bounces: [1, 8], maxNodes: 65536 });
// `true` picks the cell size itself: at most this many nodes along the longest side and at most AUTO_NODE_BUDGET in all. The
// budget keeps the trace inside the bake's time limit (20 s on the page's thread): a closed 68 m hall with 31,768 nodes took
// 40 s, the bake was refused and the scene was drawn with no grid at all (temple-hall-b, FLIP 0.1535 against 0.1211 with a grid).
// A long hall still gets about twice the resolution of the old 24 nodes, and a coarse grid smears the sun's patches into the
// shade (measured on the grand halls: a 9.7 m cell read 1.6 times the light of a brute-force gather).
export const AUTO_GRID_RESOLUTION = 48;
const AUTO_NODE_BUDGET = 8192;
const DEFAULT_GRID_SAMPLES = 32;
const VALIDITY_DIRECTIONS = buildValidityDirections();
const BACKFACE_INVALID_SHARE = 0.5;
const FILL_PASSES = 12;
const COEFFICIENTS_PER_NODE = 16;
// The fourth texel of a node holds the share of sky the node sees (rays that leave the scene on their first leg), in the same
// constant plus slope form, so the shader can darken the world's light where the sky cannot reach.
const SKY_SLOT = 12;
// The grid is one 3D texture: node (x, y, z) takes three texels along x, one per colour channel, each holding the channel's
// constant term and its x, y and z terms.
// Unit 16, past the 16 the renderer's other samplers use (splat layers take 11 to 14, local shadows 15). A unit index is limited by
// MAX_COMBINED_TEXTURE_IMAGE_UNITS (at least 32 in WebGL2), not by the 16 samplers a fragment shader may declare.
export const IRRADIANCE_GRID_TEXTURE_UNIT = 16;
const TEXTURE_UNIT = IRRADIANCE_GRID_TEXTURE_UNIT;

function buildValidityDirections() {
  const directions = [];
  for (const axis of [0, 1, 2]) {
    for (const sign of [-1, 1]) {
      const direction = [0, 0, 0];
      direction[axis] = sign;
      directions.push(direction);
    }
  }
  const diagonal = Math.sqrt(1 / 3);
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      for (const z of [-1, 1]) {
        directions.push([x * diagonal, y * diagonal, z * diagonal]);
      }
    }
  }
  return directions;
}

/** Validates the recipe field: true, or a node count along the longest side. Returns the plain settings or null. */
export function normalizeIrradianceGrid(input) {
  if (input === undefined || input === null || input === false) {
    return null;
  }
  if (input === true) {
    return true;
  }
  const resolution = input;
  const [minimum, maximum] = IRRADIANCE_GRID_LIMITS.resolution;
  if (!Number.isInteger(resolution) || resolution < minimum || resolution > maximum) {
    throw new RangeError(`bake.irradianceGrid must be true or an integer node count from ${minimum} to ${maximum}.`);
  }
  return resolution;
}

function nodePoint(layout, node, point) {
  const [width, height] = layout.size;
  point[0] = layout.origin[0] + (node % width) * layout.cellSize;
  point[1] = layout.origin[1] + (Math.floor(node / width) % height) * layout.cellSize;
  point[2] = layout.origin[2] + Math.floor(node / (width * height)) * layout.cellSize;
}

function gridLayout(parts, resolution) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const bounds = worldBounds(part);
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], bounds.minimum[axis]);
      maximum[axis] = Math.max(maximum[axis], bounds.maximum[axis]);
    }
  }
  const extent = maximum.map((value, axis) => Math.max(value - minimum[axis], 1e-3));
  const sizeFor = cell => extent.map(length => Math.max(2, Math.round(length / cell) + 1));
  let cellSize = Math.max(...extent) / ((resolution === true ? AUTO_GRID_RESOLUTION : resolution) - 1);
  if (resolution === true) {
    while (sizeFor(cellSize).reduce((product, count) => product * count, 1) > AUTO_NODE_BUDGET) {
      cellSize *= 1.05;
    }
  }
  return { origin: minimum, cellSize, size: sizeFor(cellSize) };
}

// A node inside a solid sees the back of the surfaces around it; its light would be the inside of a wall, not the room's.
function isInsideSolid(world, tracer, point) {
  const triangle = new Float64Array(9);
  let backfaces = 0;
  let hits = 0;
  for (const direction of VALIDITY_DIRECTIONS) {
    const hit = tracer.trace(point[0], point[1], point[2], direction[0], direction[1], direction[2], Infinity, false);
    if (hit.nearestTriangle < 0) {
      continue;
    }
    hits++;
    readTriangle(world.positions, world.indices, hit.nearestTriangle, triangle);
    const normalX = (triangle[4] - triangle[1]) * (triangle[8] - triangle[2]) - (triangle[5] - triangle[2]) * (triangle[7] - triangle[1]);
    const normalY = (triangle[5] - triangle[2]) * (triangle[6] - triangle[0]) - (triangle[3] - triangle[0]) * (triangle[8] - triangle[2]);
    const normalZ = (triangle[3] - triangle[0]) * (triangle[7] - triangle[1]) - (triangle[4] - triangle[1]) * (triangle[6] - triangle[0]);
    if (normalX * direction[0] + normalY * direction[1] + normalZ * direction[2] > 0) {
      backfaces++;
    }
  }
  return hits > 0 && backfaces / VALIDITY_DIRECTIONS.length > BACKFACE_INVALID_SHARE;
}

// Nodes inside walls take the mean of their valid neighbours, a few passes deep, so a lookup near a wall never reads black.
function fillInvalidNodes(data, valid, size) {
  const [width, height, depth] = size;
  const strides = [1, width, width * height];
  for (let pass = 0; pass < FILL_PASSES; pass++) {
    const newlyValid = [];
    for (let node = 0; node < valid.length; node++) {
      if (valid[node]) {
        continue;
      }
      const coordinates = [node % width, Math.floor(node / width) % height, Math.floor(node / (width * height))];
      // A node inside a wall copies its darkest valid neighbour. A mean would carry the sunlit outside of a thin wall into the
      // room, because a surface on the wall reads this node through the trilinear lookup.
      let darkest = -1;
      let darkestLight = Infinity;
      for (let axis = 0; axis < 3; axis++) {
        for (const step of [-1, 1]) {
          const moved = coordinates[axis] + step;
          if (moved < 0 || moved >= size[axis]) {
            continue;
          }
          const neighbour = node + step * strides[axis];
          if (!valid[neighbour]) {
            continue;
          }
          const base = neighbour * COEFFICIENTS_PER_NODE;
          const light = data[base] + data[base + 4] + data[base + 8];
          if (light < darkestLight) {
            darkestLight = light;
            darkest = neighbour;
          }
        }
      }
      if (darkest >= 0) {
        for (let slot = 0; slot < COEFFICIENTS_PER_NODE; slot++) {
          data[node * COEFFICIENTS_PER_NODE + slot] = data[darkest * COEFFICIENTS_PER_NODE + slot];
        }
        newlyValid.push(node);
      }
    }
    if (newlyValid.length === 0) {
      break;
    }
    for (const node of newlyValid) {
      valid[node] = 1;
    }
  }
}

// A [1 2 1] x [1 2 1] x [1 2 1] filter over the coefficients of valid neighbours removes the low-frequency noise of the few
// samples each node gets, at the cost of a little blur across a wall. Nodes inside solids keep their filled values.
function smoothNodes(data, valid, size, isConnected) {
  const [width, height, depth] = size;
  const source = Float32Array.from(data);
  const weights = [1, 2, 1];
  for (let node = 0; node < valid.length; node++) {
    if (!valid[node]) {
      continue;
    }
    const x = node % width;
    const y = Math.floor(node / width) % height;
    const z = Math.floor(node / (width * height));
    const sum = new Float64Array(COEFFICIENTS_PER_NODE);
    let total = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          if (nx < 0 || ny < 0 || nz < 0 || nx >= width || ny >= height || nz >= depth) {
            continue;
          }
          const neighbour = nx + width * (ny + height * nz);
          // A neighbour across a wall is another room's light: it only counts when a ray between the two nodes is free.
          if (!valid[neighbour] || (neighbour !== node && !isConnected(node, neighbour))) {
            continue;
          }
          const weight = weights[dx + 1] * weights[dy + 1] * weights[dz + 1];
          for (let slot = 0; slot < COEFFICIENTS_PER_NODE; slot++) {
            sum[slot] += weight * source[neighbour * COEFFICIENTS_PER_NODE + slot];
          }
          total += weight;
        }
      }
    }
    for (let slot = 0; slot < COEFFICIENTS_PER_NODE; slot++) {
      data[node * COEFFICIENTS_PER_NODE + slot] = sum[slot] / total;
    }
  }
}

const SURFACE_SCATTER = true;

// The radiance the nearest surface along a ray sends back: its emission and its direct light (what one bounce of the gatherer adds).
function createSurfaceRadiance({ world, tracer, albedoOfPart, emissionOfPart, directIrradiance }) {
  const hitPoint = [0, 0, 0];
  const normal = [0, 0, 0];
  return function surfaceRadiance(point, direction, out) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    const hit = tracer.trace(point[0], point[1], point[2], direction[0], direction[1], direction[2], Infinity, false);
    const triangle = hit.nearestTriangle;
    if (triangle < 0) return;
    const distance = hit.nearestDistance;
    for (let axis = 0; axis < 3; axis++) hitPoint[axis] = point[axis] + direction[axis] * distance;
    hitNormal(world, triangle, direction, normal);
    const owner = world.triangleOwner[triangle];
    const irradiance = directIrradiance(hitPoint, normal, owner);
    for (let channel = 0; channel < 3; channel++) {
      out[channel] = emissionOfPart[owner][channel] + albedoOfPart[owner][channel] * irradiance[channel] / Math.PI;
    }
  };
}

/**
 * Traces the grid. For each node, the cosine weighted light arriving along the six axis directions (the bake's gatherer:
 * emission and direct light at every hit, bounced over `bounces` reflections) becomes a first order fit per colour channel:
 * the mean of the opposite pair is the constant term and half their difference the slope. Nodes inside solids are filled from
 * their neighbours. Returns `{ origin, cellSize, size, data, seconds, nodes, solidNodes }`; the same input gives the same bytes.
 */
export function traceIrradianceGrid(parts, lighting, { resolution = true, samples = DEFAULT_GRID_SAMPLES, bounces = 3, maxSeconds = 60 } = {}) {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_BAKE_PARTS) {
    throw new RangeError(`The irradiance grid takes from 1 to ${MAX_BAKE_PARTS} parts.`);
  }
  parts.forEach(validatePart);
  const layout = gridLayout(parts, resolution);
  const nodeCount = layout.size[0] * layout.size[1] * layout.size[2];
  if (nodeCount > IRRADIANCE_GRID_LIMITS.maxNodes) {
    throw new RangeError(`The irradiance grid would have ${nodeCount} nodes; the limit is ${IRRADIANCE_GRID_LIMITS.maxNodes}. Lower bake.irradianceGrid.`);
  }
  const lights = normalizeLights(lighting);
  const world = buildWorld(parts);
  const scale = sceneScale(world.positions);
  const offset = scale * 1e-4;
  const tracer = createTracer(world);
  const directIrradiance = createDirectIrradiance(tracer, withReach(lights, parts), offset, scale);
  const albedoOfPart = parts.map(part => diffuseAlbedo(part.material));
  const emissionOfPart = parts.map(part => emittedRadiance(part.material));
  const sun = lights.sun ?? null;
  const surfaceRadiance = createSurfaceRadiance({ world, tracer, albedoOfPart, emissionOfPart, directIrradiance });
  const medium = createGridMedium({ lighting, sun, tracer, scale, surfaceRadiance: SURFACE_SCATTER ? surfaceRadiance : null });
  const gather = createGatherer({ world, tracer, albedoOfPart, emissionOfPart, directIrradiance, offset, samples, bounces, medium });
  const started = performance.now();
  const data = new Float32Array(nodeCount * COEFFICIENTS_PER_NODE);
  // The part of `data` that the fog scattered into the paths. The fog drawn on screen already scatters the sun itself, so it reads the grid without this part.
  const scatteredData = medium ? new Float32Array(nodeCount * COEFFICIENTS_PER_NODE) : null;
  const valid = new Uint8Array(nodeCount);
  const point = [0, 0, 0];
  const axisLight = [new Float64Array(3), new Float64Array(3)];
  const axisScattered = [new Float64Array(3), new Float64Array(3)];
  const axisSky = [0, 0];
  const axisNormal = [0, 0, 0];
  const [width, height] = layout.size;
  let solidNodes = 0;
  for (let node = 0; node < nodeCount; node++) {
    if (performance.now() - started > maxSeconds * 1000) {
      throw new Error(`Irradiance grid trace passed maxSeconds (${maxSeconds}).`);
    }
    point[0] = layout.origin[0] + (node % width) * layout.cellSize;
    point[1] = layout.origin[1] + (Math.floor(node / width) % height) * layout.cellSize;
    point[2] = layout.origin[2] + Math.floor(node / (width * height)) * layout.cellSize;
    if (isInsideSolid(world, tracer, point)) {
      solidNodes++;
      continue;
    }
    valid[node] = 1;
    for (let axis = 0; axis < 3; axis++) {
      for (let side = 0; side < 2; side++) {
        axisNormal.fill(0);
        axisNormal[axis] = side === 0 ? 1 : -1;
        axisSky[side] = gather(point, axisNormal, node * 6 + axis * 2 + side, axisLight[side], axisScattered[side]);
      }
      const skyBase = node * COEFFICIENTS_PER_NODE + SKY_SLOT;
      data[skyBase] += (axisSky[0] + axisSky[1]) / 6;
      data[skyBase + 1 + axis] = (axisSky[0] - axisSky[1]) / 2;
      for (let channel = 0; channel < 3; channel++) {
        const base = node * COEFFICIENTS_PER_NODE + channel * 4;
        data[base] += (axisLight[0][channel] + axisLight[1][channel]) / 6;
        data[base + 1 + axis] = (axisLight[0][channel] - axisLight[1][channel]) / 2;
        if (scatteredData) {
          scatteredData[base] += (axisScattered[0][channel] + axisScattered[1][channel]) / 6;
          scatteredData[base + 1 + axis] = (axisScattered[0][channel] - axisScattered[1][channel]) / 2;
        }
      }
    }
  }
  const traced = Uint8Array.from(valid);
  const target = [0, 0, 0];
  const isConnected = (from, to) => {
    if (!traced[from] || !traced[to]) {
      return false;
    }
    nodePoint(layout, from, point);
    nodePoint(layout, to, target);
    const dx = target[0] - point[0];
    const dy = target[1] - point[1];
    const dz = target[2] - point[2];
    const length = Math.hypot(dx, dy, dz);
    return tracer.trace(point[0], point[1], point[2], dx / length, dy / length, dz / length, length, true).nearestTriangle < 0;
  };
  if (scatteredData) {
    fillInvalidNodes(scatteredData, Uint8Array.from(valid), layout.size);
    smoothNodes(scatteredData, valid, layout.size, isConnected);
  }
  fillInvalidNodes(data, valid, layout.size);
  smoothNodes(data, valid, layout.size, isConnected);
  const grid = { ...layout, data, nodes: nodeCount, solidNodes, seconds: (performance.now() - started) / 1000 };
  if (scatteredData) {
    grid.fogScattered = scatteredData;
  }
  return withMeanRadiance(grid);
}

/**
 * The fog's scattering reads the grid without importing this lazy module: the mean light arriving at a point from every
 * direction is the constant term of the fit. Not enumerable, so the report that copies the grid's fields stays plain data,
 * and a grid that came back from a worker (which clones plain data only) gets it here. It leaves out the light the fog
 * itself scattered (`fogScattered`, same layout as `data`), which the fog on screen adds again with its own sun term.
 */
export function withMeanRadiance(grid) {
  if (!Object.hasOwn(grid, 'meanRadiance')) {
    Object.defineProperty(grid, 'meanRadiance', {
      value: position => {
        const total = evaluateIrradianceGrid(grid, position, NO_DIRECTION);
        if (!grid.fogScattered) return total;
        const scattered = evaluateIrradianceGrid({ ...grid, data: grid.fogScattered }, position, NO_DIRECTION);
        return total.map((value, channel) => Math.max(0, value - scattered[channel]));
      },
    });
  }
  return grid;
}

const NO_DIRECTION = Object.freeze([0, 0, 0]);

/** The light a surface with this normal receives from the grid at a point (trilinear, as the shader reads it): what the shader multiplies by the albedo. */
export function evaluateIrradianceGrid(grid, position, normal) {
  const coordinates = [0, 1, 2].map(axis => Math.min(Math.max((position[axis] + normal[axis] * grid.cellSize * 0.5 - grid.origin[axis]) / grid.cellSize, 0), grid.size[axis] - 1));
  const lower = coordinates.map(Math.floor);
  const fraction = coordinates.map((value, axis) => value - lower[axis]);
  const result = [0, 0, 0];
  for (let corner = 0; corner < 8; corner++) {
    const indices = [0, 1, 2].map(axis => Math.min(lower[axis] + ((corner >> axis) & 1), grid.size[axis] - 1));
    const weight = [0, 1, 2].reduce((product, axis) => product * ((corner >> axis) & 1 ? fraction[axis] : 1 - fraction[axis]), 1);
    const base = (indices[0] + grid.size[0] * (indices[1] + grid.size[1] * indices[2])) * COEFFICIENTS_PER_NODE;
    for (let channel = 0; channel < 3; channel++) {
      const offset = base + channel * 4;
      result[channel] += weight * (grid.data[offset] + grid.data[offset + 1] * normal[0] + grid.data[offset + 2] * normal[1] + grid.data[offset + 3] * normal[2]);
    }
  }
  return result.map(value => Math.max(value, 0));
}

function gridMaterial(liveMaterial, grid, wrappers) {
  if (!wrappers.has(liveMaterial)) {
    const wrapper = {};
    for (const field of Object.keys(liveMaterial)) {
      Object.defineProperty(wrapper, field, { enumerable: true, get: () => liveMaterial[field] });
    }
    Object.defineProperty(wrapper, 'irradianceGrid', { enumerable: true, value: grid });
    wrappers.set(liveMaterial, Object.freeze(wrapper));
  }
  return wrappers.get(liveMaterial);
}

/** Gives every part the grid, as a material wrapper that keeps reading the live material, so motion on colour still works. */
export function placeIrradianceGrid(parts, grid) {
  const wrappers = new Map();
  return parts.map(part => Object.freeze({ ...part, material: gridMaterial(part.material, grid, wrappers) }));
}

registerShaderFeatureCode('irradianceGrid', Object.freeze({
  declarations: [
    'uniform highp sampler3D irradianceGridTexture;',
    'uniform float irradianceGridEnabled;',
    'uniform vec4 irradianceGridOrigin;',
    'uniform vec3 irradianceGridSize;',
    // The grid stores light for the cosine lobe already, so this is the same unit as environmentDiffuse. The x axis is
    // lerped by hand because three nodes share a row of texels (one per colour channel); y and z use the hardware filter.
    'vec4 irradianceGridSample(vec3 position, vec3 normal) {',
    '  vec3 grid = clamp((position + normal * irradianceGridOrigin.w * 0.5 - irradianceGridOrigin.xyz) / irradianceGridOrigin.w, vec3(0.0), irradianceGridSize - 1.0);',
    '  float left = floor(grid.x);',
    '  float right = min(left + 1.0, irradianceGridSize.x - 1.0);',
    '  float blend = grid.x - left;',
    '  vec2 across = (grid.yz + 0.5) / irradianceGridSize.yz;',
    '  float rowWidth = 4.0 * irradianceGridSize.x;',
    '  vec4 direction = vec4(1.0, normal);',
    '  vec4 result = vec4(0.0);',
    '  for (int channel = 0; channel < 4; channel++) {',
    '    float slot = float(channel) + 0.5;',
    '    vec4 first = texture(irradianceGridTexture, vec3((4.0 * left + slot) / rowWidth, across));',
    '    vec4 second = texture(irradianceGridTexture, vec3((4.0 * right + slot) / rowWidth, across));',
    '    result[channel] = dot(mix(first, second, blend), direction);',
    '  }',
    '  return max(result, vec4(0.0));',
    '}',
    '',
  ].join('\n'),
  irradianceGridOcclusion: '  vec4 irradianceGridValue = irradianceGridEnabled > 0.5 ? irradianceGridSample(worldPosition, normal) : vec4(0.0, 0.0, 0.0, 1.0);\n  occlusion *= min(irradianceGridValue.a, 1.0);\n',
  irradianceGrid: '  if (irradianceGridEnabled > 0.5) radiance += color * (1.0 - metallic) * irradianceGridValue.rgb;\n',
}));

const rendererStates = new WeakMap();

function stateOf(renderer) {
  if (!rendererStates.has(renderer)) {
    const { context, program } = renderer;
    const locate = name => context.getUniformLocation(program, name);
    rendererStates.set(renderer, {
      textures: new Map(),
      enabled: locate('irradianceGridEnabled'),
      origin: locate('irradianceGridOrigin'),
      size: locate('irradianceGridSize'),
      bound: undefined,
    });
    // The sampler must never share a unit with a sampler of another type, so it points at its own unit from the first draw.
    context.uniform1i(locate('irradianceGridTexture'), TEXTURE_UNIT);
  }
  return rendererStates.get(renderer);
}

function uploadGrid(renderer, grid) {
  const context = renderer.context;
  const [nodesX, nodesY, nodesZ] = grid.size;
  const texture = context.createTexture();
  const previous = context.getParameter(context.TEXTURE_BINDING_3D);
  context.bindTexture(context.TEXTURE_3D, texture);
  context.texImage3D(context.TEXTURE_3D, 0, context.RGBA16F, nodesX * 4, nodesY, nodesZ, 0, context.RGBA, context.FLOAT, grid.data);
  context.texParameteri(context.TEXTURE_3D, context.TEXTURE_MIN_FILTER, context.LINEAR);
  context.texParameteri(context.TEXTURE_3D, context.TEXTURE_MAG_FILTER, context.LINEAR);
  for (const wrap of [context.TEXTURE_WRAP_S, context.TEXTURE_WRAP_T, context.TEXTURE_WRAP_R]) {
    context.texParameteri(context.TEXTURE_3D, wrap, context.CLAMP_TO_EDGE);
  }
  context.bindTexture(context.TEXTURE_3D, previous);
  renderer.textures.set(Symbol('irradiance-grid'), texture);
  return texture;
}

function bindGrid(renderer, mapState) {
  if (!renderer.shaderFeatures?.has('irradianceGrid')) {
    return;
  }
  const state = stateOf(renderer);
  const context = renderer.context;
  const grid = mapState[21] ?? null;
  if (!grid) {
    if (state.bound !== null) {
      context.uniform1f(state.enabled, 0);
      state.bound = null;
    }
    return;
  }
  if (!state.textures.has(grid)) {
    state.textures.set(grid, uploadGrid(renderer, grid));
  }
  // Other features share this unit when a batch needs them, so the texture is bound again for every batch with a grid.
  context.activeTexture(context.TEXTURE0 + TEXTURE_UNIT);
  context.bindTexture(context.TEXTURE_3D, state.textures.get(grid));
  if (state.bound !== grid) {
    context.uniform1f(state.enabled, 1);
    context.uniform4f(state.origin, grid.origin[0], grid.origin[1], grid.origin[2], grid.cellSize);
    context.uniform3f(state.size, grid.size[0], grid.size[1], grid.size[2]);
    state.bound = grid;
  }
}

const previousBind = layerTextureSupport.bind;
layerTextureSupport.bind = (renderer, mapState, layerState, batch) => {
  previousBind?.(renderer, mapState, layerState, batch);
  bindGrid(renderer, mapState);
};
