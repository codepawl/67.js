import { mat4 } from 'gl-matrix';
import { leafTextureDescriptor } from './vegetation-textures.js';
import { SPECIES, createTree, scatterVegetation, levelForDistance } from './vegetation.js';
import { createRecipeTerrain } from './agent-terrain.js';
import { invalidField } from './field-error.js';

// Recipe vegetation: a group node with a `vegetation` field grows one tree, or scatters trees over a terrain node. The
// result reuses the placed-asset channel of agent-scene.js: generated geometries (type "asset"), materials (assetSource)
// and part nodes (assetPart), so exports and edits already skip them. Everything is a pure function of the recipe: the
// same seed grows the same trees, and levels of detail come from the recipe camera, never from the frame being drawn.

export const VEGETATION_LIMITS = Object.freeze({
  maxInstances: 1000, maxVariants: 4, maxExclusions: 32, maxCandidates: 4000, maxCachedSets: 4,
});
const SCATTER_SPECIES = [...Object.keys(SPECIES), 'grass', 'flowers'];
const VEGETATION_FIELDS = ['species', 'mix', 'seed', 'height', 'leaves', 'season', 'cullDistance', 'distanceScale', 'scatter'];
const SCATTER_FIELDS = ['ground', 'density', 'slopeLimit', 'area', 'exclude', 'variants', 'scale'];
const EXCLUSION_FIELDS = ['center', 'radius', 'min', 'max', 'node'];
const GROUND_EDGE_MARGIN = 0.5;
const SEASON_TARGETS = Object.freeze([[0.35, [196, 150, 40]], [0.6, [186, 84, 26]], [0.85, [112, 66, 34]]]);
const GRASS_CARD_COLOR = [80, 128, 40];
const BARE_SEASON = 0.9;
const DECIDUOUS_SPECIES = new Set(['broadleaf', 'birch', 'bush']);

function knownKeys(value, allowed, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField(path, value, 'an object, such as {}', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalidField(`${path}.${key}`, value[key], `no such field; use one of ${allowed.join(', ')}`, TypeError);
  }
}

function numberWithin(value, minimum, maximum, path) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidField(path, value, `a number from ${minimum} to ${maximum}, such as ${Math.min(Math.max(1, minimum), maximum)}`);
  }
  return value;
}

function planePoint(value, path) {
  if (!Array.isArray(value) || value.length !== 2 || value.some(component => !Number.isFinite(component))) {
    throw invalidField(path, value, '[x, z] in metres, such as [0, 0]', TypeError);
  }
  return [...value];
}

function normalizeExclusion(value, path) {
  knownKeys(value, EXCLUSION_FIELDS, path);
  if (value.min !== undefined || value.max !== undefined) {
    const min = planePoint(value.min, `${path}.min`);
    const max = planePoint(value.max, `${path}.max`);
    if (max[0] <= min[0] || max[1] <= min[1]) throw invalidField(`${path}.max`, max, `[x, z] above min ${JSON.stringify(min)} on both axes`);
    return { min, max };
  }
  const radius = numberWithin(value.radius, 0.01, 2000, `${path}.radius`);
  if (value.node !== undefined) {
    if (typeof value.node !== 'string' || !value.node) throw invalidField(`${path}.node`, value.node, 'a node ID, such as "pond"', TypeError);
    return { node: value.node, radius };
  }
  return { center: planePoint(value.center, `${path}.center`), radius };
}

function normalizeScatter(value, path) {
  knownKeys(value, SCATTER_FIELDS, path);
  if (typeof value.ground !== 'string' || !value.ground) throw invalidField(`${path}.ground`, value.ground, 'the ID of a terrain node, such as "ground"', TypeError);
  const result = {
    ground: value.ground,
    density: numberWithin(value.density ?? 0.012, 0.0001, 4, `${path}.density`),
    slopeLimit: numberWithin(value.slopeLimit ?? 32, 0, 90, `${path}.slopeLimit`),
    variants: numberWithin(value.variants ?? 3, 1, VEGETATION_LIMITS.maxVariants, `${path}.variants`),
    exclude: [],
  };
  if (!Number.isInteger(result.variants)) throw invalidField(`${path}.variants`, result.variants, `a whole number from 1 to ${VEGETATION_LIMITS.maxVariants}, such as 3`);
  if (value.exclude !== undefined) {
    if (!Array.isArray(value.exclude) || value.exclude.length > VEGETATION_LIMITS.maxExclusions) {
      throw invalidField(`${path}.exclude`, Array.isArray(value.exclude) ? `${value.exclude.length} areas` : value.exclude, `a list of at most ${VEGETATION_LIMITS.maxExclusions} areas, such as [{ "center": [0, 0], "radius": 5 }]`);
    }
    result.exclude = value.exclude.map((entry, index) => normalizeExclusion(entry, `${path}.exclude[${index}]`));
  }
  if (value.area !== undefined) {
    knownKeys(value.area, ['min', 'max'], `${path}.area`);
    result.area = { min: planePoint(value.area.min, `${path}.area.min`), max: planePoint(value.area.max, `${path}.area.max`) };
    if (result.area.max[0] <= result.area.min[0] || result.area.max[1] <= result.area.min[1]) {
      throw invalidField(`${path}.area.max`, result.area.max, `[x, z] above min ${JSON.stringify(result.area.min)} on both axes`);
    }
  }
  if (value.scale !== undefined) {
    if (!Array.isArray(value.scale) || value.scale.length !== 2) throw invalidField(`${path}.scale`, value.scale, '[min, max], such as [0.8, 1.2]', TypeError);
    result.scale = [numberWithin(value.scale[0], 0.1, 10, `${path}.scale[0]`), numberWithin(value.scale[1], 0.1, 10, `${path}.scale[1]`)];
    if (result.scale[1] < result.scale[0]) throw invalidField(`${path}.scale`, value.scale, '[min, max] with max not below min, such as [0.8, 1.2]');
  }
  return result;
}

/** Validate environment.wind: strength 0 to 4 (0.3) and direction in degrees (0 toward +x, 90 toward +z). */
export function normalizeWind(value) {
  knownKeys(value, ['strength', 'direction'], 'environment.wind');
  return {
    strength: numberWithin(value.strength ?? 0.3, 0, 4, 'environment.wind.strength'),
    direction: numberWithin(value.direction ?? 0, -360, 360, 'environment.wind.direction'),
  };
}

// The placed-asset runtime with the vegetation maps added to it, and the report for scene_inspect.
function mergedRuntime(placed, vegetation) {
  return {
    ...placed,
    vegetation: vegetation.report,
    geometryParts: new Map([...placed.geometryParts, ...vegetation.geometryParts]),
    materialOutputs: new Map([...placed.materialOutputs, ...vegetation.materialOutputs]),
    partExtras: new Map([...placed.partExtras, ...vegetation.partExtras]),
  };
}

/** Validate the `vegetation` field of a node (`node` is the whole node, which must be a group). Returns the canonical form kept in the recipe. */
export function normalizeVegetation(value, node) {
  const conflict = node && ['geometry', 'skin', 'asset'].find(field => node[field] !== undefined);
  if (conflict) {
    throw invalidField(conflict, node[conflict], 'nothing, because a node that grows vegetation is a group; drop geometry, material, skin and asset', TypeError);
  }
  knownKeys(value, VEGETATION_FIELDS, 'vegetation');
  const result = {};
  if ((value.species === undefined) === (value.mix === undefined)) {
    throw invalidField('vegetation.species', value.species, 'exactly one of species (one tree, such as "broadleaf") or mix (a scatter, such as { "broadleaf": 3, "bush": 1 })', TypeError);
  }
  if (value.species !== undefined) {
    if (!SCATTER_SPECIES.includes(value.species) || (!value.scatter && !SPECIES[value.species])) {
      throw invalidField('vegetation.species', value.species, `one of ${(value.scatter ? SCATTER_SPECIES : Object.keys(SPECIES)).join(', ')}`);
    }
    result.species = value.species;
  } else {
    if (!value.scatter) throw invalidField('vegetation.scatter', value.scatter, 'a scatter, such as { "ground": "ground" }, because mix needs one; a single tree takes species', TypeError);
    if (!value.mix || typeof value.mix !== 'object' || Array.isArray(value.mix)) throw invalidField('vegetation.mix', value.mix, 'an object that maps species to weights, such as { "broadleaf": 3, "bush": 1 }', TypeError);
    result.mix = {};
    for (const [name, weight] of Object.entries(value.mix)) {
      if (!SCATTER_SPECIES.includes(name)) throw invalidField('vegetation.mix', name, `species names among ${SCATTER_SPECIES.join(', ')}`);
      result.mix[name] = numberWithin(weight, 0, 100, `vegetation.mix.${name}`);
    }
    if (!Object.values(result.mix).some(weight => weight > 0)) throw invalidField('vegetation.mix', value.mix, 'at least one positive weight, such as { "broadleaf": 1 }');
  }
  result.seed = numberWithin(value.seed ?? 1, -2147483648, 2147483647, 'vegetation.seed');
  if (value.height !== undefined) result.height = numberWithin(value.height, 0.2, 80, 'vegetation.height');
  result.leaves = value.leaves ?? 'cards';
  if (result.leaves !== 'cards' && result.leaves !== 'mesh') throw invalidField('vegetation.leaves', result.leaves, '"cards" or "mesh"');
  result.season = numberWithin(value.season ?? 0, 0, 1, 'vegetation.season');
  if (value.cullDistance !== undefined) result.cullDistance = numberWithin(value.cullDistance, 1, 100_000, 'vegetation.cullDistance');
  result.distanceScale = numberWithin(value.distanceScale ?? 1, 0.1, 10, 'vegetation.distanceScale');
  if (value.scatter !== undefined) result.scatter = normalizeScatter(value.scatter, 'vegetation.scatter');
  return result;
}

/** A leaf colour (0 to 255 sRGB) for a season: summer keeps the species colour, then 0.35 gold, 0.6 orange and 0.85 brown. */
export function seasonLeafColor(base, season) {
  const stops = [[0, base], ...SEASON_TARGETS];
  if (season >= stops[stops.length - 1][0]) return [...stops[stops.length - 1][1]];
  let index = 0;
  while (season > stops[index + 1][0]) index++;
  const [startSeason, startColor] = stops[index];
  const [endSeason, endColor] = stops[index + 1];
  const fraction = (season - startSeason) / (endSeason - startSeason);
  return startColor.map((channel, axis) => Math.round(channel + (endColor[axis] - channel) * fraction));
}

// Cards recolour their procedural leaf sprite, because a colour factor cannot turn a green leaf orange; mesh leaves and grass blades recolour the material.
function seasonalMaterial(material, variant, species, season) {
  if (material.map) {
    const preset = SPECIES[species];
    const kind = species === 'grass' ? 'grass' : material === variant.materials.crown ? 'clump' : preset.leaf.texture;
    const base = species === 'grass' ? GRASS_CARD_COLOR : preset.leaf.color;
    return { ...material, map: leafTextureDescriptor(kind, seasonLeafColor(base, season)) };
  }
  const base = material.color.map(channel => channel ** (1 / 2.2) * 255);
  return { ...material, color: seasonLeafColor(base, season).map(channel => (channel / 255) ** 2.2) };
}

function nodeWorldMatrix(nodes, node) {
  const byId = new Map(nodes.map(candidate => [candidate.id, candidate]));
  let matrix = mat4.fromRotationTranslationScale(mat4.create(), node.rotation, node.translation, node.scale);
  let parent = node.parent === null ? null : byId.get(node.parent);
  for (let depth = 0; parent && depth < 256; depth++) {
    const local = mat4.fromRotationTranslationScale(mat4.create(), parent.rotation, parent.translation, parent.scale);
    matrix = mat4.multiply(mat4.create(), local, matrix);
    parent = parent.parent === null ? null : byId.get(parent.parent);
  }
  return matrix;
}

function groundTerrain(recipe, scatter) {
  const ground = recipe.nodes.find(node => node.id === scatter.ground);
  const definition = ground && recipe.geometries.find(geometry => geometry.id === ground.geometry);
  if (definition?.type !== 'terrain') {
    throw invalidField('vegetation.scatter.ground', scatter.ground, 'the ID of a node that draws a terrain geometry, such as "ground"; give the group node the same transform as the ground');
  }
  return { definition, terrain: createRecipeTerrain(definition) };
}

function scatterArea(scatter, definition) {
  const half = (definition.size ?? 40) / 2 - GROUND_EDGE_MARGIN;
  const area = scatter.area ?? { min: [-half, -half], max: [half, half] };
  return {
    minX: Math.max(area.min[0], -half), maxX: Math.min(area.max[0], half),
    minZ: Math.max(area.min[1], -half), maxZ: Math.min(area.max[1], half),
  };
}

function exclusionTest(recipe, scatter, terrain) {
  const areas = scatter.exclude.map(entry => {
    if (entry.min) return (x, z) => x >= entry.min[0] && x <= entry.max[0] && z >= entry.min[1] && z <= entry.max[1];
    let center = entry.center;
    if (entry.node) {
      const target = recipe.nodes.find(node => node.id === entry.node);
      if (!target) throw invalidField('vegetation.scatter.exclude[].node', entry.node, 'the ID of a node in the recipe, such as "pond"');
      center = [target.translation[0], target.translation[2]];
    }
    return (x, z) => Math.hypot(x - center[0], z - center[1]) <= entry.radius;
  });
  return (x, z) => terrain.isHole(x, z) || areas.some(test => test(x, z));
}

/** The options `scatterVegetation` gets for a scatter node: the same call an addon user makes, so both give the same instances. */
export function scatterOptionsFor(recipe, vegetation) {
  const { scatter } = vegetation;
  const { definition, terrain } = groundTerrain(recipe, scatter);
  const area = scatterArea(scatter, definition);
  const candidates = (area.maxX - area.minX) * (area.maxZ - area.minZ) * scatter.density;
  if (candidates > VEGETATION_LIMITS.maxCandidates) {
    throw invalidField('vegetation.scatter.density', scatter.density, `a density that tries at most ${VEGETATION_LIMITS.maxCandidates} trees over the area (this tries about ${Math.round(candidates)}); lower it or give a smaller area`);
  }
  return {
    area, density: scatter.density, terrainHeight: terrain.heightAt, slopeLimit: scatter.slopeLimit,
    exclusion: exclusionTest(recipe, scatter, terrain), seed: vegetation.seed, mix: vegetation.mix ?? { [vegetation.species]: 1 },
    variants: scatter.variants, leaves: vegetation.leaves, ...(scatter.scale ? { scale: scatter.scale } : {}),
  };
}

function grow(recipe, vegetation) {
  if (!vegetation.scatter) {
    const tree = createTree({ species: vegetation.species, leaves: vegetation.leaves, ...(vegetation.height ? { height: vegetation.height } : {}) }, vegetation.seed);
    return { variants: [tree], instances: [{ variant: tree, matrix: mat4.create(), species: vegetation.species }] };
  }
  const scattered = scatterVegetation(scatterOptionsFor(recipe, vegetation));
  if (scattered.instances.length > VEGETATION_LIMITS.maxInstances) {
    throw invalidField('vegetation.scatter.density', vegetation.scatter.density, `a density that places at most ${VEGETATION_LIMITS.maxInstances} instances (this placed ${scattered.instances.length}); lower it or give a smaller area`);
  }
  return { variants: Object.values(scattered.variants).flat(), instances: scattered.instances };
}

function cacheKey(recipe, node) {
  const { vegetation } = node;
  const ground = vegetation.scatter ? recipe.geometries.find(geometry => geometry.id === recipe.nodes.find(candidate => candidate.id === vegetation.scatter.ground)?.geometry) : null;
  const named = vegetation.scatter?.exclude.filter(entry => entry.node).map(entry => recipe.nodes.find(candidate => candidate.id === entry.node)?.translation);
  const { season, cullDistance, distanceScale, ...growth } = vegetation;
  return JSON.stringify([growth, ground, named]);
}

function materialJson(material) {
  return {
    tag: material.tag ?? 'surface', color: [...material.color], metallic: material.metallic ?? 0, roughness: material.roughness ?? 0.5,
    emission: material.emission ?? 0, opacity: 1, alphaMode: material.alphaMode ?? 'opaque',
    doubleSided: Boolean(material.doubleSided),
  };
}

/**
 * Generate the geometries, materials and part nodes of every vegetation node into a normalized recipe, in place.
 * `cache` (the scene's asset output map) holds grown trees across edits, so a camera or season edit does not grow them again.
 * Returns the runtime maps the scene merges with the placed-asset ones, and a report for scene_inspect.
 */
export function expandVegetation(recipe, limits, cache, placedRuntime) {
  cache.serial ??= 0;
  const planted = recipe.nodes.filter(node => node.vegetation);
  const runtime = { geometryParts: new Map(), materialOutputs: new Map(), partExtras: new Map(), report: [] };
  const generatedNodes = [];
  const geometryIds = new Set();
  const eye = recipe.camera?.eye ?? [0, 0, 0];
  for (const node of planted) {
    const { vegetation } = node;
    const key = `vegetation:${cacheKey(recipe, node)}`;
    if (!cache.has(key)) {
      // The scene shares this map with its placed assets, so only grown sets are evicted.
      const grownKeys = [...cache.keys()].filter(candidate => candidate.startsWith('vegetation:'));
      if (grownKeys.length >= VEGETATION_LIMITS.maxCachedSets) cache.delete(grownKeys[0]);
      cache.set(key, { serial: ++cache.serial, grown: grow(recipe, vegetation), outputs: new Map() });
    }
    const entry = cache.get(key);
    const bare = vegetation.season >= BARE_SEASON;
    const world = nodeWorldMatrix(recipe.nodes, node);
    const variantIds = new Map(entry.grown.variants.map((variant, index) => [variant, index]));
    const materialIds = new Map();
    const bySpecies = {};
    let triangles = 0;
    let culled = 0;
    entry.grown.instances.forEach((instance, instanceIndex) => {
      const position = [instance.matrix[12], instance.matrix[13], instance.matrix[14]];
      const worldPosition = [
        world[0] * position[0] + world[4] * position[1] + world[8] * position[2] + world[12],
        world[1] * position[0] + world[5] * position[1] + world[9] * position[2] + world[13],
        world[2] * position[0] + world[6] * position[1] + world[10] * position[2] + world[14],
      ];
      const distance = Math.hypot(eye[0] - worldPosition[0], eye[1] - worldPosition[1], eye[2] - worldPosition[2]);
      const level = levelForDistance(distance, instance.variant, { distanceScale: vegetation.distanceScale, cullDistance: vegetation.cullDistance });
      const counts = bySpecies[instance.species] ??= { instances: 0, levels: [] };
      counts.instances++;
      if (level < 0) {
        culled++;
        return;
      }
      counts.levels[level] = (counts.levels[level] ?? 0) + 1;
      const leafless = bare && DECIDUOUS_SPECIES.has(instance.species);
      const seasonal = DECIDUOUS_SPECIES.has(instance.species) || instance.species === 'grass';
      instance.variant.levels[level].parts.forEach((part, partIndex) => {
        if (leafless && part.tintable) return;
        const geometryId = `vegetation:${entry.serial}:${variantIds.get(instance.variant)}:${level}:${partIndex}`;
        if (!geometryIds.has(geometryId)) {
          geometryIds.add(geometryId);
          recipe.geometries.push({ id: geometryId, type: 'asset', vegetation: entry.serial });
          runtime.geometryParts.set(geometryId, part.geometry);
        }
        const tinted = part.tintable && seasonal && vegetation.season > 0;
        if (!materialIds.has(part.material)) materialIds.set(part.material, materialIds.size);
        const materialId = `vegetation:${entry.serial}:${variantIds.get(instance.variant)}:${materialIds.get(part.material)}:${tinted ? `s${vegetation.season}` : 'plain'}`;
        if (!runtime.materialOutputs.has(materialId)) {
          if (!entry.outputs.has(materialId)) {
            entry.outputs.set(materialId, Object.freeze(tinted ? seasonalMaterial(part.material, instance.variant, instance.species, vegetation.season) : { ...part.material }));
          }
          runtime.materialOutputs.set(materialId, entry.outputs.get(materialId));
          recipe.materials.push({ id: materialId, ...materialJson(entry.outputs.get(materialId)), assetSource: true });
        }
        const partNodeId = `${node.id}/${instanceIndex}/${part.role}`;
        generatedNodes.push({
          id: partNodeId, parent: node.id, label: `${instance.species} ${part.role}`,
          translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
          geometry: geometryId, material: materialId, assetPart: { placement: node.id, index: instanceIndex, matrix: Array.from(instance.matrix) },
        });
        if (part.shadowLods) runtime.partExtras.set(partNodeId, { shadowLods: part.shadowLods });
        triangles += part.geometry.indices.length / 3;
      });
    });
    runtime.report.push({
      node: node.id, mode: vegetation.scatter ? 'scatter' : 'tree', instances: entry.grown.instances.length, culled,
      season: vegetation.season, bare, triangles,
      species: Object.fromEntries(Object.entries(bySpecies).map(([name, counts]) => [name, { instances: counts.instances, levels: Array.from(counts.levels, count => count ?? 0) }])),
    });
  }
  if (recipe.nodes.length + generatedNodes.length > limits.maxNodes) {
    throw invalidField('vegetation.scatter.density', `${generatedNodes.length} generated part nodes`, `a density that keeps authored plus generated nodes (${recipe.nodes.length} authored) within maxNodes ${limits.maxNodes}; lower it or cull far trees with cullDistance`);
  }
  recipe.nodes.push(...generatedNodes);
  return mergedRuntime(placedRuntime, runtime);
}
