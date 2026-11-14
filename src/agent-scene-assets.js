import { normalizeEmissionMask } from './emission-mask.js';
import { invalidField } from './field-error.js';
import { mat4 } from 'gl-matrix';
import { normalizeDrive } from './agent-drive-schema.js';

// Placing decoded glTF assets inside a procedural recipe scene. A node with an `asset` field is a group: the scene
// turns each mesh part of the asset into a generated child node, so terrain, lights, procedural meshes and any number of
// placed assets share one graph, one set of lights and one renderer. Every placement of the same asset uses the same
// geometry and the same material objects, so the renderer draws the copies as one instanced batch per material.
// A placement with a `clip` gets its own decoded copy (an "instance" above 0), because a pose is state of one decoded asset.

// The `assets` module also serves map sequences, so a recipe with one loads no extra module entry in the scene.
export * from './agent-texture-sequence.js';

export const ASSET_PLACEMENT_LIMITS = Object.freeze({ maxPlacements: 512, maxAssets: 16, maxAnimatedPlacements: 16, maxOverrides: 32 });

// The crowd code registers itself here when it loads, so this file (which the MCP host imports) never pulls it in.
let crowdModule = null;

export function registerCrowdModule(module) {
  crowdModule = module;
}

function crowdCode() {
  if (!crowdModule) throw new Error('This recipe places a crowd, which loads on demand: await loadAgentSceneModules(recipe) before createAgentScene or apply.');
  return crowdModule;
}

const ASSET_ID = /^[a-f0-9]{64}$/;
const PLACEMENT_FIELDS = ['id', 'materials', 'clip', 'drive', 'crowd'];
const CLIP_FIELDS = ['index', 'start', 'speed', 'loop'];
const COLOR_FIELDS = ['color', 'emissiveColor'];
const UNIT_FIELDS = ['metallic', 'roughness', 'opacity'];
const OVERRIDE_FIELDS = ['name', 'id', 'tag', ...COLOR_FIELDS, ...UNIT_FIELDS, 'emission', 'emissionMask'];
// A tag an override may set: foliage and grass make an imported tree sway in the wind and shade like a grown one.
const OVERRIDE_TAGS = ['surface', 'foliage', 'grass'];

function knownKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField(label, value, 'an object, such as {}', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalidField(`${label}.${key}`, value[key], `no such field; use one of ${allowed.join(', ')}`, TypeError);
    }
  }
}

function colorVector(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(component => !Number.isFinite(component) || component < 0)) {
    throw invalidField(label, value, 'an array of 3 linear RGB numbers of 0 or more, such as [0.5, 0.2, 0.1]');
  }
  return [...value];
}

function normalizeMaterialOverride(override, index) {
  const path = `asset.materials[${index}]`;
  knownKeys(override, OVERRIDE_FIELDS, path);
  if (typeof override.name !== 'string' || !override.name || override.name.length > 256) {
    throw invalidField(`${path}.name`, override.name, 'the name of a source material, such as "paint"; scene_inspect lists the names under assets', TypeError);
  }
  const result = { name: override.name };
  if (override.id !== undefined) {
    if (typeof override.id !== 'string' || !override.id.trim() || override.id.length > 128) {
      throw invalidField(`${path}.id`, override.id, 'a handle of 1 to 128 characters that a material motion track can name, such as "stool-heat"', TypeError);
    }
    result.id = override.id;
  }
  if (override.tag !== undefined) {
    if (!OVERRIDE_TAGS.includes(override.tag)) throw invalidField(`${path}.tag`, override.tag, `one of ${OVERRIDE_TAGS.join(', ')}`);
    result.tag = override.tag;
  }
  for (const field of COLOR_FIELDS) {
    if (override[field] !== undefined) result[field] = colorVector(override[field], `${path}.${field}`);
  }
  for (const field of UNIT_FIELDS) {
    if (override[field] !== undefined) {
      if (!Number.isFinite(override[field]) || override[field] < 0 || override[field] > 1) {
        throw invalidField(`${path}.${field}`, override[field], 'a number from 0 to 1, such as 0.5');
      }
      result[field] = override[field];
    }
  }
  if (override.emission !== undefined) {
    if (!Number.isFinite(override.emission) || override.emission < 0) {
      throw invalidField(`${path}.emission`, override.emission, 'a number of 0 or more, such as 1');
    }
    result.emission = override.emission;
  }
  if (override.emissionMask !== undefined) {
    result.emissionMask = normalizeEmissionMask(override.emissionMask, `${path}.emissionMask`);
  }
  return result;
}

/** Validate the `asset` field of a node. Returns the canonical form kept in the recipe. */
export function normalizeAssetPlacement(value) {
  knownKeys(value, PLACEMENT_FIELDS, 'asset');
  if (typeof value.id !== 'string' || !ASSET_ID.test(value.id.toLowerCase())) {
    throw invalidField('asset.id', value.id, '64 hexadecimal characters, such as "ab12..." (a catalog asset id that asset_catalog lists)', TypeError);
  }
  const result = { id: value.id.toLowerCase() };
  if (value.materials !== undefined) {
    if (!Array.isArray(value.materials) || value.materials.length > ASSET_PLACEMENT_LIMITS.maxOverrides) {
      throw invalidField('asset.materials', Array.isArray(value.materials) ? `${value.materials.length} overrides` : value.materials, `a list of at most ${ASSET_PLACEMENT_LIMITS.maxOverrides} overrides, such as [{ "name": "paint", "color": [1, 0, 0] }]`);
    }
    const overrides = value.materials.map((override, index) => normalizeMaterialOverride(override, index));
    const handles = overrides.filter(override => override.id !== undefined).map(override => override.id);
    if (new Set(handles).size !== handles.length) {
      throw invalidField('asset.materials', `${handles.length} ids`, 'overrides that each have a different id, such as "stool-heat" and "bucket-heat"');
    }
    if (new Set(overrides.map(override => override.name)).size !== overrides.length) {
      throw invalidField('asset.materials', `${overrides.length} overrides`, 'overrides that each name a different source material, such as one override per name');
    }
    result.materials = overrides;
  }
  if (value.clip !== undefined) {
    knownKeys(value.clip, CLIP_FIELDS, 'asset.clip');
    const { index, start = 0, speed = 1, loop = true } = value.clip;
    if (!Number.isInteger(index) || index < 0) throw invalidField('asset.clip.index', index, 'a whole number of 0 or more, such as 0');
    if (!Number.isFinite(start) || start < 0 || start > 3600) throw invalidField('asset.clip.start', start, 'seconds from 0 to 3600, such as 0');
    if (!Number.isFinite(speed) || speed <= 0 || speed > 16) throw invalidField('asset.clip.speed', speed, 'a number above 0 and at most 16, such as 1');
    if (typeof loop !== 'boolean') throw invalidField('asset.clip.loop', loop, 'true or false', TypeError);
    result.clip = { index, start, speed, loop };
  }
  if (value.crowd !== undefined) {
    if (value.clip !== undefined || value.drive !== undefined) throw invalidField('asset.crowd', value.crowd, 'only one of clip, drive or crowd; drop the others, such as keeping just the crowd', TypeError);
    result.crowd = crowdCode().normalizeCrowd(value.crowd);
  }
  if (value.drive !== undefined) {
    if (value.clip !== undefined) throw invalidField('asset.drive', value.drive, 'a drive or a clip, not both; drop one, such as keeping just the drive', TypeError);
    result.drive = normalizeDrive(value.drive, 'asset.drive');
    if (result.drive.lights?.tailLights) {
      throw invalidField('asset.drive.lights.tailLights', value.drive.lights.tailLights, 'no tail lights on a placed asset, since placed assets share their materials; tail lights glow only in an asset recipe (motion.drive), such as motion.drive.lights.tailLights');
    }
  }
  return result;
}

/** The nodes a game recipe animates itself: a placed asset there is posed by the game's animation graph, frame by frame. */
export function gamePosedNodeIds(game) {
  const ids = new Set();
  if (game?.player?.animation && game.player.node) ids.add(game.player.node);
  for (const npc of game?.npcs ?? []) if (npc?.animation && npc.node) ids.add(npc.node);
  return ids;
}

function collectPlacements(value, found, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPlacements(item, found, depth + 1);
    return;
  }
  const placement = value.asset;
  if (placement && typeof placement === 'object' && typeof placement.id === 'string' && ASSET_ID.test(placement.id.toLowerCase())) {
    found.push(placement);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'asset') collectPlacements(child, found, depth + 1);
  }
}

/**
 * The catalog assets a recipe (or a list of edit operations) places: `{ id, copies }` where `copies` is how many decoded
 * copies the host should load. Copy 0 serves every unanimated placement; each placement with a clip takes its own copy.
 */
export function recipeAssetNeeds(value) {
  const placements = [];
  collectPlacements(value, placements);
  const needs = new Map();
  const posedNodes = gamePosedNodeIds(value?.game);
  const posedPlacements = (value?.nodes ?? []).filter(node => node.asset && posedNodes.has(node.id)).map(node => node.asset);
  for (const placement of placements) {
    const id = placement.id.toLowerCase();
    const need = needs.get(id) ?? { id, copies: 1 };
    if (placement.clip || placement.drive || placement.crowd || posedPlacements.includes(placement)) need.copies++;
    needs.set(id, need);
  }
  return [...needs.values()];
}

export function assetCopyKey(id, copy) {
  return `${id}:${copy}`;
}

export function jsonMaterial(source) {
  const result = {};
  for (const [field, value] of Object.entries(source)) {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      result[field] = value;
    } else if (Array.isArray(value) && value.every(entry => typeof entry === 'number')) {
      result[field] = [...value];
    }
  }
  return result;
}

function overrideFields(override) {
  const fields = {};
  if (override?.tag !== undefined) fields.tag = override.tag;
  for (const field of [...COLOR_FIELDS, ...UNIT_FIELDS, 'emission']) {
    if (override?.[field] !== undefined) fields[field] = override[field];
  }
  if (override?.emissionMask !== undefined) fields.emissionMask = Object.freeze({ ...override.emissionMask });
  return fields;
}

export function materialOutput(source, fields) {
  const output = { ...source };
  for (const [field, value] of Object.entries(fields)) {
    output[field] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  if (fields.emission !== undefined && fields.emission > 0 && !output.emissiveColor?.some(component => component > 0)) {
    output.emissiveColor = Object.freeze([1, 1, 1]);
  }
  return Object.freeze(output);
}

/**
 * Generate the geometries, materials and child nodes of every placement into a normalized recipe, in place.
 * `assets` maps assetCopyKey(id, copy) to a decoded parseGltf asset; `createAssetDrive` is the loaded drive module's builder. Returns what the scene keeps outside the recipe JSON.
 */
export function expandAssetPlacements(recipe, assets, limits, outputCache = new Map(), createAssetDrive = null) {
  const placed = recipe.nodes.filter(node => node.asset);
  const runtime = { placements: [], geometryParts: new Map(), materialOutputs: new Map(), partExtras: new Map(), animators: [] };
  if (!placed.length) return runtime;
  if (!assets) {
    throw new Error('This recipe places catalog assets, which a host loads and decodes first. Pass them as the assets option of createAgentScene; MCP does this for scene_create.');
  }
  const distinct = new Set(placed.map(node => node.asset.id));
  const posedNodes = gamePosedNodeIds(recipe.game);
  const isAnimated = node => Boolean(node.asset.clip || node.asset.drive || node.asset.crowd || posedNodes.has(node.id));
  const animated = placed.filter(isAnimated);
  if (placed.length > ASSET_PLACEMENT_LIMITS.maxPlacements || distinct.size > ASSET_PLACEMENT_LIMITS.maxAssets ||
      animated.length > ASSET_PLACEMENT_LIMITS.maxAnimatedPlacements) {
    throw new RangeError(`A scene places at most ${ASSET_PLACEMENT_LIMITS.maxPlacements} assets, ${ASSET_PLACEMENT_LIMITS.maxAssets} different ones, ${ASSET_PLACEMENT_LIMITS.maxAnimatedPlacements} of them playing a clip; this recipe places ${placed.length}, ${distinct.size} and ${animated.length}.`);
  }
  const copyCounter = new Map();
  const geometryIds = new Set();
  const materialIds = new Map();
  const handleOwners = new Map();
  const generatedNodes = [];
  for (const node of placed) {
    const { id: assetId, materials: overrides = [], clip, drive, crowd } = node.asset;
    const posed = posedNodes.has(node.id);
    let copy = 0;
    if (clip || drive || crowd || posed) {
      copy = (copyCounter.get(assetId) ?? 0) + 1;
      copyCounter.set(assetId, copy);
    }
    const asset = assets.get(assetCopyKey(assetId, copy));
    if (!asset) {
      throw new Error(`Asset ${assetId.slice(0, 12)} copy ${copy} is not loaded. The host loads it before createAgentScene or apply.`);
    }
    if (clip && !asset.animations[clip.index]) {
      throw invalidField(`nodes[${recipe.nodes.indexOf(node)}].asset.clip.index`, clip.index, `a clip index from 0 to ${asset.animations.length - 1}, since asset ${assetId.slice(0, 12)} has ${asset.animations.length} clips; scene_inspect lists them under assets`);
    }
    if (crowd) {
      const expanded = crowdCode().expandCrowd(recipe, node, asset, copy, outputCache, runtime, limits);
      generatedNodes.push(...expanded.nodes);
      runtime.placements.push(expanded.record);
      runtime.animators.push(expanded.record);
      continue;
    }
    const materialNames = new Set(asset.parts.map(part => part.material.name).filter(Boolean));
    for (const override of overrides) {
      if (!materialNames.has(override.name)) {
        throw invalidField(`nodes[${recipe.nodes.indexOf(node)}].asset.materials[${overrides.indexOf(override)}].name`, override.name, `one of ${[...materialNames].slice(0, 16).map(name => JSON.stringify(name)).join(', ') || 'none, since the asset materials are unnamed'}`);
      }
    }
    const overrideByName = new Map(overrides.map(override => [override.name, override]));
    const materialIndexes = new Map();
    const partNodeIds = [];
    asset.parts.forEach((part, index) => {
      const geometryId = `asset:${assetId.slice(0, 12)}:${copy}:${index}`;
      if (!geometryIds.has(geometryId)) {
        geometryIds.add(geometryId);
        recipe.geometries.push({ id: geometryId, type: 'asset', assetId, copy, part: index });
        runtime.geometryParts.set(geometryId, part.geometry);
      }
      if (!materialIndexes.has(part.material)) materialIndexes.set(part.material, materialIndexes.size);
      const fields = overrideFields(overrideByName.get(part.material.name));
      const override = overrideByName.get(part.material.name);
      const materialKey = override?.id === undefined
        ? `asset:${assetId.slice(0, 12)}:${copy}:${materialIndexes.get(part.material)}:${JSON.stringify(fields)}`
        : handledMaterialKey(override.id, materialIndexes.get(part.material), handleOwners, recipe, node);
      if (!materialIds.has(materialKey)) {
        materialIds.set(materialKey, materialKey);
        recipe.materials.push({ id: materialKey, ...jsonMaterial(part.material), ...fields, assetSource: true, ...(override?.id === undefined ? {} : { animatable: true }) });
        // The same output object across stages keeps the renderer's batches and the parts' identity stable.
        // A handled material keeps its id when the override changes, so the cache also compares the override fields.
        const fieldsKey = JSON.stringify(fields);
        const cached = outputCache.get(materialKey);
        if (cached?.source !== part.material || cached.fieldsKey !== fieldsKey) {
          outputCache.set(materialKey, { source: part.material, fieldsKey, output: materialOutput(part.material, fields) });
        }
        runtime.materialOutputs.set(materialKey, outputCache.get(materialKey).output);
      }
      const partNodeId = `${node.id}/${index}`;
      partNodeIds.push(partNodeId);
      generatedNodes.push({
        id: partNodeId, parent: node.id, label: String(part.name ?? partNodeId).slice(0, 256),
        translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        geometry: geometryId, material: materialKey, assetPart: { placement: node.id, index, matrix: Array.from(part.matrix) },
      });
      runtime.partExtras.set(partNodeId, {
        ...(part.skin ? { skin: part.skin } : {}), ...(part.morph ? { morph: part.morph } : {}),
        ...(part.castShadow !== undefined ? { castShadow: part.castShadow } : {}),
      });
    });
    const record = { node: node.id, assetId, copy, asset, partNodeIds, clip: clip ?? null, pose: posed ? { nodeOverrides: [], morphWeights: undefined } : null, drive: drive ? createDrive(node.id, `nodes[${recipe.nodes.indexOf(node)}].asset.drive`, createAssetDrive, asset, drive) : null, drivePose: null };
    runtime.placements.push(record);
    if (clip || drive || posed) runtime.animators.push(record);
  }
  if (recipe.nodes.length + generatedNodes.length > limits.maxNodes) {
    throw new RangeError(`Placed assets expand to ${generatedNodes.length} part nodes, which with the ${recipe.nodes.length} authored nodes exceeds maxNodes ${limits.maxNodes}. Place fewer copies or simpler assets.`);
  }
  recipe.nodes.push(...generatedNodes);
  return runtime;
}

// An override with an id gets a material of its own named by that id, so a motion track can drive it. A second source
// material of the same name in one placement takes the id plus its index.
function handledMaterialKey(handle, materialIndex, handleOwners, recipe, node) {
  const key = materialIndex === 0 ? handle : `${handle}~${materialIndex}`;
  const authored = recipe.materials.some(material => material.id === key && !material.assetSource);
  if (authored || (handleOwners.has(key) && handleOwners.get(key) !== node.id)) {
    throw invalidField(`nodes[${recipe.nodes.indexOf(node)}].asset.materials`, handle, 'an id that no other material or placed asset override uses, such as one id per placement');
  }
  handleOwners.set(key, node.id);
  return key;
}

function createDrive(nodeId, fieldPath, createAssetDrive, asset, drive) {
  if (!createAssetDrive) throw new Error('This recipe drives a placed asset, which needs the drive code: await loadAgentSceneModules(recipe) before createAgentScene or apply.');
  try {
    return createAssetDrive(asset, drive, { fieldPath });
  } catch (error) {
    if (typeof error?.fieldPath !== 'string') error.message = `Node ${nodeId} drive: ${error.message}`;
    throw error;
  }
}

/** The time inside a clip for a scene time: held at the first frame before `start`, then looped or held at the end. */
export function clipTimeAt(clip, duration, time) {
  const elapsed = Math.max(0, ((time ?? 0) - clip.start) * clip.speed);
  if (duration <= 0) return 0;
  return clip.loop ? elapsed % duration : Math.min(elapsed, duration);
}

/**
 * Pose every animated placement at a scene time. Returns the world matrix of each part node and a commit/discard pair;
 * the pose is staged first so a failure leaves every asset where it was.
 */
export function stageAssetClips(runtime, graph, time) {
  const transactions = [];
  const matrices = new Map();
  try {
    for (const record of runtime.animators) {
      let transaction;
      if (record.crowd) {
        transactions.push(record.crowd.stage(time ?? 0));
        continue;
      }
      if (record.pose) {
        transaction = record.asset.stagePose({ animation: null, nodeOverrides: record.pose.nodeOverrides, morphWeights: record.pose.morphWeights });
      } else if (record.drive) {
        const driven = record.drive.sample(time ?? 0);
        record.drivePose = driven.pose;
        transaction = record.asset.stagePose({ nodeOverrides: driven.nodeOverrides });
      } else {
        const duration = record.asset.animations[record.clip.index].duration;
        transaction = record.asset.stagePose({ animation: { clip: record.clip.index, time: clipTimeAt(record.clip, duration, time) }, nodeOverrides: [] });
      }
      transactions.push(transaction);
      const placement = graph.getNode(record.node).worldMatrix;
      record.partNodeIds.forEach((id, index) => {
        matrices.set(id, mat4.multiply(new Float32Array(16), placement, transaction.parts[index].matrix));
      });
    }
  } catch (error) {
    for (const transaction of transactions) transaction.discard();
    throw error;
  }
  return {
    matrices,
    commit() {
      for (const transaction of transactions) transaction.commit();
    },
  };
}

/** What scene_inspect reports for each placement: the asset id, its world bounds, its clips and material names. */
export function describeAssetPlacements(runtime, graph, geometryBounds) {
  return runtime.placements.map(record => {
    if (record.crowd) return record.crowd.describe();
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    for (const id of record.partNodeIds) {
      const node = graph.getNode(id);
      const bounds = geometryBounds(node.geometry);
      for (let corner = 0; corner < 8; corner++) {
        const point = [0, 1, 2].map(axis => (corner & (1 << axis) ? bounds.max[axis] : bounds.min[axis]));
        for (let axis = 0; axis < 3; axis++) {
          const value = node.worldMatrix[axis] * point[0] + node.worldMatrix[4 + axis] * point[1] + node.worldMatrix[8 + axis] * point[2] + node.worldMatrix[12 + axis];
          minimum[axis] = Math.min(minimum[axis], value);
          maximum[axis] = Math.max(maximum[axis], value);
        }
      }
    }
    return {
      node: record.node, assetId: record.assetId, parts: record.partNodeIds.length,
      bounds: { min: minimum, max: maximum },
      clips: record.asset.animations.map((animation, index) => ({ index, name: animation.name ?? `clip ${index}`, duration: animation.duration })),
      materials: [...new Set(record.asset.parts.map(part => part.material.name).filter(Boolean))],
      ...(record.clip ? { playing: record.clip } : {}),
      ...(record.drive ? { drive: record.drive.describe(record.drivePose ?? undefined) } : {}),
    };
  });
}
