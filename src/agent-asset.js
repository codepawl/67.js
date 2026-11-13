import { mat4, mat3 } from 'gl-matrix';
import { createAgentScene, REVISION_HISTORY_LIMIT } from './agent-scene.js';
import { environmentPatchWithSetup } from './agent-look.js';
import { assetDiagnostics } from './agent-diagnostics.js';
import { fitPerspectiveDistance } from './camera.js';
import { validateSkinGeometry, validateSkinPose } from './skinning.js';
import { validateMorphGeometry, validateMorphTransform } from './morph.js';
import * as agentMotion from './agent-motion.js';
import { compileClipStrip } from './clip-strip.js';
import { clipLayerContextFromAsset, retargetSourceFromAsset } from './agent-clip-layers.js';
import { retargetAssetClip, retargetReport } from './agent-retarget.js';
import { createFootLock } from './foot-lock.js';
import { clipFromGltfAnimation, createAssetLayerEvaluator, morphClipFromGltfAnimation } from './skeleton-pose.js';
import { registerAgentSceneModule, agentSceneModule } from './agent-scene-modules.js';
import { normalizeMeshEditEntries, meshEditEntriesAfter, realizeMeshEdits, meshEditSignature } from './agent-asset-mesh.js';
import { invalidField, withFieldPrefix } from './field-error.js';

registerAgentSceneModule('motion', agentMotion);

const MAX_MESH_REPORTS = 16;

const MAX_RECIPE_BYTES = 1024 * 1024;
const MAX_CHECKPOINTS = 8;
const MAX_OPERATIONS = 256;
const MAX_INSPECTION_VERTICES = 2_000_000;
const ROOT_FIELDS = ['translation', 'rotation', 'scale'];
const MATERIAL_FIELDS = ['color', 'metallic', 'roughness', 'emission', 'emissiveColor'];
const LOOK_FIELDS = ['environment', 'effects', 'shadow'];
const LOOK_OPERATIONS = Object.freeze({
  'set-environment': 'environment',
  'set-effects': 'effects',
  'set-shadow': 'shadow',
});

export const AGENT_ASSET_CAPABILITIES = Object.freeze({
  format: '67js.asset', schemaVersion: 1, fixedTopology: false,
  operations: Object.freeze([
    'set-camera', 'set-environment', 'set-effects', 'set-shadow',
    'set-root', 'set-animation', 'set-material', 'set-asset-node', 'set-motion', 'set-physics', 'edit-mesh',
  ]),
  motionDrive: 'drive {path | legs [{path, direction forward|reverse, pause}], cruiseSpeed | speed, wheels auto | [{id,node,side,axle,radius}], lights {headlights, tailLights [{material,signal brake|reverse,off,on}]}}: a car along a path; duration may be left out. scene_inspect motionDrive reports wheels, rejectedNames and light signals; docs/vehicle.md has every field',
  ragdoll: 'physics {duration, floor?, ragdoll {}}: joints fall limp onto a floor at world height floor (default 0)',
  boundsKind: 'authored-base-world',
});

function knownKeys(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw invalidField(label, value, 'a plain JSON object, such as {}', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) {
      throw invalidField(`${label}.${key}`, value[key], `no such field; use one of ${fields.join(', ')}`, TypeError);
    }
  }
}

function copiedJson(input) {
  let bytes = 0;
  const ancestors = new Set();
  const encoder = new TextEncoder();
  function charge(count) {
    bytes += count;
    if (bytes > MAX_RECIPE_BYTES) {
      throw new RangeError('Asset recipe JSON exceeds 1 MiB. Reduce the input.');
    }
  }
  function copy(value, depth) {
    if (depth > 64) {
      throw new RangeError('Asset recipe JSON nesting exceeds 64 levels.');
    }
    if (value === null || typeof value === 'boolean') {
      charge(value === null ? 4 : String(value).length);
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Math.fround(value))) {
      charge(String(value).length);
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_RECIPE_BYTES) {
        throw new RangeError('Asset recipe JSON exceeds 1 MiB.');
      }
      charge(encoder.encode(JSON.stringify(value)).length);
      return value;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) {
      throw new TypeError('Asset recipe requires finite, acyclic JSON data.');
    }
    const array = Array.isArray(value);
    if (array && (value.length > MAX_RECIPE_BYTES || Object.getPrototypeOf(value) !== Array.prototype)) {
      throw new TypeError('Asset recipe arrays must be ordinary bounded JSON arrays.');
    }
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('Asset recipe objects must be plain JSON objects.');
    }
    ancestors.add(value);
    charge(2);
    const result = array ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') {
        continue;
      }
      if (typeof key !== 'string' || key === '__proto__') {
        throw new TypeError('Invalid asset recipe JSON key.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Asset recipe accessors and hidden fields are unsupported.');
      }
      if (array && key !== String(result.length)) {
        throw new TypeError('Asset recipe arrays must be dense without extra fields.');
      }
      charge(array ? 1 : encoder.encode(JSON.stringify(key)).length + 2);
      result[key] = copy(descriptor.value, depth + 1);
    }
    if (array && result.length !== value.length) {
      throw new TypeError('Asset recipe arrays cannot contain trailing holes.');
    }
    ancestors.delete(value);
    return result;
  }
  const result = copy(input, 0);
  if (encoder.encode(JSON.stringify(result)).length > MAX_RECIPE_BYTES) {
    throw new RangeError('Asset recipe JSON exceeds 1 MiB.');
  }
  return result;
}

function vector(value, length, label) {
  if (!Array.isArray(value) || value.length !== length ||
      !value.every(component => typeof component === 'number' && Number.isFinite(Math.fround(component)))) {
    throw invalidField(label, value, `an array of ${length} finite numbers, such as [${Array(length).fill(1).join(', ')}]`, TypeError);
  }
  return [...value];
}

function rootFrom(input = {}, path = 'root') {
  knownKeys(input, ROOT_FIELDS, path);
  const root = {
    translation: vector(input.translation === undefined ? [0, 0, 0] : input.translation, 3, `${path}.translation`),
    rotation: vector(input.rotation === undefined ? [0, 0, 0, 1] : input.rotation, 4, `${path}.rotation`),
    scale: vector(input.scale === undefined ? [1, 1, 1] : input.scale, 3, `${path}.scale`),
  };
  const rotationLength = Math.hypot(...root.rotation);
  if (rotationLength === 0 || root.scale.some(component => Math.fround(component) <= 0)) {
    if (rotationLength === 0) {
      throw invalidField(`${path}.rotation`, input.rotation, 'a quaternion that is not all zero, such as [0, 0, 0, 1]');
    }
    throw invalidField(`${path}.scale`, root.scale, 'positive numbers, such as [1, 1, 1]');
  }
  root.rotation = root.rotation.map(component => component / rotationLength);
  return root;
}

function viewRecipe(input, materials = []) {
  const recipe = { format: '67js.scene', schemaVersion: 1, geometries: [], materials, nodes: [] };
  for (const field of ['camera', ...LOOK_FIELDS]) {
    if (Object.hasOwn(input, field)) {
      recipe[field] = input[field];
    }
  }
  return createAgentScene(recipe, { maxMaterials: Math.max(256, materials.length) }).exportRecipe();
}

function geometryMaxima(geometry) {
  const maximum = [0, 0, 0];
  for (let offset = 0; offset < geometry.positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      maximum[axis] = Math.max(maximum[axis], Math.abs(geometry.positions[offset + axis]));
    }
  }
  return maximum;
}

function localBounds(geometry) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < geometry.positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], geometry.positions[offset + axis]);
      maximum[axis] = Math.max(maximum[axis], geometry.positions[offset + axis]);
    }
  }
  return { min: minimum, max: maximum };
}

function framingBounds(geometryInfos, matrices) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < geometryInfos.length; index++) {
    const bounds = geometryInfos[index].bounds;
    const matrix = matrices[index];
    for (let corner = 0; corner < 8; corner++) {
      const point = bounds.min.map((component, axis) => corner & (1 << axis) ? bounds.max[axis] : component);
      for (let axis = 0; axis < 3; axis++) {
        const value = matrix[axis] * point[0] + matrix[axis + 4] * point[1] +
          matrix[axis + 8] * point[2] + matrix[axis + 12];
        minimum[axis] = Math.min(minimum[axis], value);
        maximum[axis] = Math.max(maximum[axis], value);
      }
    }
  }
  return { min: minimum, max: maximum };
}

function validatePositionBounds(maxima, world, skin) {
  for (let row = 0; row < 4; row++) {
    let coordinateBound = 0;
    for (let column = 0; column < 4; column++) {
      let coefficient = Math.abs(world[column * 4 + row]);
      if (skin) {
        coefficient = 0;
        for (let axis = 0; axis < 4; axis++) {
          let paletteBound = 0;
          for (let offset = column * 4 + axis; offset < skin.jointMatrices.length; offset += 16) {
            paletteBound = Math.max(paletteBound, Math.abs(skin.jointMatrices[offset]));
          }
          coefficient += Math.abs(world[axis * 4 + row]) * paletteBound * (1 + 2 ** -21);
          if (!Number.isFinite(Math.fround(coefficient))) {
            throw new RangeError('Asset world/skin matrix products exceed Float32 range.');
          }
        }
      }
      coordinateBound += coefficient * (column === 3 ? 1 : maxima[column]);
      if (!Number.isFinite(Math.fround(coordinateBound))) {
        throw new RangeError('Asset world geometry bounds exceed Float32 range.');
      }
    }
  }
}

function baseBounds(geometries, matrices) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < geometries.length; index++) {
    const positions = geometries[index].positions;
    const matrix = matrices[index];
    for (let offset = 0; offset < positions.length; offset += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value = matrix[axis] * positions[offset] + matrix[4 + axis] * positions[offset + 1] +
          matrix[8 + axis] * positions[offset + 2] + matrix[12 + axis];
        minimum[axis] = Math.min(minimum[axis], value);
        maximum[axis] = Math.max(maximum[axis], value);
      }
    }
  }
  return { min: minimum, max: maximum };
}

function framedCamera(bounds) {
  const target = bounds.min.map((component, axis) => (component + bounds.max[axis]) / 2);
  const radius = Math.hypot(...bounds.max.map((component, axis) => (component - bounds.min[axis]) / 2));
  const near = Math.max(0.001, radius * 0.001);
  const far = Math.max(10, radius * 10);
  const probeDistance = Math.max(1, radius);
  const directionLength = Math.hypot(4, 3, 5);
  const direction = [4, 3, 5].map(component => component / directionLength);
  const camera = {
    target, eye: target.map((component, axis) => component + direction[axis] * probeDistance),
    up: [0, 1, 0], fov: 45, near, far,
  };
  const distance = fitPerspectiveDistance({ minimum: bounds.min, maximum: bounds.max }, camera, 1, 1.2);
  camera.eye = target.map((component, axis) => component + direction[axis] * distance);
  return camera;
}

/** Own authoring state around one exclusively owned, decoded parseGltf asset. */
export function createAgentAssetScene(asset, inputRecipe, { sources } = {}) {
  if (!asset || !Array.isArray(asset.parts) || !Array.isArray(asset.animations) ||
      typeof asset.stagePose !== 'function' || !Array.isArray(asset.nodes)) {
    throw new TypeError('createAgentAssetScene requires a decoded parseGltf asset.');
  }
  if (!asset.parts.length) {
    throw new TypeError('This file has no meshes, so there is nothing to draw. A skeleton-only file works as a clip source: set motion.layers[].from on a character that has a mesh.');
  }
  if (asset.parts.length > 4096 || asset.animations.length > 256 ||
      new Set(asset.parts.map(part => part.material)).size > 4096) {
    throw new RangeError('Asset budgets allow 4096 parts, 4096 materials, and 256 animation clips.');
  }
  const sourceParts = [...asset.parts];
  const materials = new Map();
  const geometries = new Map();
  const morphMetadata = new Map();
  const records = sourceParts.map((source, index) => {
    if (!materials.has(source.material)) {
      const id = `material-${materials.size}`;
      const baseline = {};
      for (const field of MATERIAL_FIELDS) {
        const value = source.material[field];
        if (value !== undefined) {
          baseline[field] = Array.isArray(value) ? [...value] : value;
        }
      }
      materials.set(source.material, { id, baseline });
    }
    if (!geometries.has(source.geometry)) {
      const metadata = validateMorphGeometry(source.geometry, source.morph);
      if (metadata) {
        morphMetadata.set(source.geometry, metadata);
      }
      geometries.set(source.geometry, {
        id: `geometry-${geometries.size}`, maxima: geometryMaxima(source.geometry), bounds: localBounds(source.geometry),
      });
    }
    validateSkinGeometry(source.geometry, source.skin);
    return {
      id: `mesh-${index}`, label: String(source.name ?? `Mesh ${index}`).slice(0, 256), source,
      geometry: geometries.get(source.geometry), material: materials.get(source.material),
      sourceMatrix: source.matrix, jointMatrices: source.skin?.jointMatrices,
      jointWorldMatrices: source.skin?.jointWorldMatrices, morphWeights: source.morph?.weights,
    };
  });
  const materialRecords = new Map([...materials.values()].map(record => [record.id, record]));
  const sourceNodes = new Map(asset.nodes.map(node => [node.id, structuredClone(node)]));
  const clipLayerContext = clipLayerContextFromAsset(asset.animations, [...sourceNodes.values()]);
  /** Other catalog assets whose clips layers may retarget, by asset ID: decoded `{ animations, nodes }`. */
  function provideMotionSources(decodedSources) {
    for (const [sourceId, decoded] of Object.entries(decodedSources ?? {})) {
      if (/^[a-f0-9]{64}$/i.test(sourceId)) clipLayerContext.external.set(sourceId.toLowerCase(), retargetSourceFromAsset(decoded));
    }
  }
  provideMotionSources(sources);
  // Morph targets by the names the file gives them, so motion can key a weight by name; defaults fill a part no layer drives.
  const morphTargetIndex = new Map();
  const morphDefaults = sourceParts.map(part => (part.morph ? Float32Array.from(part.morph.weights) : null));
  sourceParts.forEach((part, partIndex) => {
    (part.morphTargetNames ?? []).forEach((name, index) => {
      if (!morphTargetIndex.has(name)) morphTargetIndex.set(name, []);
      morphTargetIndex.get(name).push({ part: partIndex, index });
    });
  });
  const initialRecipe = copiedJson(inputRecipe);
  const assetId = initialRecipe?.assetId;
  if (typeof assetId !== 'string' || !/^[a-f0-9]{64}$/i.test(assetId)) {
    throw invalidField('assetId', assetId, '64 hexadecimal characters, such as "ab12..." (the SHA256 that scene_create_asset returned)', TypeError);
  }
  const canonicalAssetId = assetId.toLowerCase();
  const cameraOmitted = !Object.hasOwn(initialRecipe, 'camera');
  let recipe;
  let materialSnapshots = new Map();
  let matrices = [];
  let revision = 0;
  let sampler = null;
  let physicsSampler = null;
  let physicsBake = null;
  let layerEvaluator = null;
  let footLockEvaluator = null;
  let motionTime = null;
  let sampledCamera;
  const checkpoints = new Map();
  // Earlier recipes, oldest first. A published recipe is never edited in place, so the reference is a safe snapshot.
  const revisionHistory = [];
  const materialOutputs = new Map([...materials].map(([source, record]) => {
    const output = {};
    for (const [field, value] of Object.entries(source)) {
      if (!MATERIAL_FIELDS.includes(field)) {
        output[field] = Array.isArray(value) ? Object.freeze([...value]) : value;
      }
    }
    for (const field of MATERIAL_FIELDS) {
      Object.defineProperty(output, field, {
        enumerable: true,
        get() {
          return materialSnapshots.get(record.id)[field];
        },
      });
    }
    return [record.id, Object.freeze(output)];
  }));
  // Parts of edited meshes carry rebuilt geometry. The matrices stay the same arrays, so poses keep writing to them.
  const partMatrices = records.map(record => new Float32Array(record.source.matrix));
  let editedParts = new Map();
  let editSignature = meshEditSignature(editedParts);
  let topologyRevision = 0;

  /** A part by its ID (mesh-3); anything else that is not a source node is an unknown ID. */
  function partRecordFor(id) {
    const record = records.find(value => value.id === id);
    if (!record) {
      throw invalidField('geometry', id, 'an imported mesh ID such as "mesh-0", or a source node ID; call scene_inspect without ids to list the meshes, or with kind hierarchy for source nodes');
    }
    return record;
  }

  /** The parts scene_inspect lists for one ID: a mesh ID is that part; a source node is every part of it and of the nodes below it. */
  function inspectedRecordsFor(id, originNodes = new Map()) {
    const sourceNode = sourceNodes.get(id);
    if (!sourceNode || records.some(value => value.id === id)) {
      return [partRecordFor(id)];
    }
    const found = collectNodeRecords(id);
    for (const record of found) {
      if (!record.isSourceNodeReport) {
        originNodes.set(record.id, id);
      }
    }
    return found;
  }

  /** A source node with no part anywhere below it (a joint or an empty): its transform at rest, so an agent can aim at it or pose it. */
  function sourceNodeReport(sourceNode) {
    const world = mat4.create();
    const chain = [];
    for (let current = sourceNode; current; current = current.parent ? sourceNodes.get(current.parent) : null) {
      chain.unshift(current);
    }
    for (const link of chain) {
      mat4.multiply(world, world, mat4.fromRotationTranslationScale(mat4.create(), link.rotation, link.translation, link.scale));
    }
    return {
      isSourceNodeReport: true, id: sourceNode.id, label: sourceNode.label, name: sourceNode.name, parent: sourceNode.parent,
      joint: Boolean(sourceNode.joint), translation: [...sourceNode.translation], rotation: [...sourceNode.rotation], scale: [...sourceNode.scale],
      restWorldPosition: [world[12], world[13], world[14]], meshIds: [],
    };
  }

  /** Every part of a source node and of the nodes below it; with no part anywhere below it, the node's own report. */
  function collectNodeRecords(id) {
    const partIds = [];
    const pending = [id];
    while (pending.length > 0) {
      const nodeId = pending.pop();
      partIds.push(...(sourceNodes.get(nodeId).meshIds ?? []));
      pending.push(...[...sourceNodes.values()].filter(node => node.parent === nodeId).map(node => node.id));
    }
    if (partIds.length === 0) {
      return [sourceNodeReport(sourceNodes.get(id))];
    }
    return records.filter(value => partIds.includes(value.id));
  }

  function geometryOf(record, edited = editedParts) {
    return edited.get(record.id)?.geometry ?? record.source.geometry;
  }

  function geometryInfoOf(record, edited = editedParts) {
    return edited.get(record.id)?.info ?? record.geometry;
  }

  function morphMetadataOf(record, edited = editedParts) {
    return edited.get(record.id)?.morphMetadata ?? morphMetadata.get(record.source.geometry);
  }

  function describeGeometry(geometry) {
    return { maxima: geometryMaxima(geometry), bounds: localBounds(geometry) };
  }

  function buildParts(edited) {
    return Object.freeze(records.map((record, index) => {
      const part = {
        name: record.id, geometry: geometryOf(record, edited),
        matrix: partMatrices[index], material: materialOutputs.get(record.material.id),
      };
      if (record.source.skin) {
        part.skin = record.source.skin;
      }
      if (record.source.morph) {
        part.morph = record.source.morph;
      }
      if (record.source.castShadow !== undefined) {
        part.castShadow = record.source.castShadow;
      }
      return Object.freeze(part);
    }));
  }

  let parts = buildParts(editedParts);
  const capabilities = Object.freeze({
    ...AGENT_ASSET_CAPABILITIES,
    animations: asset.animations.length,
    skinning: parts.some(part => Boolean(part.skin)),
    morphTargets: parts.some(part => Boolean(part.morph)),
    textures: [...materialOutputs.values()].some(material => Boolean(material.map || material.normalMap ||
      material.metallicRoughnessMap || material.occlusionMap || material.emissiveMap)),
  });

  function normalize(input) {
    const candidate = copiedJson(input);
    knownKeys(candidate, ['format', 'schemaVersion', 'assetId', 'camera', ...LOOK_FIELDS, 'root', 'animation', 'materialOverrides', 'nodeOverrides', 'motion', 'physics', 'meshEdits'], 'asset recipe');
    if (candidate.format !== '67js.asset' || candidate.schemaVersion !== 1 ||
        typeof candidate.assetId !== 'string' || candidate.assetId.toLowerCase() !== canonicalAssetId) {
      const wrongField = candidate.format !== '67js.asset' ? 'format' : candidate.schemaVersion !== 1 ? 'schemaVersion' : 'assetId';
      const expectedValue = wrongField === 'format' ? '"67js.asset"' : wrongField === 'schemaVersion' ? '1' : `the bound asset ID, such as "${canonicalAssetId.slice(0, 8)}..."`;
      throw invalidField(wrongField, candidate[wrongField], expectedValue);
    }
    const overrides = candidate.materialOverrides === undefined ? [] : candidate.materialOverrides;
    if (!Array.isArray(overrides) || overrides.length > materialRecords.size) {
      throw invalidField('materialOverrides', Array.isArray(overrides) ? `${overrides.length} entries` : overrides, `an array of at most ${materialRecords.size} entries, one per decoded material, such as []`);
    }
    const seen = new Set();
    const definitions = overrides.map((override, index) => {
      knownKeys(override, ['id', ...MATERIAL_FIELDS], `materialOverrides[${index}]`);
      const original = materialRecords.get(override.id);
      if (!original || seen.has(override.id)) {
        throw invalidField(`materialOverrides[${index}].id`, override.id, `the ID of a decoded material, used once; one of ${[...materialRecords.keys()].slice(0, 5).join(', ')}`);
      }
      seen.add(override.id);
      return { id: override.id, ...original.baseline, ...override };
    });
    const view = viewRecipe(candidate, definitions);
    const normalizedOverrides = view.materials.map(material => {
      const result = { id: material.id };
      for (const field of MATERIAL_FIELDS) {
        if (material[field] !== undefined) {
          result[field] = material[field];
        }
      }
      return result;
    });
    const animation = candidate.animation === undefined ? null : candidate.animation;
    if (animation !== null) {
      knownKeys(animation, ['clip', 'time'], 'animation');
      const clipCount = asset.animations.length;
      const clip = asset.animations[animation.clip];
      if (!Number.isInteger(animation.clip) || !clip || !Number.isFinite(animation.time) ||
          animation.time < 0 || animation.time > clip.duration) {
        if (!Number.isInteger(animation.clip) || !clip) {
          throw invalidField('animation.clip', animation.clip, clipCount === 0 ? 'no animation, since this asset has no clips; drop it, such as null' : `a clip index from 0 to ${clipCount - 1}, such as 0`);
        }
        throw invalidField('animation.time', animation.time, `seconds from 0 to ${clip.duration}, such as 0`);
      }
    }
    const nodeOverrides = candidate.nodeOverrides === undefined ? [] : candidate.nodeOverrides;
    if (!Array.isArray(nodeOverrides) || nodeOverrides.length > sourceNodes.size) {
      throw invalidField('nodeOverrides', Array.isArray(nodeOverrides) ? `${nodeOverrides.length} entries` : nodeOverrides, `an array of at most ${sourceNodes.size} entries, one per source node, such as []`);
    }
    const seenNodes = new Set();
    const normalizedNodes = nodeOverrides.map((override, index) => {
      knownKeys(override, ['id', ...ROOT_FIELDS], `nodeOverrides[${index}]`);
      const node = sourceNodes.get(override.id);
      if (!node || seenNodes.has(override.id) || !node.editable) {
        throw invalidField(`nodeOverrides[${index}].id`, override.id, 'the ID of an editable source node, used once; call scene_inspect with kind hierarchy to list them');
      }
      seenNodes.add(override.id);
      const fields = Object.keys(override).filter(field => field !== 'id');
      if (!fields.length) {
        throw invalidField(`nodeOverrides[${index}]`, override, 'an id plus at least one of translation, rotation or scale, such as { "id": "node-1", "translation": [0, 1, 0] }');
      }
      const transform = rootFrom(Object.fromEntries(fields.map(field => [field, override[field]])), `nodeOverrides[${index}]`);
      return { id: override.id, ...Object.fromEntries(fields.map(field => [field, transform[field]])) };
    });
    const result = copiedJson({
      format: '67js.asset', schemaVersion: 1, assetId: canonicalAssetId,
      camera: view.camera, environment: view.environment, effects: view.effects, shadow: view.shadow,
      root: rootFrom(candidate.root), animation, materialOverrides: normalizedOverrides, nodeOverrides: normalizedNodes,
    });
    const meshEdits = normalizeMeshEditEntries(candidate.meshEdits, records);
    if (meshEdits.length) {
      result.meshEdits = meshEdits;
    }
    if ((candidate.motion?.ik?.length || candidate.motion?.springs || candidate.motion?.footLock) && Math.max(...result.root.scale) - Math.min(...result.root.scale) > 1e-3 * Math.max(...result.root.scale)) {
      throw invalidField('root.scale', result.root.scale, 'the same number on every axis, such as [1, 1, 1], because motion ik, springs and footLock need a uniform asset root scale');
    }
    result.motion = agentMotion.normalizeAgentMotion(candidate.motion, motionRecipe(result));
    if (candidate.physics !== undefined && candidate.physics !== null) {
      result.physics = agentSceneModule('physics').normalizeAssetPhysics(candidate.physics);
    }
    return copiedJson(result);
  }

  /** The drive of motion.drive for this asset. Built once per distinct entry: the rig and the speed profile cost a simulation. */
  const builtDrives = new Map();
  function buildDrive(drive) {
    const key = JSON.stringify(drive);
    if (!builtDrives.has(key)) {
      builtDrives.set(key, agentSceneModule('drive').createAssetDrive(asset, drive, { materialIds: new Set(materialRecords.keys()) }));
    }
    return builtDrives.get(key);
  }

  function motionRecipe(candidate) {
    const baselines = new Map([...materialRecords].map(([id, record]) => [id, { id, ...record.baseline }]));
    for (const override of candidate.materialOverrides) {
      baselines.set(override.id, { ...baselines.get(override.id), ...override });
    }
    const root = candidate.root;
    return {
      nodes: [...sourceNodes.values()].filter(node => node.editable),
      materials: [...baselines.values()], camera: candidate.camera,
      buildDrive, normalizeDrive: (input, path) => agentSceneModule('drive').normalizeDrive(input, path), ikHierarchy: [...sourceNodes.values()], clipLayerContext, morphTargets: [...morphTargetIndex.keys()],
      ikRootMatrix: Array.from(mat4.fromRotationTranslationScale(mat4.create(), root.rotation, root.translation, [root.scale[0], root.scale[0], root.scale[0]])),
    };
  }

  /** Stage clip and overrides without publishing them, and read the local pose IK must start from. */
  function stagedNodePoses(animation, overrides) {
    const probe = asset.stagePose({ animation, nodeOverrides: overrides });
    try {
      return probe.nodePoses();
    } finally {
      probe.discard();
    }
  }

  /** A clip of another catalog asset moved onto this asset's rest pose. Cached: the same layer always gives the same clip. */
  const retargetedClips = new Map();
  function retargetedLayerClip(layer, loop) {
    const key = JSON.stringify([layer.from, layer.scale, layer.rootMotion, loop]);
    if (!retargetedClips.has(key)) {
      const source = clipLayerContext.external.get(layer.from.asset);
      const sourceClip = clipFromGltfAnimation(source.animations[layer.from.clip], { loop });
      retargetedClips.set(key, retargetAssetClip(source.nodes, asset.nodes, sourceClip, { scale: layer.scale, rootMotion: layer.rootMotion }));
    }
    return retargetedClips.get(key);
  }

  /** Foot lock over the motion's layers, or null when the motion does not ask for it. */
  function compileFootLock(candidate) {
    const motion = candidate.motion;
    if (!motion?.footLock) return null;
    return createFootLock({
      settings: motion.footLock, nodes: asset.nodes, rootMatrix: motionRecipe(candidate).ikRootMatrix,
      layers: layerDefinitions(motion.layers), duration: motion.duration, loop: motion.loop,
    });
  }

  /** Weights keyed by morph target name replace what layers or the file's defaults give those targets. */
  function keyedMorphWeights(layerWeights, keyed) {
    if (!keyed?.size) return layerWeights;
    const byPart = new Map(layerWeights.map(({ part, weights }) => [part, weights]));
    for (const [name, patch] of keyed) {
      for (const { part, index } of morphTargetIndex.get(name) ?? []) {
        if (!byPart.has(part)) byPart.set(part, Array.from(morphDefaults[part]));
        byPart.get(part)[index] = patch.weight;
      }
    }
    return [...byPart].map(([part, weights]) => ({ part, weights }));
  }

  /**
   * A strip times its layer: the fade envelope multiplies the layer's weight and the strip maps motion time to clip
   * time. The clip holds its ends, since the strip does the repeating.
   */
  function stripTiming(layer) {
    if (!layer.strip) return { loop: layer.loop !== false, timing: {} };
    const duration = layer.from ? clipLayerContext.external.get(layer.from.asset).clips[layer.from.clip].duration : asset.animations[layer.clip].duration;
    const compiled = compileClipStrip(layer.strip, duration);
    const base = layer.weight ?? 1;
    return { loop: false, timing: { weight: time => base * compiled.weight(time), clipTime: compiled.clipTime } };
  }

  /** Layers of the motion as definitions for the pose code: decoded clips, renamed by `bones`, with their morph tracks. */
  function layerDefinitions(layers) {
    return layers.map(layer => {
      const { loop, timing } = stripTiming(layer);
      const common = { weight: layer.weight, speed: layer.speed, offset: layer.offset, additive: layer.additive, reference: layer.reference, mask: layer.mask, ...timing };
      if (layer.from) return { clip: retargetedLayerClip(layer, loop), ...common };
      const animation = asset.animations[layer.clip];
      return {
        clip: clipFromGltfAnimation(animation, { loop, rename: layer.bones }),
        ...(layer.morph === false ? {} : { morphs: morphClipFromGltfAnimation(animation, { loop }) }),
        ...common,
      };
    });
  }

  /** Evaluates the motion's clip layers at a time, or null when it has none. Stateless, so a seek equals playing. */
  function compileLayers(motion) {
    return motion?.layers?.length ? createAssetLayerEvaluator(asset, layerDefinitions(motion.layers)) : null;
  }

  /** Where tracks, layers and the recipe's own overrides meet: the recipe's overrides, then layers, then tracks on top. */
  function poseOverrides(baseOverrides, layerEvaluator, sampled, time) {
    const layered = layerEvaluator?.evaluate(time);
    const withLayers = new Map(baseOverrides.map(override => [override.id, override]));
    for (const override of layered?.nodeOverrides ?? []) {
      withLayers.set(override.id, { ...withLayers.get(override.id), ...override });
    }
    return { nodeOverrides: trackOverrides([...withLayers.values()], sampled), morphWeights: keyedMorphWeights(layered?.morphWeights ?? [], sampled?.morphs) };
  }

  function trackOverrides(baseOverrides, sampled) {
    const nodeOverrides = new Map(baseOverrides.map(override => [override.id, override]));
    for (const [id, patch] of sampled?.nodes ?? []) {
      const copiedPatch = Object.fromEntries(Object.entries(patch).map(([field, value]) => [field, Array.from(value)]));
      nodeOverrides.set(id, { ...nodeOverrides.get(id), id, ...copiedPatch });
    }
    return nodeOverrides;
  }

  /** A ragdoll bake costs a solver run, so an unchanged section on an unchanged starting pose reuses the last one. */
  function stageAssetPhysics(candidate) {
    if (!candidate.physics) return null;
    const key = JSON.stringify([candidate.physics, candidate.animation, candidate.nodeOverrides, candidate.root]);
    if (physicsBake?.key !== key) {
      const root = candidate.root;
      const rootMatrix = mat4.fromRotationTranslationScale(mat4.create(), root.rotation, root.translation, root.scale);
      const startingPoses = stagedNodePoses(candidate.animation, candidate.nodeOverrides);
      physicsBake = { key, sampler: agentSceneModule('physics').bakeAssetRagdoll(candidate.physics, [...sourceNodes.values()], startingPoses, rootMatrix) };
    }
    return physicsBake.sampler;
  }

  /** Joint poses from the ragdoll at a time. Physics holds its last pose after its duration. */
  function ragdollOverrides(stagedPhysics, time) {
    const patches = stagedPhysics.sample(Math.min(time, stagedPhysics.duration));
    return [...patches].map(([id, patch]) => ({ id, translation: Array.from(patch.translation), rotation: Array.from(patch.rotation) }));
  }

  function publish(input, autoFrame = false, increment = true, transientTime = undefined, transientAnimation = undefined) {
    let candidate = transientTime === undefined ? normalize(input) : recipe;
    if (transientAnimation !== undefined) {
      candidate = { ...candidate, animation: transientAnimation };
    }
    let stagedSampler = transientTime === undefined ? agentMotion.compileAgentMotion(candidate.motion, motionRecipe(candidate)) : sampler;
    const stagedLayers = transientTime === undefined ? compileLayers(candidate.motion) : layerEvaluator;
    const stagedFootLock = transientTime === undefined ? compileFootLock(candidate) : footLockEvaluator;
    const stagedPhysics = transientTime === undefined ? stageAssetPhysics(candidate) : physicsSampler;
    const targetTime = transientTime === undefined ? (candidate.motion || candidate.physics ? 0 : null) : transientTime;
    if (targetTime !== null && !stagedSampler && !stagedPhysics) {
      throw new RangeError('The asset has no authored motion or physics to sample.');
    }
    let sampled = targetTime === null ? null : stagedSampler?.sample(targetTime);
    if (asset.parts.length !== records.length) {
      throw new RangeError('Decoded part membership must remain fixed.');
    }
    const stagedEdits = realizeMeshEdits(candidate.meshEdits ?? [], records, editedParts, describeGeometry);
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const source = record.source;
      if (asset.parts[index] !== source || geometryOf(record) !== parts[index].geometry ||
          source.skin !== parts[index].skin || source.morph !== parts[index].morph ||
          source.matrix !== record.sourceMatrix || source.skin?.jointMatrices !== record.jointMatrices ||
          source.skin?.jointWorldMatrices !== record.jointWorldMatrices || source.morph?.weights !== record.morphWeights ||
          parts[index].matrix.length !== 16 || parts[index].matrix.byteLength !== 64) {
        throw new RangeError('Decoded resources and retained adapter matrices must not change identity or detach.');
      }
    }
    const { nodeOverrides, morphWeights } = poseOverrides(candidate.nodeOverrides, targetTime === null ? null : stagedLayers, sampled, targetTime);
    if (targetTime !== null && stagedFootLock) {
      const nodePoses = stagedNodePoses(candidate.animation, [...nodeOverrides.values()]);
      for (const override of stagedFootLock.solve(targetTime, nodePoses)) {
        if (sourceNodes.get(override.id)?.editable) nodeOverrides.set(override.id, { ...nodeOverrides.get(override.id), ...override });
      }
    }
    if (targetTime !== null && stagedSampler?.ikUsesStagedPose) {
      const nodePoses = stagedNodePoses(candidate.animation, [...nodeOverrides.values()]);
      for (const override of stagedSampler.solveStagedPose(targetTime, nodePoses)) {
        nodeOverrides.set(override.id, { ...nodeOverrides.get(override.id), ...override });
      }
    }
    if (targetTime !== null && stagedPhysics) {
      for (const override of ragdollOverrides(stagedPhysics, targetTime)) {
        nodeOverrides.set(override.id, { ...nodeOverrides.get(override.id), ...override });
      }
    }
    let transaction;
    try {
      transaction = asset.stagePose({ animation: candidate.animation, nodeOverrides: [...nodeOverrides.values()], morphWeights });
      const rootMatrix = mat4.fromRotationTranslationScale(mat4.create(), candidate.root.rotation, candidate.root.translation, candidate.root.scale);
      const normal = mat3.create();
      const stagedMatrices = records.map((record, index) => {
        const posed = transaction.parts[index];
        const world = mat4.multiply(mat4.create(), rootMatrix, posed.matrix);
        const determinant = mat4.determinant(world);
        if (!world.every(Number.isFinite) || !Number.isFinite(determinant) || determinant === 0 ||
            !mat3.normalFromMat4(normal, world) || !normal.every(Number.isFinite)) {
          throw new RangeError('Asset root/world matrices must remain finite and nonsingular at Float32 precision.');
        }
        if (posed.skin) {
          validateSkinPose(posed.skin, geometryOf(record, stagedEdits), world);
        }
        if (posed.morph) {
          validateMorphTransform(posed.morph, morphMetadataOf(record, stagedEdits), world, posed.skin);
        } else {
          validatePositionBounds(geometryInfoOf(record, stagedEdits).maxima, world, posed.skin);
        }
        return world;
      });
      if (autoFrame) {
        candidate.camera = framedCamera(framingBounds(records.map(record => geometryInfoOf(record, stagedEdits)), stagedMatrices));
        candidate = normalize(candidate);
        stagedSampler = agentMotion.compileAgentMotion(candidate.motion, motionRecipe(candidate));
        sampled = targetTime === null ? null : stagedSampler?.sample(targetTime);
      }
      const stagedMaterials = new Map([...materialRecords].map(([id, record]) => [id, { ...record.baseline }]));
      for (const override of candidate.materialOverrides) {
        stagedMaterials.set(override.id, { ...stagedMaterials.get(override.id), ...override });
      }
      for (const [id, patch] of sampled?.materials ?? []) {
        const copiedPatch = Object.fromEntries(Object.entries(patch).map(([field, value]) => [field, typeof value === 'number' ? value : Array.from(value)]));
        stagedMaterials.set(id, { ...stagedMaterials.get(id), ...copiedPatch });
      }
      for (const snapshot of stagedMaterials.values()) {
        for (const field of ['color', 'emissiveColor']) {
          if (snapshot[field]) {
            Object.freeze(snapshot[field]);
          }
        }
        Object.freeze(snapshot);
      }
      const stagedCamera = sampled?.camera ? {
        ...candidate.camera,
        ...Object.fromEntries(Object.entries(sampled.camera).filter(([field]) => field !== 'projection').map(([field, value]) => [field, ArrayBuffer.isView(value) ? Array.from(value) : value])),
      } : candidate.camera;
      // Validate camera geometry through the same canonical view contract.
      viewRecipe({ camera: stagedCamera });
      const preparedTransaction = transaction;
      transaction = null;
      preparedTransaction.commit();
      for (let index = 0; index < parts.length; index++) {
        Float32Array.prototype.set.call(parts[index].matrix, stagedMatrices[index]);
      }
      const stagedSignature = meshEditSignature(stagedEdits);
      if (stagedSignature !== editSignature) {
        editedParts = stagedEdits;
        editSignature = stagedSignature;
        parts = buildParts(editedParts);
        topologyRevision++;
      }
      const previousRecipe = recipe;
      if (transientTime === undefined) {
        recipe = candidate;
        sampler = stagedSampler;
        physicsSampler = stagedPhysics;
        layerEvaluator = stagedLayers;
        footLockEvaluator = stagedFootLock;
      }
      materialSnapshots = stagedMaterials;
      sampledCamera = stagedCamera;
      motionTime = targetTime;
      if (transientTime === undefined) {
        matrices = stagedMatrices;
      }
      if (increment) {
        if (transientTime === undefined) {
          revisionHistory.push({ revision, recipe: previousRecipe });
          while (revisionHistory.length > REVISION_HISTORY_LIMIT) {
            revisionHistory.shift();
          }
        }
        revision++;
      }
      return revision;
    } catch (error) {
      transaction?.discard();
      throw error;
    }
  }

  /** scene_inspect's motionIk: how each solver fares across the clip, from a sampler that leaves the published pose alone. */
  function diagnosticsReport() {
    const diagnostics = assetDiagnostics({
      assetId: canonicalAssetId,
      warnings: asset.warnings,
      skinnedParts: records.filter(record => record.source.skin).length,
      jointCount: [...sourceNodes.values()].filter(node => node.joint).length,
      clipCount: asset.animations.length,
    });
    return diagnostics.length ? { diagnostics } : {};
  }

  /** scene_inspect's retargets (what the humanoid map matched for each layer taken from another asset), footLock (when feet are planted) and morph target names. */
  function motionLayerReport() {
    const retargets = (recipe.motion?.layers ?? []).flatMap((layer, position) => (layer.from
      ? [{ layer: position, from: layer.from, ...retargetReport(clipLayerContext.external.get(layer.from.asset).nodes, [...sourceNodes.values()], 'retarget') }]
      : []));
    return {
      ...(retargets.length ? { retargets } : {}),
      ...(footLockEvaluator ? { footLock: footLockEvaluator.report() } : {}),
      ...(morphTargetIndex.size ? { morphTargetNames: [...morphTargetIndex.keys()].slice(0, 128) } : {}),
    };
  }

  /** scene_inspect's motionDrive: the wheels found, the names rejected and the light signals at the current motion time. */
  function motionDriveReport() {
    if (!recipe.motion?.drive) return {};
    const drive = buildDrive(recipe.motion.drive);
    return { motionDrive: drive.describe(motionTime === null ? undefined : drive.sample(motionTime).pose) };
  }

  function motionIkReport() {
    if (!recipe.motion?.ik?.length) return {};
    const sweeper = agentMotion.compileAgentMotion(recipe.motion, motionRecipe(recipe));
    return {
      motionIk: sweeper.sweepIk(time => stagedNodePoses(recipe.animation, [...poseOverrides(recipe.nodeOverrides, layerEvaluator, sweeper.sample(time), time).nodeOverrides.values()])),
    };
  }

  function expected(options) {
    knownKeys(options, ['expectedRevision'], 'transaction options');
    if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision !== revision) {
      throw invalidField('expectedRevision', options.expectedRevision, `the current revision, such as ${revision}`);
    }
  }

  publish(initialRecipe, cameraOmitted, false);
  return Object.freeze({
    capabilities,
    get parts() {
      return parts;
    },
    get revision() {
      return revision;
    },
    get topologyRevision() {
      return topologyRevision;
    },
    get camera() {
      return structuredClone(sampledCamera);
    },
    get motionTime() {
      return motionTime;
    },
    get environment() {
      return structuredClone(recipe.environment);
    },
    get effects() {
      return structuredClone(recipe.effects);
    },
    get shadow() {
      return structuredClone(recipe.shadow);
    },
    exportRecipe() {
      return structuredClone(recipe);
    },
    provideMotionSources,
    sampleMotion(time) {
      if (time !== null && (!Number.isFinite(time) || time < 0 || time > 3600)) {
        throw invalidField('motionTime', time, 'null, or seconds from 0 to 3600, such as 0.5');
      }
      publish(recipe, false, false, time);
      return motionTime;
    },
    sampleFrame(input) {
      const frame = copiedJson(input);
      knownKeys(frame, ['animation', 'motionTime'], 'asset frame');
      const time = frame.motionTime === undefined ? motionTime : frame.motionTime;
      if (time !== null && (!Number.isFinite(time) || time < 0 || time > 3600)) {
        throw invalidField('motionTime', time, 'null, or seconds from 0 to 3600, such as 0.5');
      }
      publish(recipe, false, false, time, frame.animation);
      return motionTime;
    },
    apply(inputOperations, options = {}) {
      expected(options);
      if (!Array.isArray(inputOperations) || !inputOperations.length || inputOperations.length > MAX_OPERATIONS) {
        throw invalidField('operations', Array.isArray(inputOperations) ? `${inputOperations.length} commands` : inputOperations, `an array of 1 to ${MAX_OPERATIONS} commands, such as [{ "type": "set-root", "translation": [0, 1, 0] }]`);
      }
      const operations = copiedJson(inputOperations);
      const candidate = structuredClone(recipe);
      for (const [operationIndex, operation] of operations.entries()) {
        const path = `operations[${operationIndex}]`;
        const lookField = Object.hasOwn(LOOK_OPERATIONS, operation.type) ? LOOK_OPERATIONS[operation.type] : null;
        if (lookField) {
          knownKeys(operation, ['type', lookField], path);
          const patch = operation[lookField];
          knownKeys(patch, Object.keys(candidate[lookField]), lookField);
          const nested = lookField === 'environment' ? 'volumeFog' : lookField === 'effects' ? 'bloom' : null;
          const merged = { ...candidate[lookField], ...(lookField === 'environment' ? environmentPatchWithSetup(patch) : patch) };
          if (nested && Object.hasOwn(patch, nested)) {
            knownKeys(patch[nested], Object.keys(candidate[lookField][nested]), nested);
            merged[nested] = { ...candidate[lookField][nested], ...patch[nested] };
          }
          candidate[lookField] = merged;
        } else if (operation.type === 'set-camera') {
          knownKeys(operation, ['type', ...Object.keys(candidate.camera)], path);
          for (const field of Object.keys(candidate.camera)) {
            if (Object.hasOwn(operation, field)) {
              candidate.camera[field] = operation[field];
            }
          }
        } else if (operation.type === 'set-root') {
          knownKeys(operation, ['type', ...ROOT_FIELDS], path);
          for (const field of ROOT_FIELDS) {
            if (Object.hasOwn(operation, field)) {
              candidate.root[field] = operation[field];
            }
          }
        } else if (operation.type === 'set-motion') {
          knownKeys(operation, ['type', 'motion'], path);
          if (!Object.hasOwn(operation, 'motion')) {
            throw invalidField(`${path}.motion`, undefined, 'a motion record, or null to clear it, such as null', TypeError);
          }
          candidate.motion = operation.motion;
        } else if (operation.type === 'set-physics') {
          knownKeys(operation, ['type', 'physics'], path);
          if (!Object.hasOwn(operation, 'physics')) {
            throw invalidField(`${path}.physics`, undefined, 'a physics record, or null to clear it, such as null', TypeError);
          }
          candidate.physics = operation.physics;
        } else if (operation.type === 'set-asset-node') {
          knownKeys(operation, ['type', 'id', ...ROOT_FIELDS], path);
          if (!sourceNodes.has(operation.id)) {
            throw invalidField(`${path}.id`, operation.id, 'the ID of a source node; call scene_inspect with kind hierarchy to list them');
          }
          const fields = ROOT_FIELDS.filter(field => Object.hasOwn(operation, field));
          if (!fields.length) {
            throw invalidField(path, operation, 'an id plus at least one of translation, rotation or scale, such as { "type": "set-asset-node", "id": "node-1", "translation": [0, 1, 0] }', TypeError);
          }
          let override = candidate.nodeOverrides.find(value => value.id === operation.id);
          if (!override) {
            override = { id: operation.id };
            candidate.nodeOverrides.push(override);
          }
          for (const field of fields) {
            override[field] = operation[field];
          }
        } else if (operation.type === 'set-animation') {
          knownKeys(operation, ['type', 'clip', 'time'], path);
          if (operation.clip === null) {
            if (Object.hasOwn(operation, 'time')) {
              throw invalidField(`${path}.time`, operation.time, 'no time when clip is null, which returns to the initial pose; drop time', TypeError);
            }
            candidate.animation = null;
          } else {
            const clip = operation.clip === undefined ? candidate.animation?.clip : operation.clip;
            const sameClip = candidate.animation !== null && clip === candidate.animation.clip;
            const time = operation.time === undefined ? (sameClip ? candidate.animation.time : 0) : operation.time;
            candidate.animation = { clip, time };
          }
        } else if (operation.type === 'set-material') {
          knownKeys(operation, ['type', 'id', ...MATERIAL_FIELDS], path);
          if (!materialRecords.has(operation.id)) {
            throw invalidField(`${path}.id`, operation.id, `the ID of a decoded material, one of ${[...materialRecords.keys()].slice(0, 5).join(', ')}`);
          }
          let override = candidate.materialOverrides.find(value => value.id === operation.id);
          if (!override) {
            override = { id: operation.id };
            candidate.materialOverrides.push(override);
          }
          for (const field of MATERIAL_FIELDS) {
            if (Object.hasOwn(operation, field)) {
              override[field] = operation[field];
            }
          }
        } else if (operation.type === 'edit-mesh') {
          knownKeys(operation, ['type', 'geometry', 'edits', 'replace'], path);
          candidate.meshEdits = withFieldPrefix(path, () => meshEditEntriesAfter(candidate.meshEdits ?? [], operation, records));
        } else {
          throw invalidField(`${path}.type`, operation.type, 'one of set-camera, set-root, set-motion, set-physics, set-asset-node, set-animation, set-material or edit-mesh, such as "set-root"; imported parts take edit-mesh with a mesh ID such as mesh-0', TypeError);
        }
      }
      return publish(candidate);
    },
    inspect(inputOptions = {}) {
      const options = copiedJson(inputOptions);
      knownKeys(options, ['ids', 'limit', 'includeBounds', 'kind', 'offset'], 'inspection');
      const limit = options.limit === undefined ? 64 : options.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 256 ||
          (options.includeBounds !== undefined && typeof options.includeBounds !== 'boolean')) {
        if (options.includeBounds !== undefined && typeof options.includeBounds !== 'boolean') {
          throw invalidField('includeBounds', options.includeBounds, 'true or false');
        }
        throw invalidField('limit', limit, 'a whole number from 1 to 256, such as 64');
      }
      const offset = options.offset === undefined ? 0 : options.offset;
      if (!Number.isInteger(offset) || offset < 0 || offset > 4096 ||
          (options.kind !== undefined && !['meshes', 'hierarchy'].includes(options.kind))) {
        if (options.kind !== undefined && !['meshes', 'hierarchy'].includes(options.kind)) {
          throw invalidField('kind', options.kind, 'one of meshes, hierarchy');
        }
        throw invalidField('offset', offset, 'a whole number from 0 to 4096, such as 0');
      }
      if (options.kind === 'hierarchy') {
        if (options.ids !== undefined && (!Array.isArray(options.ids) || options.ids.length > sourceNodes.size)) {
          throw invalidField('ids', Array.isArray(options.ids) ? `${options.ids.length} IDs` : options.ids, `an array of at most ${sourceNodes.size} source-node IDs, such as []`);
        }
        const selected = options.ids === undefined ? [...sourceNodes.values()] : options.ids.map(id => {
          if (!sourceNodes.has(id)) {
            throw invalidField('ids', id, 'the ID of a source node; call scene_inspect with kind hierarchy to list them');
          }
          return sourceNodes.get(id);
        });
        const nodes = structuredClone(selected.slice(offset, offset + limit));
        return { revision, topologyRevision, assetId: canonicalAssetId, kind: 'hierarchy', ...motionIkReport(), ...motionDriveReport(), ...motionLayerReport(), ...diagnosticsReport(),
          counts: { nodes: sourceNodes.size, joints: [...sourceNodes.values()].filter(node => node.joint).length },
          nodes, offset, truncated: offset + nodes.length < selected.length,
          ...(options.includeBounds ? { note: 'Hierarchy lists no bounds; inspect without kind, with ids of nodes or meshes, to get them.' } : {}),
          motion: recipe.motion ? { duration: recipe.motion.duration, loop: recipe.motion.loop, tracks: recipe.motion.tracks.length, time: motionTime } : null };
      }
      if (options.ids !== undefined && (!Array.isArray(options.ids) || options.ids.length > Math.max(records.length, sourceNodes.size))) {
        throw invalidField('ids', Array.isArray(options.ids) ? `${options.ids.length} IDs` : options.ids, `an array of at most ${Math.max(records.length, sourceNodes.size)} mesh or node IDs, such as ["mesh-0"]`);
      }
      const originNodes = new Map();
      const selected = options.ids === undefined ? records : options.ids.flatMap(id => inspectedRecordsFor(id, originNodes));
      const visible = selected.slice(offset, offset + limit);
      if (options.includeBounds && visible.filter(record => !record.isSourceNodeReport).reduce((total, record) => total + geometryOf(record).positions.length / 3, 0) > MAX_INSPECTION_VERTICES) {
        throw invalidField('ids', `${visible.length} meshes`, 'fewer meshes, under two million authored base vertices in all, such as ["mesh-0"]');
      }
      const nodes = visible.map(record => {
        if (record.isSourceNodeReport) {
          const { isSourceNodeReport, ...report } = record;
          return report;
        }
        const index = Number(record.id.slice(5));
        const node = {
          id: record.id, label: record.label, geometry: record.geometry.id, material: record.material.id,
          vertices: geometryOf(record).positions.length / 3,
          triangles: geometryOf(record).indices.length / 3,
          skinned: Boolean(record.source.skin), morphTargets: geometryOf(record).morphTargets?.length ?? 0,
          ...(editedParts.has(record.id) ? { edited: true } : {}),
          ...(originNodes.has(record.id) ? { fromNode: originNodes.get(record.id) } : {}),
        };
        if (options.includeBounds) {
          node.bounds = baseBounds([geometryOf(record)], [matrices[index]]);
          node.boundsKind = AGENT_ASSET_CAPABILITIES.boundsKind;
        }
        return node;
      });
      let geometryBytes = 0;
      let vertices = 0;
      const activeGeometries = new Set(records.map(record => geometryOf(record)));
      for (const geometry of activeGeometries) {
        vertices += geometry.positions.length / 3;
        for (const value of Object.values(geometry)) {
          if (ArrayBuffer.isView(value)) {
            geometryBytes += value.byteLength;
          }
        }
        for (const target of geometry.morphTargets ?? []) {
          geometryBytes += (target.positions?.byteLength ?? 0) + (target.normals?.byteLength ?? 0);
        }
      }
      return {
        revision, topologyRevision, assetId: canonicalAssetId, ...diagnosticsReport(),
        counts: { nodes: parts.length, parts: parts.length, geometries: activeGeometries.size, materials: materials.size, vertices },
        geometryBytes, animation: structuredClone(recipe.animation),
        motion: recipe.motion ? { duration: recipe.motion.duration, loop: recipe.motion.loop, tracks: recipe.motion.tracks.length, layers: recipe.motion.layers?.length ?? 0, time: motionTime } : null,
        physics: physicsSampler ? physicsSampler.report() : null,
        animations: asset.animations.map((clip, index) => ({ id: index, label: String(clip.name ?? `Clip ${index}`).slice(0, 256), duration: clip.duration })),
        nodes, offset, truncated: selected.length > offset + nodes.length,
      };
    },
    /** Polygon reports of imported parts, with the edit results and what was transferred to the edited geometry. */
    inspectMeshes(options = {}) {
      knownKeys(options, ['geometries'], 'mesh inspection');
      const requested = options.geometries ?? records.slice(0, MAX_MESH_REPORTS).map(record => record.id);
      if (!Array.isArray(requested) || requested.length > MAX_MESH_REPORTS) {
        throw invalidField('geometries', Array.isArray(requested) ? `${requested.length} IDs` : requested, `an array of at most ${MAX_MESH_REPORTS} mesh IDs, such as ["mesh-0"]`);
      }
      const meshes = requested.map(id => {
        const index = records.findIndex(record => record.id === id);
        if (index < 0) {
          throw invalidField('geometries', id, 'an imported mesh ID such as "mesh-0"; scene_inspect lists them');
        }
        const record = records[index];
        const edited = editedParts.get(id);
        const matrix = matrices[index];
        const scale = mat4.getScaling([0, 0, 0], matrix).map(value => Number(value.toPrecision(4)));
        // Where each local axis points in the world, so an agent can place a cutter or select by direction.
        const localAxesInWorld = [0, 4, 8].map(offset => {
          const length = Math.hypot(matrix[offset], matrix[offset + 1], matrix[offset + 2]) || 1;
          return [0, 1, 2].map(axis => Number((matrix[offset + axis] / length).toFixed(3)));
        });
        return {
          geometry: id, ...agentSceneModule('mesh').importedMeshReport(geometryOf(record)),
          ...(edited ? { transfer: edited.transfer } : {}),
          localToWorldScale: scale, localAxesInWorld,
        };
      });
      return { revision, meshes, truncated: false };
    },
    /** The surfaces a scene query walks: every part with its geometry, world matrix and material ID. */
    queryParts() {
      return records.map(record => ({ id: record.id, geometry: geometryOf(record), matrix: matrices[Number(record.id.slice(5))], material: record.material.id }));
    },
    checkpoint() {
      if (checkpoints.size >= MAX_CHECKPOINTS) {
        throw invalidField('checkpoints', `${checkpoints.size} saved`, `at most ${MAX_CHECKPOINTS} saved checkpoints; release one first, such as with scene_release_checkpoint`);
      }
      const handle = Object.freeze({});
      checkpoints.set(handle, structuredClone(recipe));
      return handle;
    },
    restore(handle, options = {}) {
      expected(options);
      if (!checkpoints.has(handle)) {
        throw invalidField('checkpointId', 'unknown or released', 'a checkpointId that scene_checkpoint returned and you have not released, such as the last one returned');
      }
      return publish(checkpoints.get(handle));
    },
    /** Go back to an earlier revision that apply or restore left behind; no checkpoint is needed. */
    restoreRevision(target, options = {}) {
      expected(options);
      const entry = revisionHistory.find(candidate => candidate.revision === target);
      if (!entry) {
        const kept = revisionHistory.map(candidate => candidate.revision);
        throw invalidField('revision', target, kept.length > 0
          ? `one of the kept revisions: ${kept.join(', ')} (the last ${REVISION_HISTORY_LIMIT} are kept; older ones are dropped)`
          : 'a revision this session kept, but none is kept yet because nothing has been edited; apply an edit first');
      }
      return publish(entry.recipe);
    },
    releaseCheckpoint(handle) {
      if (!checkpoints.delete(handle)) {
        throw invalidField('checkpointId', 'unknown or released', 'a checkpointId that scene_checkpoint returned and you have not released, such as the last one returned');
      }
    },
  });
}
