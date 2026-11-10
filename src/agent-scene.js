import { mat4, mat3 } from 'gl-matrix';
import { box, circle, cone, cylinder, grid, icoSphere, sphere, torus } from './geometry.js';
import { createSceneGraph } from './scene-graph.js';
import { invalidField, withFieldPrefix } from './field-error.js';
import { applyProjection, validateCameraShift, CAMERA_LENS_FIELDS } from './camera.js';
import { normalizeAgentLook, environmentPatchWithSetup, environmentLinksLights, agentEnvironmentMap, VOLUME_FOG_FIELDS } from './agent-look.js';
import { postStepSupport } from './shader-registry.js';
import { agentSceneModule, agentSceneModuleLoaded } from './agent-scene-modules.js';
import { CURVE_TEXT_LIMITS, AGENT_SCENE_CAPABILITIES, AGENT_SCENE_DEFAULT_LIMITS, MAX_MATERIAL_PATTERNS, RECIPE_ALPHA_MODES } from './agent-scene-capabilities.js';
import { ALL_LIGHTS_MASK, MATERIAL_LAYER_FIELDS, validateMaterialLayers } from './material-layers.js';
import { recipeDiagnostics, closedRoomDiagnostic } from './agent-diagnostics.js';
import { closedRoomShare, CLOSED_ROOM_SHARE } from './closed-room.js';
import { depthLayerOf, MAXIMUM_DEPTH_LAYER } from './depth-layer.js';
import { armatureNodes, bakeRigExport, bindSkins, createSkinStages, normalizeArmatures, publishSkinPoses, restWorldMatrix, rigReport, stageSkinPoses, transformedBounds, withoutArmatureNodes } from './rig.js';
export { AGENT_SCENE_CAPABILITIES, AGENT_SCENE_DEFAULT_LIMITS };

/**
 * Earlier revisions a session keeps for scene_restore with a revision. Each one holds a recipe copy (a few kilobytes) and
 * shares geometry buffers with the live scene, so four cost little; their geometry still counts in the allocation budget.
 */
export const REVISION_HISTORY_LIMIT = 4;
export { normalizeAgentLook, resolveAgentShadow } from './agent-look.js';
export { describeApplication } from './agent-apply-report.js';
export {
  needsMeshBooleans, loadMeshBooleans, meshBooleansLoaded, setManifoldModuleLoader,
  needsPhysics, loadPhysicsEngine, physicsEngineLoaded, setPhysicsModuleLoader,
  loadAgentSceneModules, loadAllAgentSceneModules, registerAgentSceneFont, allAgentSceneModulesLoaded, agentSceneModulesNeeded,
} from './agent-scene-modules.js';

const DEFAULT_LIMITS = AGENT_SCENE_DEFAULT_LIMITS;
const MAX_MESH_REPORTS = 16;
// A boolean cutter may name another recipe geometry, which may itself cut with a third. Both bounds are static, so they
// do not depend on what the evaluation cache holds.
const MAX_CUTTER_DEPTH = 4;
const MAX_CUTTER_WORK_VERTICES = 250_000;
// Where a geometry is checked before the whole recipe is known: references stay unresolved and count nothing.
const PENDING_CUTTER_SCOPE = Object.freeze({ definitions: null, chain: Object.freeze([]) });
// Terrain meshes carry one more float for each vertex (sky visibility) than the 56 bytes the budget estimates.
const TERRAIN_SKY_VISIBILITY_BYTES = 4;
const CAMERA_DEFAULTS = Object.freeze({ eye: [4, 3, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 1000 });
// Per-node render flags: `visible` hides a node and its children; the rest become renderer part flags of a mesh node.
const RENDER_FLAG_FIELDS = ['visible', 'castShadow', 'receiveShadow', 'holdout', 'shadowCatcher'];
const PART_FLAG_FIELDS = RENDER_FLAG_FIELDS.slice(1);
const NODE_FIELDS = ['translation', 'rotation', 'scale', 'parent', 'label', 'geometry', 'material', 'skin', 'relations', 'asset', 'vegetation', 'decal', 'depthLayer', 'blend', ...RENDER_FLAG_FIELDS];
const MATERIAL_FIELDS = ['color', 'metallic', 'roughness', 'emission', 'emissiveColor', 'opacity', 'alphaMode', 'doubleSided', 'pattern', 'map', 'subsurface', 'snippet', 'waterPreset', 'absorption', 'turbidity', 'aov', ...MATERIAL_LAYER_FIELDS];
const PATTERN_TEXTURE_FIELDS = ['map', 'normalMap', 'metallicRoughnessMap', 'emissiveMap', 'layerMaps', 'transmissionMap', 'aovMap', 'boxMapScale', 'boxMapAxis'];
const CAMERA_FIELDS = [...Object.keys(CAMERA_DEFAULTS), ...CAMERA_LENS_FIELDS];
const LOOK_OPERATION_FIELDS = Object.freeze({
  'set-environment': 'environment',
  'set-effects': 'effects',
  'set-shadow': 'shadow',
});
// Each of these replaces one recipe section whole; null clears it.
const NULLABLE_SECTION_OPERATIONS = Object.freeze({
  'set-motion': 'motion', 'set-physics': 'physics', 'set-timeline': 'timeline', 'set-cloth': 'cloth',
  'set-bake': 'bake', 'set-particles': 'particles', 'set-post-passes': 'postPasses', 'set-armatures': 'armatures',
});
const ADDITION_FIELDS = Object.freeze({
  'add-geometry': ['geometries', 'geometry'],
  'add-material': ['materials', 'material'],
  'add-node': ['nodes', 'node'],
});
const REMOVAL_FIELDS = Object.freeze({
  'remove-geometry': 'geometries',
  'remove-material': 'materials',
});


function knownKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField(label, value, 'an object, such as {}', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalidField(`${label}.${key}`, value[key], `one of the fields ${allowed.join(', ')}; remove ${key}`, TypeError);
    }
  }
}

function resolveLimits(input) {
  knownKeys(input, Object.keys(DEFAULT_LIMITS), 'limits');
  const result = { ...DEFAULT_LIMITS, ...input };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw invalidField(`limits.${key}`, value, 'a positive whole number, such as 1024');
    }
  }
  if (result.maxNodes > 4096) {
    throw new RangeError('maxNodes cannot exceed 4096.');
  }
  return Object.freeze(result);
}

// Copy only JSON data. Reject accessors before reading them and bound traversal before serialization.
function copiedJson(input, maximum) {
  let bytes = 0;
  const ancestors = new Set();
  const encoder = new TextEncoder();
  function charge(count) {
    bytes += count;
    if (bytes > maximum) {
      throw new RangeError('JSON exceeds maxRecipeBytes. Reduce the input.');
    }
  }
  function copy(value, depth) {
    if (depth > 64) {
      throw new RangeError('JSON nesting exceeds 64 levels.');
    }
    if (value === null || typeof value === 'boolean') {
      charge(value === null ? 4 : String(value).length);
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      charge(String(value).length);
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > maximum) {
        throw new RangeError('JSON exceeds maxRecipeBytes.');
      }
      charge(encoder.encode(JSON.stringify(value)).length);
      return value;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) {
      throw new TypeError('Recipe must contain finite, acyclic JSON data.');
    }
    const array = Array.isArray(value);
    if (array && value.length > maximum) {
      throw new RangeError('JSON exceeds maxRecipeBytes.');
    }
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('Recipe objects must be plain JSON objects.');
    }
    ancestors.add(value);
    charge(2);
    const result = array ? [] : {};
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || key === '__proto__') {
        throw new TypeError('Invalid JSON key.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('JSON accessors and hidden fields are unsupported.');
      }
      if (array && key !== String(result.length)) {
        throw new TypeError('JSON arrays must be dense without extra fields.');
      }
      charge(array ? 1 : encoder.encode(JSON.stringify(key)).length + 2);
      result[key] = copy(descriptor.value, depth + 1);
    }
    if (array && result.length !== value.length) {
      throw new TypeError('JSON arrays must be dense without trailing holes.');
    }
    ancestors.delete(value);
    return result;
  }
  const result = copy(input, 0);
  if (encoder.encode(JSON.stringify(result)).length > maximum) {
    throw new RangeError('JSON exceeds maxRecipeBytes.');
  }
  return result;
}

function finite(value, label) {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw invalidField(label, value, 'a finite number that fits Float32, such as 0.5', TypeError);
  }
  return value;
}

function vector(value, length, label) {
  if (!Array.isArray(value) || value.length !== length) {
    const example = `[${Array.from({ length }, (_, index) => (index === length - 1 && length === 4 ? 1 : 0)).join(', ')}]`;
    throw invalidField(label, value, `an array of ${length} numbers, such as ${example}`, TypeError);
  }
  return value.map((component, index) => finite(component, `${label}[${index}]`));
}

function defaultValue(value, fallback) {
  return value === undefined ? fallback : value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidField(label, value, `a whole number from ${minimum} to ${maximum}, such as ${minimum}`);
  }
  return value;
}

function identifier(value, label = 'id') {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw invalidField(label,value, 'a string of 1 to 128 characters, such as "wall-left"', TypeError);
  }
  return value;
}

function resources(values, maximum, label, validate) {
  if (!Array.isArray(values) || values.length > maximum) {
    throw invalidField(label, Array.isArray(values) ? `${values.length} entries` : values, `an array of at most ${maximum} entries, such as []`);
  }
  const seen = new Set();
  return values.map((value, index) => withFieldPrefix(`${label}[${index}]`, () => {
    identifier(value?.id);
    if (seen.has(value.id)) {
      throw invalidField('id', value.id, `an ID no other ${label} entry uses; rename one, or remove the other`);
    }
    seen.add(value.id);
    return validate(value);
  }));
}

function copyMaterialLayers(value, result) {
  for (const field of MATERIAL_LAYER_FIELDS) {
    if (value[field] === undefined) continue;
    result[field] = Array.isArray(value[field]) ? vector(value[field], 3, field) : value[field];
  }
  validateMaterialLayers(result);
  if (value.subsurface !== undefined) result.subsurface = agentSceneModule('subsurfaceShader').copySubsurface(value.subsurface, result.tag);
  if (value.snippet) result.snippet = agentSceneModule('materialSnippet').normalizeMaterialSnippet(value.snippet, { hasMap: Boolean(value.map || value.pattern) });
  if (result.anisotropy > 0 || result.iridescence > 0) agentSceneModule('layerShaders');
  if (result.toon > 0) agentSceneModule('lineArt');
}

function materialFrom(value) {
  knownKeys(value, ['id', 'tag', ...MATERIAL_FIELDS], 'material');
  // A pattern brings its own colours, so the color field tints it and leaves it unchanged by default.
  const defaultColor = value.pattern === undefined ? [0.5, 0.5, 0.5] : [1, 1, 1];
  const graph = value.pattern?.type === 'graph' ? value.pattern.graph : {};
  // A graph that makes roughness, metallic or emission passes it through as written, so the factors default to 1.
  const graphFactor = (output, fallback) => (Object.hasOwn(graph ?? {}, output) ? 1 : fallback);
  const result = { id: value.id, tag: defaultValue(value.tag, 'surface'), color: vector(defaultValue(value.color, defaultColor), 3, 'color'),
    ...(graphFactor('clearcoat', 0) && { clearcoat: 1 }), ...(graphFactor('transmission', 0) && { transmission: 1 }),
    metallic: defaultValue(value.metallic, graphFactor('metallic', 0)), roughness: defaultValue(value.roughness, graphFactor('roughness', 0.5)), emission: defaultValue(value.emission, graphFactor('emission', 0)) };
  if (!AGENT_SCENE_CAPABILITIES.materialTags.includes(result.tag)) {
    throw invalidField('tag', result.tag, `one of ${AGENT_SCENE_CAPABILITIES.materialTags.join(', ')}`);
  }
  if (value.map !== undefined) agentSceneModule('assets').applyMapSequence(value, result);
  if (value.pattern !== undefined) {
    if (result.tag !== 'surface') throw invalidField('pattern', value.pattern?.type, 'a material with the surface tag; remove pattern or set tag to surface');
    result.pattern = agentSceneModule('patterns').normalizeMaterialPattern(value.pattern);
  }
  result.opacity = defaultValue(value.opacity, 1);
  finite(result.opacity, 'opacity');
  if (result.opacity < 0 || result.opacity > 1) {
    throw invalidField('opacity', result.opacity, 'a number from 0 to 1, such as 0.5');
  }
  const requestedAlphaMode = defaultValue(value.alphaMode, 'opaque');
  if (!RECIPE_ALPHA_MODES.includes(requestedAlphaMode)) {
    throw invalidField('alphaMode', requestedAlphaMode, `one of ${RECIPE_ALPHA_MODES.join(', ')}`);
  }
  // The renderer ignores opacity on opaque surfaces, so any opacity below one means blending (additive stays additive).
  const graphHasOpacity = graphFactor('opacity', 0);
  result.alphaMode = (result.opacity < 1 || graphHasOpacity) && requestedAlphaMode === 'opaque' ? 'blend' : requestedAlphaMode;
  result.doubleSided = defaultValue(value.doubleSided, false);
  if (typeof result.doubleSided !== 'boolean') {
    throw invalidField('doubleSided', result.doubleSided, 'true or false', TypeError);
  }
  for (const field of ['metallic', 'roughness']) {
    finite(result[field], field);
    if (result[field] < 0 || result[field] > 1) {
      throw invalidField(field, result[field], 'a number from 0 to 1, such as 0.5');
    }
  }
  finite(result.emission, 'emission');
  if (result.emission < 0) {
    throw invalidField('emission', result.emission, 'a number of 0 or more, such as 1');
  }
  if (result.color.some(component => component < 0 || component > 1)) {
    throw invalidField('color', result.color, 'three numbers from 0 to 1, such as [0.8, 0.2, 0.1]');
  }
  if (value.emissiveColor !== undefined) {
    result.emissiveColor = vector(value.emissiveColor, 3, 'emissiveColor');
    if (result.emissiveColor.some(component => component < 0)) {
      throw invalidField('emissiveColor', result.emissiveColor, 'three numbers of 0 or more, such as [1, 0.5, 0.2]');
    }
  }
  if (value.aov !== undefined) {
    const aov = typeof value.aov === 'number' ? [finite(value.aov, 'aov'), value.aov, value.aov] : vector(value.aov, 3, 'aov');
    if (aov.some(component => component < 0 || component > 1)) {
      throw invalidField('aov', value.aov, 'a number or three numbers from 0 to 1, such as [1, 0.5, 0]');
    }
    result.aov = aov;
  }
  copyMaterialLayers(value, result);
  if (agentSceneModuleLoaded('worldMaterials')) {
    agentSceneModule('worldMaterials').copyWaterFields(value, result, vector);
  }
  const emissiveColor = result.emissiveColor ?? result.color;
  for (const component of emissiveColor) {
    const radiance = Math.fround(component) * Math.fround(result.emission);
    if (!Number.isFinite(Math.fround(radiance))) {
      throw invalidField('emission', result.emission, 'an emission that keeps color times emission within Float32 range, such as 2');
    }
    if (result.tag === 'unlit' && radiance > 65500) {
      throw invalidField('emission', result.emission, 'an unlit emission that keeps color times emission at or below 65500, such as 2');
    }
  }
  return result;
}

function nodeFrom(value) {
  knownKeys(value, ['id', 'geometry', 'material', ...NODE_FIELDS], 'node');
  const result = { ...value, parent: value.parent ?? null,
    translation: vector(defaultValue(value.translation, [0, 0, 0]), 3, 'translation'),
    rotation: vector(defaultValue(value.rotation, [0, 0, 0, 1]), 4, 'rotation'),
    scale: vector(defaultValue(value.scale, [1, 1, 1]), 3, 'scale') };
  if (result.parent !== null) {
    identifier(result.parent, 'parent');
  }
  if (result.label !== undefined && (typeof result.label !== 'string' || result.label.length > 256)) {
    throw invalidField('label', result.label, 'a string of at most 256 characters, such as "left wall"', TypeError);
  }
  if (result.scale.some(component => component <= 0 || Math.fround(component) <= 0)) {
    throw invalidField('scale', result.scale, 'three positive numbers, such as [1, 1, 1]');
  }
  const length = Math.hypot(...result.rotation);
  if (length === 0) {
    throw invalidField('rotation', result.rotation, 'a nonzero quaternion [x, y, z, w], such as [0, 0, 0, 1] for no rotation');
  }
  result.rotation = result.rotation.map(component => component / length);
  if ((value.geometry !== undefined) !== (value.material !== undefined)) {
    throw invalidField(value.geometry === undefined ? 'geometry' : 'material', value.geometry ?? value.material, `set together with ${value.geometry === undefined ? 'material' : 'geometry'} to draw a mesh, or drop both for a group node`, TypeError);
  }
  if (value.geometry !== undefined) {
    identifier(value.geometry);
    identifier(value.material);
  }
  if (value.asset !== undefined) {
    if (value.geometry !== undefined || value.skin !== undefined) {
      throw invalidField('asset', value.geometry ?? value.skin, 'an asset node without geometry, material and skin; an asset node is a group', TypeError);
    }
    result.asset = agentSceneModule('assets').normalizeAssetPlacement(value.asset);
  }
  if (value.vegetation !== undefined) result.vegetation = agentSceneModule('vegetation').normalizeVegetation(value.vegetation, value);
  if (value.decal !== undefined && typeof value.decal !== 'boolean') {
    throw invalidField('decal', value.decal, 'true or false', TypeError);
  }
  if (value.depthLayer !== undefined) {
    integer(value.depthLayer, 0, MAXIMUM_DEPTH_LAYER, 'depthLayer');
  }
  for (const flag of RENDER_FLAG_FIELDS) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') throw invalidField(flag, value[flag], 'true or false', TypeError);
    if (flag !== 'visible' && value[flag] !== undefined && value.geometry === undefined) throw invalidField(flag, value[flag], 'a flag on a mesh node with geometry and material; remove it from group nodes', TypeError);
  }
  if (value.holdout === true && value.shadowCatcher === true) throw invalidField('shadowCatcher', value.shadowCatcher, 'false when holdout is true; a node is a holdout or a shadow catcher, not both', TypeError);
  if (value.skin !== undefined) {
    if (value.geometry === undefined) {
      throw invalidField('skin', value.skin, 'a skin on a mesh node with geometry and material; remove skin from group nodes', TypeError);
    }
    knownKeys(value.skin, ['armature', 'maxInfluences', 'maxDistance'], 'skin');
    identifier(value.skin.armature);
    if (value.skin.maxInfluences !== undefined) {
      integer(value.skin.maxInfluences, 1, 4, 'skin maxInfluences');
    }
    if (value.skin.maxDistance !== undefined && !(Number.isFinite(value.skin.maxDistance) && value.skin.maxDistance > 0)) {
      throw invalidField('skin.maxDistance', value.skin.maxDistance, 'a positive number of metres, such as 0.5');
    }
  }
  return result;
}

/** Sets the given camera fields on a camera; a focal length replaces fov and a fov replaces focal length and sensor, never both. */
export function applyCameraFields(camera, fields) {
  rejectFovWithFocalLength(fields);
  for (const field of CAMERA_FIELDS) {
    if (Object.hasOwn(fields, field)) camera[field] = fields[field];
  }
  if (Object.hasOwn(fields, 'focalLength')) delete camera.fov;
  // Back to a perspective view: the old orthographic size no longer applies.
  if (fields.projection === 'perspective' && !Object.hasOwn(fields, 'orthoScale')) delete camera.orthoScale;
  if (Object.hasOwn(fields, 'fov')) {
    delete camera.focalLength;
    delete camera.sensorWidth;
  }
  return camera;
}

function rejectFovWithFocalLength(fields) {
  if (fields.fov !== undefined && fields.focalLength !== undefined) {
    throw invalidField('camera.focalLength', fields.focalLength, 'only one of fov (degrees) or focalLength (millimetres with sensorWidth), such as fov 45; remove the other');
  }
}

function checkCameraLens(camera) {
  if (camera.projection !== undefined && camera.projection !== 'perspective' && camera.projection !== 'orthographic') {
    throw invalidField('camera.projection', camera.projection, 'perspective or orthographic');
  }
  const orthographic = camera.projection === 'orthographic';
  if (camera.orthoScale !== undefined) {
    if (!orthographic) throw invalidField('camera.orthoScale', camera.orthoScale, 'a field of an orthographic camera; set projection to orthographic, or remove orthoScale');
    if (!Number.isFinite(camera.orthoScale) || camera.orthoScale <= 0) throw invalidField('camera.orthoScale', camera.orthoScale, 'a positive view height in metres, such as 10');
  }
  if (camera.sensorWidth !== undefined && camera.focalLength === undefined) throw invalidField('camera.sensorWidth', camera.sensorWidth, 'a field used with focalLength, such as focalLength 35; add focalLength or remove sensorWidth');
  if (camera.focalLength !== undefined) {
    if (orthographic) throw invalidField('camera.focalLength', camera.focalLength, 'a field of a perspective camera; an orthographic camera is sized by orthoScale, so remove focalLength');
    if (!Number.isFinite(camera.focalLength) || camera.focalLength <= 0 || camera.focalLength > 10000) throw invalidField('camera.focalLength', camera.focalLength, 'a lens length above 0 and up to 10000 millimetres, such as 35');
    if (camera.sensorWidth !== undefined && !(Number.isFinite(camera.sensorWidth) && camera.sensorWidth > 0 && camera.sensorWidth <= 1000)) throw invalidField('camera.sensorWidth', camera.sensorWidth, 'a width above 0 and up to 1000 millimetres, such as 36');
  }
  if (camera.shift !== undefined) validateCameraShift(camera.shift);
  if (camera.fStop !== undefined && !(Number.isFinite(camera.fStop) && camera.fStop >= 0.7 && camera.fStop <= 64)) {
    throw invalidField('camera.fStop', camera.fStop, 'a number from 0.7 to 64, such as 2.8 (smaller numbers blur more)');
  }
}

function cameraFrom(value = {}) {
  knownKeys(value, CAMERA_FIELDS, 'camera');
  rejectFovWithFocalLength(value);
  const result = { ...CAMERA_DEFAULTS, ...value };
  if (result.focalLength !== undefined) delete result.fov;
  checkCameraLens(result);
  result.eye = vector(result.eye, 3, 'camera.eye');
  result.target = vector(result.target, 3, 'camera.target');
  result.up = vector(result.up, 3, 'camera.up');
  const upLength = Math.hypot(...result.up);
  if (upLength === 0) {
    throw invalidField('camera.up', result.up, 'a nonzero direction, such as [0, 1, 0]');
  }
  result.up = result.up.map(component => component / upLength);
  for (const field of ['fov', 'near', 'far']) {
    if (result[field] !== undefined) finite(result[field], `camera.${field}`);
  }
  // Without fov the lens is a focal length, which gives a valid angle at any positive size.
  if ((result.fov !== undefined && (Math.fround(result.fov) <= 0 || Math.fround(result.fov) >= 180)) || Math.fround(result.near) <= 0 || Math.fround(result.far) <= Math.fround(result.near)) {
    if (result.fov !== undefined && (Math.fround(result.fov) <= 0 || Math.fround(result.fov) >= 180)) {
      throw invalidField('camera.fov', result.fov, 'degrees above 0 and below 180, such as 50');
    }
    throw invalidField('camera.near', [result.near, result.far], 'near above 0 and far above near, such as near 0.1 and far 100');
  }
  if (result.eye.every((component, axis) => Math.fround(component) === Math.fround(result.target[axis]))) {
    throw invalidField('camera.target', result.target, `a point different from eye ${JSON.stringify(result.eye)}, such as [0, 0, 0]`);
  }
  const direction = result.target.map((component, axis) => component - result.eye[axis]);
  const directionLength = Math.hypot(...direction);
  const unitDirection = direction.map(component => component / directionLength);
  const crossLength = Math.hypot(unitDirection[1] * result.up[2] - unitDirection[2] * result.up[1],
    unitDirection[2] * result.up[0] - unitDirection[0] * result.up[2], unitDirection[0] * result.up[1] - unitDirection[1] * result.up[0]);
  if (Math.fround(crossLength) === 0) {
    throw invalidField('camera.up', result.up, `a direction not parallel to the view from eye to target, such as [0, 1, 0]`);
  }
  const view = mat4.lookAt(mat4.create(), result.eye, result.target, result.up);
  const projection = applyProjection(mat4.create(), result, 1);
  for (const matrix of [view, projection]) {
    const determinant = mat4.determinant(matrix);
    if (!matrix.every(Number.isFinite) || !Number.isFinite(determinant) || determinant === 0) {
      throw new RangeError('Camera matrices must remain finite and nonsingular at Float32 precision.');
    }
  }
  return result;
}

const GEOMETRY_FIELDS = {
  box: ['bevel', 'subdivisions'], cylinder: ['segments', 'bevel', 'bevelSegments'],
  sphere: ['segments', 'rings'], grid: ['segments'], plane: ['segments'],
  cone: ['radiusTop', 'radiusBottom', 'segments'], icoSphere: ['subdivisions'], circle: ['segments', 'innerRadius'],
  line: ['from', 'to', 'radius', 'radialSegments'], torus: ['tubeRadius', 'segments', 'sides', 'arc', 'start'],
  lathe: ['profile', 'segments', 'startAngle', 'sweep'],
  extrude: ['contour', 'holes', 'depth', 'steps', 'bevel', 'bevelThickness', 'bevelSegments'],
  tube: ['path', 'radius', 'segments', 'radialSegments', 'closed'],
  sdf: ['root', 'resolution'],
  curve: ['points', 'shape', 'splines', 'closed', 'kind', 'weights', 'trim', 'grow', 'radius', 'taper', 'profile', 'resolution', 'radialSegments'],
  text: ['text', 'size', 'depth', 'font', 'align', 'curveSegments'],
  mesh: ['base', 'edits', 'stack', 'smoothAngle', 'shapeKeys'],
  terrain: ['size', 'resolution', 'seed', 'amplitude', 'holes'],
};

// A line is a two-point curve; both ends must be finite and apart.
function lineEnds(value) {
  const ends = [value.from, value.to];
  for (const end of ends) vector(end, 3, 'line end');
  if (ends[0].every((component, axis) => component === ends[1][axis])) {
    throw invalidField('to', value.to, `a point different from from ${JSON.stringify(value.from)}, such as [0, 1, 0]`);
  }
  return ends;
}

function geometryEstimate(value, scope = PENDING_CUTTER_SCOPE) {
  if (!Object.hasOwn(GEOMETRY_FIELDS, value.type)) {
    throw invalidField('type', value.type, `one of ${Object.keys(GEOMETRY_FIELDS).join(', ')}`, TypeError);
  }
  knownKeys(value, ['id', 'type', ...GEOMETRY_FIELDS[value.type]], 'geometry');
  function detail(field, fallback, minimum, maximum) {
    return integer(value[field] ?? fallback, minimum, maximum, field);
  }
  function points(input, size, minimum, field = 'points') {
    if (!Array.isArray(input) || input.length < minimum || input.length > 4096) {
      throw invalidField(field, Array.isArray(input) ? `${input.length} points` : input, `a list of ${minimum} to 4096 points of ${size} numbers, such as ${JSON.stringify(Array.from({ length: minimum }, (_, index) => Array.from({ length: size }, () => index)))}`);
    }
    for (const point of input) {
      vector(point, size, 'geometry point');
    }
    return input.length;
  }
  for (const field of GEOMETRY_FIELDS[value.type]) {
    if (value[field] !== undefined && !['profile', 'contour', 'holes', 'path', 'closed', 'base', 'edits', 'stack', 'shapeKeys', 'points', 'taper', 'text', 'font', 'align', 'from', 'to', 'shape', 'splines', 'kind', 'weights', 'trim', 'grow', 'root'].includes(field)) {
      finite(value[field], field);
    }
  }
  switch (value.type) {
    case 'box':
      return value.bevel === 0 ? 24 : 6 * (2 * detail('subdivisions', 6, 1, 128) + 2) ** 2;
    case 'cylinder':
      return (detail('segments', 80, 3, 2048) + 1) * 2 * (detail('bevelSegments', 6, 1, 128) + 1) + 2 * ((value.segments ?? 80) + 2);
    case 'sphere':
      return (detail('segments', 64, 3, 2048) + 1) * (detail('rings', 40, 2, 2048) + 1);
    case 'grid':
    case 'plane':
      return (detail('segments', 16, 1, 64) + 1) ** 2;
    case 'cone':
      return (detail('segments', 64, 3, 2048) + 1) * 2 + 2 * ((value.segments ?? 64) + 2);
    case 'icoSphere':
      return 10 * 4 ** detail('subdivisions', 2, 0, 7) + 2;
    case 'circle':
      return value.innerRadius > 0 ? (detail('segments', 64, 3, 2048) + 1) * 2 : detail('segments', 64, 3, 2048) + 2;
    case 'line': {
      const sides = detail('radialSegments', 8, 3, 128);
      lineEnds(value);
      return 2 * sides * 2 + 2 * (sides + 1);
    }
    case 'torus':
      return (detail('segments', 96, 3, 2048) + 1) * (detail('sides', 24, 3, 128) + 1) + 2 * ((value.sides ?? 24) + 2);
    case 'lathe':
      return (detail('segments', 64, 3, 2048) + 1) * points(value.profile, 2, 2, 'profile');
    case 'tube':
      points(value.path, 3, value.closed ? 3 : 2, 'path');
      if (value.closed !== undefined && typeof value.closed !== 'boolean') {
        throw invalidField('closed', value.closed, 'true or false', TypeError);
      }
      return (detail('segments', 64, 3, 2048) + 1) * (detail('radialSegments', 12, 3, 128) + 1);
    case 'curve': {
      if (['shape', 'splines', 'kind', 'weights', 'trim', 'grow'].some(field => value[field] !== undefined)) {
        return agentSceneModule('modeling').curveGeometryVertexCount(value);
      }
      const knots = value.points;
      if (!Array.isArray(knots) || knots.length < 2 || knots.length > CURVE_TEXT_LIMITS.maxCurvePoints) {
        throw invalidField('points', Array.isArray(knots) ? `${knots.length} points` : knots, `a list of 2 to ${CURVE_TEXT_LIMITS.maxCurvePoints} points, such as [[0, 0, 0], [0, 1, 0]]`);
      }
      const sides = value.profile === undefined ? detail('radialSegments', 8, 3, 128) : points(value.profile, 2, 3, 'profile');
      const rings = (value.closed ? knots.length : knots.length - 1) * detail('resolution', 12, 1, 64) + 1;
      return rings * sides * 2 + 2 * (sides + 1);
    }
    case 'sdf':
      return agentSceneModule('modeling').sdfVertexEstimate(value);
    case 'text': {
      if (typeof value.text !== 'string') throw invalidField('text', value.text, 'a string, such as "Hello"', TypeError);
      const visible = [...value.text].filter(character => !/\s/.test(character)).length;
      const isDefaultFont = value.font === undefined || value.font === 'default';
      const perSegment = isDefaultFont ? CURVE_TEXT_LIMITS.verticesPerCharacterSegment : CURVE_TEXT_LIMITS.verticesPerCustomCharacterSegment;
      return visible * perSegment * detail('curveSegments', 4, 1, 16);
    }
    case 'terrain':
      return agentSceneModule('terrain').terrainVertexEstimate(value);
    case 'extrude': {
      const holes = value.holes ?? [];
      if (!Array.isArray(holes) || holes.length > 128) {
        throw invalidField('holes', Array.isArray(holes) ? `${holes.length} rings` : holes, 'a list of at most 128 rings of points, such as []');
      }
      const count = points(value.contour, 2, 3, 'contour') + holes.reduce((total, hole) => total + points(hole, 2, 3, 'holes'), 0);
      if (count > 4096) {
        throw invalidField('contour', `${count} points`, 'a contour and holes with at most 4096 points in total; simplify them');
      }
      const beveled = (value.bevel ?? 0) > 0 || (value.bevelThickness ?? value.bevel ?? 0) > 0;
      return 6 * (count + holes.length * 2 - 2) + 6 * count * (detail('steps', 1, 1, 256) + (beveled ? detail('bevelSegments', 3, 1, 32) * 2 : 0));
    }
    case 'mesh': {
      const base = value.base;
      if (!base || typeof base !== 'object' || Array.isArray(base) || base.type === 'mesh' || Object.hasOwn(base, 'id')) {
        throw invalidField('base', base, 'a primitive or profile record without an id, such as { "type": "box" } (box, cylinder, sphere, torus, lathe, extrude or tube)', TypeError);
      }
      let estimate = geometryEstimate({ id: 'base', ...base });
      const cutterScope = meshCutterScope(value, scope);
      let referencedWork = 0;
      for (const edit of agentSceneModule('mesh').normalizeMeshEdits(value.edits ?? [])) {
        if (edit.op !== 'boolean') continue;
        const cutterVertices = cutterEstimate(edit.cutter, cutterScope);
        estimate += cutterVertices;
        if (isCutterReference(edit.cutter)) referencedWork += cutterVertices;
      }
      if (referencedWork > MAX_CUTTER_WORK_VERTICES) {
        throw invalidField('cutter.geometry', `${referencedWork} estimated cutter vertices in ${cutterScope.chain.join(' -> ')}`, `cutter geometries that total at most ${MAX_CUTTER_WORK_VERTICES} estimated vertices; use fewer segments or fewer referenced cutters`);
      }
      // Stack nodes multiply the mesh: arrays by their count, mirror and solidify at most by two.
      for (const node of agentSceneModule('mesh').normalizeMeshStack(value.stack ?? [])) estimate *= node.op === 'array' ? node.count : 2;
      if (value.shapeKeys !== undefined) agentSceneModule('mesh').normalizeShapeKeys(value.shapeKeys);
      if (value.smoothAngle !== undefined && (value.smoothAngle < 0 || value.smoothAngle > 180)) {
        throw invalidField('smoothAngle', value.smoothAngle, 'degrees from 0 to 180, such as 30');
      }
      // Edits can grow the mesh; the real size is checked against maxVertices after generation.
      return estimate * 2;
    }
  }
}

function hasInstancedNodes(nodes) {
  return !Array.isArray(nodes) || nodes.some(node => node && typeof node === 'object' && Object.hasOwn(node, 'instances'));
}

function isCutterReference(cutter) {
  return Object.hasOwn(cutter, 'geometry');
}

function meshCutterScope(meshDefinition, scope) {
  return scope && { definitions: scope.definitions, chain: scope.chain.length ? scope.chain : [meshDefinition.id] };
}

function cutterEstimate(cutter, scope) {
  if (isCutterReference(cutter)) return referencedCutterEstimate(cutter, scope);
  if (cutter.type === 'mesh' || Object.hasOwn(cutter, 'id')) {
    throw invalidField('cutter', cutter, 'a primitive or profile record without an id, such as { "type": "box" } (box, cylinder, sphere, torus, lathe, extrude or tube), or { "geometry": "<recipe geometry id>" }', TypeError);
  }
  return geometryEstimate({ id: 'cutter', ...cutter });
}

// A cutter naming a recipe geometry. scope.chain lists the meshes on the way here, the first being the mesh being built.
function referencedCutterEstimate(cutter, scope) {
  if (Object.keys(cutter).length !== 1 || typeof cutter.geometry !== 'string') {
    throw invalidField('cutter', cutter, 'only { "geometry": "<recipe geometry id>" }; put translation, rotation and scale on the boolean edit', TypeError);
  }
  if (!scope) {
    throw invalidField('cutter.geometry', cutter.geometry, 'a primitive or profile record such as { "type": "box" }; only recipe meshes can name another geometry');
  }
  const chain = [...scope.chain, cutter.geometry];
  if (chain.indexOf(cutter.geometry) !== chain.length - 1) {
    throw invalidField('cutter.geometry', chain.join(' -> '), `a geometry that does not cut with itself; remove ${cutter.geometry} from the cutters of ${scope.chain[scope.chain.length - 1]} or give it another cutter`);
  }
  if (chain.length - 1 > MAX_CUTTER_DEPTH) {
    throw invalidField('cutter.geometry', chain.join(' -> '), `a chain of at most ${MAX_CUTTER_DEPTH} cutter geometries; build the inner cutters into one geometry`);
  }
  if (!scope.definitions) return 0;
  const definition = scope.definitions.get(cutter.geometry);
  if (!definition) {
    throw invalidField('cutter.geometry', chain.join(' -> '), `the ID of a geometry in geometries, one of ${[...scope.definitions.keys()].join(', ') || 'none yet'}; add ${cutter.geometry} or pick one of them`);
  }
  return geometryEstimate(definition, { definitions: scope.definitions, chain });
}

function namesCutterGeometry(edit) {
  return edit?.op === 'boolean' && typeof edit.cutter?.geometry === 'string';
}

// The records of the cutter geometries a mesh names, nested ones included: what its result depends on beyond its own record.
function cutterDependencySignature(meshDefinition, definitions) {
  const parts = [];
  for (const edit of meshDefinition.edits ?? []) {
    if (!namesCutterGeometry(edit)) continue;
    const definition = definitions.get(edit.cutter.geometry);
    parts.push(JSON.stringify(definition), cutterDependencySignature(definition, definitions));
  }
  return parts.join('|');
}

// Validates the cutter chain (cycles, depth, missing IDs, work) before returning its signature, so the signature walk ends.
function checkedCutterDependencies(meshDefinition, definitions) {
  if (!(meshDefinition.edits ?? []).some(namesCutterGeometry)) return '';
  geometryEstimate(meshDefinition, { definitions, chain: [] });
  return cutterDependencySignature(meshDefinition, definitions);
}

/** Cache identity of a geometry record: its own fields plus the cutter geometries it depends on. */
function geometrySignature(definition, definitions) {
  const dependencies = definition.type === 'mesh' ? checkedCutterDependencies(definition, definitions) : '';
  return dependencies ? `${JSON.stringify(definition)}|cutters|${dependencies}` : JSON.stringify(definition);
}

function geometryDefinitions(geometries) {
  return new Map(geometries.map(definition => [definition.id, definition]));
}

function cutterScopeOf(geometries) {
  return { definitions: geometryDefinitions(geometries), chain: [] };
}

/** Render geometry of a boolean cutter record, checked like the cutters of recipe meshes. Used by imported-part edits. */
export function generateCutterGeometry(cutter, maxVertices) {
  cutterEstimate(cutter);
  return generateGeometry(cutter, maxVertices);
}

function generateGeometry(value, maxVertices, scope) {
  switch (value.type) {
    case 'box':
      return box(value.bevel, value.subdivisions);
    case 'cylinder':
      return cylinder(value.segments, value.bevel, value.bevelSegments);
    case 'sphere':
      return sphere(value.segments, value.rings);
    case 'grid':
    case 'plane':
      return grid(value.segments);
    case 'cone':
      return cone(value.radiusTop, value.radiusBottom, value.segments);
    case 'icoSphere':
      return icoSphere(value.subdivisions);
    case 'circle':
      return circle(value.segments, value.innerRadius);
    case 'line':
      return agentSceneModule('modeling').curve(lineEnds(value), { radius: value.radius, radialSegments: value.radialSegments, resolution: 1, maxVertices });
    case 'torus':
      return torus(value.tubeRadius, value.segments, value.sides, value.arc, value.start);
    case 'lathe':
      return agentSceneModule('modeling').lathe(value.profile, { ...value, maxVertices });
    case 'extrude':
      return agentSceneModule('modeling').extrude(value.contour, { ...value, maxVertices });
    case 'tube':
      return agentSceneModule('modeling').tube(value.path, { ...value, maxVertices });
    case 'sdf':
      return agentSceneModule('modeling').sdfGeometry(value, maxVertices);
    case 'curve':
      return agentSceneModule('modeling').curveGeometry(value, maxVertices);
    case 'text':
      return agentSceneModule('text').text(value.text, { ...value, maxVertices });
    case 'terrain':
      return agentSceneModule('terrain').generateTerrainGeometry(value, maxVertices);
    case 'mesh': {
      const cutterScope = meshCutterScope(value, scope);
      const dependencies = scope ? checkedCutterDependencies(value, scope.definitions) : '';
      return agentSceneModule('mesh').generateMeshGeometry(() => generateGeometry(value.base, maxVertices), value.edits ?? [], {
        maxVertices, smoothAngle: value.smoothAngle,
        stack: value.stack ?? [], shapeKeys: value.shapeKeys ?? [],
        // The edits only name a cutter geometry, so that geometry's own record joins the key: editing it changes the key.
        cacheKey: dependencies ? `${JSON.stringify(value.base)}|cutters|${dependencies}` : JSON.stringify(value.base),
        resolveCutter: cutter => {
          cutterEstimate(cutter, cutterScope);
          if (!isCutterReference(cutter)) return generateGeometry(cutter, maxVertices);
          const chain = [...cutterScope.chain, cutter.geometry];
          return generateGeometry(scope.definitions.get(cutter.geometry), maxVertices, { definitions: scope.definitions, chain });
        },
      });
    }
  }
}

function compile(recipe, geometries, localBounds, limits) {
  const materials = new Map(recipe.materials.map(material => [material.id, material]));
  const graph = createSceneGraph(recipe.nodes.map(node => {
    if (node.geometry !== undefined && (!geometries.has(node.geometry) || !materials.has(node.material))) {
      const missingField = geometries.has(node.geometry) ? 'material' : 'geometry';
      throw invalidField(`nodes.${node.id}.${missingField}`, node[missingField], `one of ${(geometries.has(node.geometry) ? [...materials.keys()] : [...geometries.keys()]).join(', ')}`);
    }
    return { name: node.id, parent: node.parent,
      matrix: node.assetPart ? mat4.clone(node.assetPart.matrix) : mat4.fromRotationTranslationScale(mat4.create(), node.rotation, node.translation, node.scale),
      geometry: geometries.get(node.geometry), material: materials.get(node.material) };
  }), limits);
  validateGraph(graph, localBounds);
  return graph;
}

function validateGraph(graph, localBounds) {
  const normal = mat3.create();
  for (const node of graph.nodes) {
    if (!mat3.normalFromMat4(normal, node.worldMatrix) || !normal.every(Number.isFinite)) {
      throw new RangeError(`Node ${node.name} normal transform exceeds Float32 range.`);
    }
    if (node.geometry) {
      const bounds = localBounds.get(node.geometry);
      for (let corner = 0; corner < 8; corner++) {
        const point = [0, 1, 2].map(axis => corner & (1 << axis) ? bounds.max[axis] : bounds.min[axis]);
        for (let axis = 0; axis < 3; axis++) {
          const matrix = node.worldMatrix;
          // Bound every multiplication and possible addition order, before cancellation.
          const absoluteSum = Math.abs(matrix[axis] * point[0]) + Math.abs(matrix[4 + axis] * point[1]) +
            Math.abs(matrix[8 + axis] * point[2]) + Math.abs(matrix[12 + axis]);
          if (!Number.isFinite(Math.fround(absoluteSum))) {
            throw new RangeError(`Node ${node.name} world geometry bounds exceed Float32 range.`);
          }
        }
      }
    }
  }
}

function boundsFor(geometry, matrix) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const positions = geometry.positions;
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * positions[offset] + matrix[4 + axis] * positions[offset + 1] + matrix[8 + axis] * positions[offset + 2] + matrix[12 + axis];
      minimum[axis] = Math.min(minimum[axis], value);
      maximum[axis] = Math.max(maximum[axis], value);
    }
  }
  return { min: minimum, max: maximum };
}

// An armature's nodes come first and are regenerated from it each time, so edits go through armatures, not through bone nodes.
function addArmatures(recipe, limits) {
  if (!Object.hasOwn(recipe, 'armatures')) {
    for (const node of recipe.nodes) {
      if (node.skin) {
        throw invalidField(`nodes.${node.id}.skin`, node.skin, 'a skin only when the recipe has armatures; add an armatures list or remove skin');
      }
    }
    return;
  }
  const userNodes = new Map(recipe.nodes.map(node => [node.id, node]));
  const resolveBounds = (armature, nodeId) => {
    const node = userNodes.get(nodeId);
    if (!node?.geometry) {
      throw invalidField(`armatures.${armature.id}.fit`, nodeId, 'the ID of a mesh node with a geometry, such as one scene_inspect lists');
    }
    const definition = recipe.geometries.find(geometry => geometry.id === node.geometry);
    const bounds = boundsFor(generateGeometry(definition, Math.min(limits.maxVertices, 1_000_000), cutterScopeOf(recipe.geometries)), mat4.create());
    const toArmature = mat4.invert(mat4.create(), restWorldMatrix(armature.id, userNodes, [armature]));
    const toWorld = restWorldMatrix(node.id, userNodes);
    return transformedBounds(bounds, mat4.multiply(mat4.create(), toArmature, toWorld));
  };
  recipe.armatures = normalizeArmatures(recipe.armatures, { resolveBounds });
  const derived = recipe.armatures.flatMap(armatureNodes);
  for (const node of derived) {
    if (userNodes.has(node.id)) {
      throw invalidField(`armatures.${node.id}`, node.id, 'a bone node ID no other node uses; give the armature a prefix, such as "rig-"');
    }
  }
  if (new Set(derived.map(node => node.id)).size !== derived.length) {
    throw invalidField('armatures', recipe.armatures.map(armature => armature.id), 'armatures that generate different node IDs; give one a prefix, such as "rig-"');
  }
  for (const node of recipe.nodes) {
    if (node.skin && !recipe.armatures.some(armature => armature.id === node.skin.armature)) {
      throw invalidField(`nodes.${node.id}.skin.armature`, node.skin.armature, `one of ${recipe.armatures.map(armature => armature.id).join(', ')}`);
    }
  }
  recipe.nodes = [...derived, ...recipe.nodes];
}

const DEFAULT_MATERIAL_ID = 'default';

/**
 * A node that names a geometry and no material gets the material "default" (neutral grey, every field at its default),
 * added to the recipe when it is missing, so the normalized and exported recipe stays explicit.
 */
function withDefaultMaterial(recipe) {
  const materials = recipe.materials;
  const nodes = Array.isArray(recipe.nodes) ? recipe.nodes : [];
  const unpainted = nodes.filter(node => node?.geometry !== undefined && node.material === undefined);
  if (unpainted.length === 0 || !Array.isArray(materials)) {
    return materials;
  }
  for (const node of unpainted) {
    node.material = DEFAULT_MATERIAL_ID;
  }
  const alreadyDefined = materials.some(material => material?.id === DEFAULT_MATERIAL_ID);
  return alreadyDefined ? materials : [...materials, { id: DEFAULT_MATERIAL_ID }];
}

// A name that matches no node would leave the light lighting nothing without a sign, so it fails and says what to do.
function checkLightLinkNames(recipe) {
  if (!environmentLinksLights(recipe.environment)) {
    return;
  }
  const unknown = agentSceneModule('lightLinking').unknownLightLinkNames(recipe.environment, recipe.nodes);
  if (unknown.length > 0) {
    throw invalidField('environment.keyAffects', unknown.slice(0, 4), 'node IDs that exist in nodes in every affects list; scene_inspect lists them');
  }
}

// Every light's affects list in light order: the mask of a part depends on these lists and nothing else of the environment.
function lightLinksKey(environment) {
  const lights = [...environment.pointLights, ...(environment.spotLights ?? []), ...(environment.areaLights ?? [])];
  return JSON.stringify([environment.keyAffects ?? null, ...lights.map(light => light.affects ?? null)]);
}

// A part that a light skips needs its own material object with the light mask, but it must still read every other
// field from the live material, so motion tracks keep driving it. One wrapper per material and mask keeps batches.
function linkedMaterial(liveMaterial, lightMask, wrappers) {
  const byMask = wrappers.get(liveMaterial) ?? new Map();
  wrappers.set(liveMaterial, byMask);
  if (!byMask.has(lightMask)) {
    const wrapper = {};
    for (const field of Object.keys(liveMaterial)) {
      Object.defineProperty(wrapper, field, { enumerable: true, get: () => liveMaterial[field] });
    }
    Object.defineProperty(wrapper, 'lightMask', { enumerable: true, value: lightMask });
    byMask.set(lightMask, Object.freeze(wrapper));
  }
  return byMask.get(lightMask);
}

function normalizeRecipe(input, limits) {
  let recipe = copiedJson(input, limits.maxRecipeBytes);
  knownKeys(recipe, ['format', 'schemaVersion', 'geometries', 'materials', 'nodes', 'armatures', 'camera', 'environment', 'effects', 'shadow', 'motion', 'physics', 'cloth', 'timeline', 'particles', 'bake', 'postPasses'], 'recipe');
  if (recipe.format !== '67js.scene' || recipe.schemaVersion !== 1) {
    throw invalidField(recipe.format !== '67js.scene' ? 'format' : 'schemaVersion', recipe.format !== '67js.scene' ? recipe.format : recipe.schemaVersion, recipe.format !== '67js.scene' ? '"67js.scene"' : '1');
  }
  // A scene with no mesh, or whose nodes all take the default material, has nothing to list: absent means empty.
  // Placed assets generate their own geometries, materials and part nodes each time; an exported or checkpointed recipe may still carry them.
  recipe.geometries ??= [];
  recipe.materials ??= [];
  if (Array.isArray(recipe.geometries)) recipe.geometries = recipe.geometries.filter(geometry => geometry?.type !== 'asset');
  if (Array.isArray(recipe.materials)) recipe.materials = recipe.materials.filter(material => !material?.assetSource);
  if (Array.isArray(recipe.nodes)) recipe.nodes = recipe.nodes.filter(node => !node?.assetPart);
  recipe.geometries = resources(recipe.geometries, limits.maxGeometries, 'geometries', value => {
    geometryEstimate(value);
    const definition = { id: value.id, type: value.type === 'plane' ? 'grid' : value.type };
    for (const field of GEOMETRY_FIELDS[value.type]) {
      if (Object.hasOwn(value, field)) {
        definition[field] = value[field];
      }
    }
    return definition;
  });
  // Every geometry exists now, so cutter IDs, cycles, depth and work can be checked.
  const definitionsById = geometryDefinitions(recipe.geometries);
  recipe.geometries.forEach((definition, index) => {
    if (definition.type === 'mesh') withFieldPrefix(`geometries[${index}]`, () => checkedCutterDependencies(definition, definitionsById));
  });
  recipe.materials = resources(withDefaultMaterial(recipe), limits.maxMaterials, 'materials', materialFrom);
  const distinctPatterns = new Set(recipe.materials.filter(material => material.pattern).map(material => JSON.stringify(material.pattern)));
  if (distinctPatterns.size > MAX_MATERIAL_PATTERNS) {
    throw invalidField('materials', `${distinctPatterns.size} different patterns`, `at most ${MAX_MATERIAL_PATTERNS} different material patterns; reuse one and tint it with color`);
  }
  recipe.nodes = withoutArmatureNodes(recipe.nodes);
  if (hasInstancedNodes(recipe.nodes)) recipe.nodes = agentSceneModule('mesh').expandInstancedNodes(recipe.nodes, {
    maxNodes: limits.maxNodes,
    resolveSurface: id => {
      const definition = recipe.geometries.find(geometry => geometry.id === id);
      if (!definition) throw invalidField('instances.surface', id, `the ID of a geometry in geometries, such as ${recipe.geometries[0]?.id ?? 'ground'}`);
      return generateGeometry(definition, Math.min(limits.maxVertices, 1_000_000), cutterScopeOf(recipe.geometries));
    },
  }, recipe.geometries);
  recipe.nodes = resources(recipe.nodes, limits.maxNodes, 'nodes', nodeFrom);
  addArmatures(recipe, limits);
  if (recipe.nodes.some(node => node.relations !== undefined)) {
    recipe.nodes = agentSceneModule('relations').normalizeRelations(recipe.nodes);
  }
  recipe.camera = cameraFrom(recipe.camera);
  const look = {};
  for (const field of ['environment', 'effects', 'shadow']) {
    if (Object.hasOwn(recipe, field)) {
      look[field] = recipe[field];
    }
  }
  Object.assign(recipe, normalizeAgentLook(look));
  if (recipe.camera.fStop !== undefined && recipe.effects?.depthOfField.blur > 0) {
    throw invalidField('camera.fStop', recipe.camera.fStop, 'a camera without effects.depthOfField.blur above 0; set blur to 0 or remove fStop');
  }
  checkLightLinkNames(recipe);
  if (Object.hasOwn(recipe, 'motion')) {
    recipe.motion = recipe.motion === null || recipe.motion === undefined ? null : agentSceneModule('motion').normalizeAgentMotion(recipe.motion, recipe);
  }
  if (Object.hasOwn(recipe, 'physics')) {
    recipe.physics = agentSceneModule('physics').normalizeAgentPhysics(recipe.physics, recipe);
  }
  if (Object.hasOwn(recipe, 'cloth')) {
    recipe.cloth = agentSceneModule('cloth').normalizeAgentCloth(recipe.cloth, recipe);
  }
  if (Object.hasOwn(recipe, 'timeline')) {
    if (recipe.timeline === null) {
      delete recipe.timeline;
    } else {
      recipe.timeline = agentSceneModule('timeline').normalizeFilmTimeline(recipe.timeline, recipe, { checkCamera: shotCameraOverrides => cameraOverridesFrom(recipe.camera, shotCameraOverrides) });
    }
  }
  if (Object.hasOwn(recipe, 'particles')) {
    recipe.particles = agentSceneModule('particles').normalizeAgentParticles(recipe.particles, recipe);
  }
  if (Object.hasOwn(recipe, 'bake')) {
    recipe.bake = recipe.bake === null ? null : agentSceneModule('bake').normalizeAgentBake(recipe.bake);
  }
  if (Object.hasOwn(recipe, 'postPasses')) recipe.postPasses = agentSceneModule('userPass').normalizeUserPasses(recipe.postPasses ?? []);
  recipe = copiedJson(recipe, limits.maxRecipeBytes);
  return recipe;
}

// A shot camera is a partial camera: it must be valid on top of the recipe camera, and only its own fields are kept.
function cameraOverridesFrom(baseCamera, overrides) {
  cameraFrom({ ...baseCamera, ...overrides });
  return structuredClone(overrides);
}

function geometryStats(records) {
  let vertices = 0;
  let geometryBytes = 0;
  let estimatedGeometryBytes = 0;
  for (const record of records) {
    vertices += record.vertices;
    geometryBytes += record.geometryBytes;
    estimatedGeometryBytes += record.estimatedVertices * 56;
  }
  return { vertices, geometryBytes, estimatedGeometryBytes };
}

function batchSignature(material) {
  // Textures are fixed per renderer, so a changed pattern rebuilds it like a changed tag does.
  // Transmission moves a material to the pass that sees the opaque scene, which is fixed per renderer.
  return `${material.tag}|${material.alphaMode}|${material.opacity}|${material.transmission > 0}|${material.doubleSided}|${JSON.stringify(material.pattern ?? material.map ?? null)}|${JSON.stringify(material.snippet)}`;
}

function materialHandle(snapshot, sequence) {
  const holder = { snapshot, sequence };
  const output = {};
  for (const field of ['id', 'tag', ...MATERIAL_FIELDS]) {
    Object.defineProperty(output, field, {
      enumerable: true,
      configurable: true,
      get() {
        return holder.snapshot[field];
      },
    });
  }
  for (const field of PATTERN_TEXTURE_FIELDS) {
    Object.defineProperty(output, field, {
      enumerable: true,
      // Baked on first read, so validating or inspecting a recipe never pays for it.
      get() {
        if (field === 'map' && holder.sequence) return holder.sequence.descriptor;
        return holder.snapshot.pattern ? agentSceneModule('patterns').materialPatternTextures(holder.snapshot.pattern)[field] : undefined;
      },
    });
  }
  return { holder, output: Object.freeze(output) };
}

function immutableMaterial(snapshot) {
  for (const field of ['color', 'emissiveColor', 'absorption', 'aov']) {
    if (snapshot[field]) {
      Object.freeze(snapshot[field]);
    }
  }
  return Object.freeze(snapshot);
}

const NO_ASSETS = Object.freeze({ placements: [], animators: [], geometryParts: new Map(), materialOutputs: new Map(), partExtras: new Map() });

// A placed asset's material is the decoded one, shared by every placement that uses the same overrides.
function assetMaterialHandle(snapshot, output, ...candidates) {
  const reusable = candidates.find(handle => handle?.output === output);
  return reusable ?? { holder: { snapshot }, output };
}

function retainedMatrices(parts) {
  for (const part of parts) {
    if (part.matrix.length !== 16 || part.matrix.byteLength !== 64) {
      throw new RangeError('Retained render matrices must not be detached.');
    }
  }
}

function cameraPoseFrom(pose) {
  const camera = cameraFrom({
    eye: Array.from(pose.eye), target: Array.from(pose.target), up: Array.from(pose.up),
    ...(pose.focalLength === undefined ? { fov: pose.fov } : {}), near: pose.near, far: pose.far,
    ...Object.fromEntries(CAMERA_LENS_FIELDS.filter(field => pose[field] !== undefined).map(field => [field, pose[field]])),
  });
  const view = mat4.lookAt(mat4.create(), camera.eye, camera.target, camera.up);
  for (const aspect of [1 / 16, 16]) {
    const projection = applyProjection(mat4.create(), camera, aspect);
    const combined = mat4.multiply(mat4.create(), projection, view);
    if (![projection, combined].every(matrix => matrix.every(Number.isFinite))) {
      throw new RangeError('Motion camera matrices exceed the supported Float32 aspect range.');
    }
  }
  return camera;
}

// Physics holds its last pose after its duration, so a seek past the end is the resting state.
function simulatedPose(stagedState, time) {
  return time === null ? null : stagedState.physicsSampler?.sample(Math.min(time, stagedState.physicsSampler.duration));
}

/** The local transform of a node at a sampled motion and simulated pose: a body, then a track, then the rest value. */
function localTransformOf(node, sampled, simulated) {
  const patch = sampled?.nodes.get(node.id);
  const bodyPatch = simulated?.get(node.id);
  return {
    translation: bodyPatch?.translation ?? patch?.translation ?? node.translation,
    rotation: bodyPatch?.rotation ?? patch?.rotation ?? node.rotation,
    scale: patch?.scale ?? node.scale,
  };
}

/** What a bake-motion operation samples: the committed scene's local node transforms at any time, without touching the pose. */
function motionBakeSource(stagedState) {
  const nodesById = new Map(stagedState.recipe.nodes.map(node => [node.id, node]));
  return {
    animated: Boolean(stagedState.motionSampler || stagedState.physicsSampler),
    motionDuration: stagedState.recipe.motion?.duration ?? 0,
    physicsDuration: stagedState.physicsSampler?.duration ?? 0,
    sampleLocalTransforms(time, ids) {
      const sampled = stagedState.motionSampler?.sample(time) ?? null;
      const simulated = simulatedPose(stagedState, time);
      return new Map(ids.map(id => [id, localTransformOf(nodesById.get(id), sampled, simulated)]));
    },
  };
}

// Candidate buffers are private. A failed seek cannot publish half a pose to render handles.
function stagePose(stagedState, time) {
  const sampled = time === null ? null : stagedState.motionSampler?.sample(time);
  const hiddenNodes = hiddenNodeIds(stagedState.recipe, sampled);
  const simulated = simulatedPose(stagedState, time);
  const graph = stagedState.poseGraph ?? stagedState.graph;
  if (stagedState.poseGraph) {
    for (const node of stagedState.recipe.nodes) {
      const { translation, rotation, scale } = localTransformOf(node, sampled, simulated);
      if (Array.from(scale).some(component => !Number.isFinite(Math.fround(component)) || Math.fround(component) <= 0)) {
        throw new RangeError('Motion scale must remain positive at Float32 precision.');
      }
      if (node.assetPart) {
        graph.getNode(node.id).localMatrix.set(node.assetPart.matrix);
        continue;
      }
      mat4.fromRotationTranslationScale(graph.getNode(node.id).localMatrix, rotation, translation, scale);
    }
    graph.update();
    validateGraph(graph, stagedState.localBounds);
  }
  stageSkinPoses(stagedState.skinStages, graph);
  const materialUpdates = [];
  for (const material of stagedState.recipe.materials) {
    const patch = sampled?.materials.get(material.id);
    let snapshot = material;
    if (patch) {
      const definition = { ...material, ...patch };
      for (const field of ['color', 'emissiveColor']) {
        if (definition[field]) {
          definition[field] = Array.from(definition[field]);
        }
      }
      snapshot = immutableMaterial(materialFrom(definition));
    }
    materialUpdates.push({ holder: stagedState.materialHandles.get(material.id).holder, snapshot });
  }
  const camera = sampled?.camera ? cameraPoseFrom(sampled.camera) : stagedState.recipe.camera;
  retainedMatrices(stagedState.parts);
  const clothGeometries = sampledGeometries(stagedState, time, sampled);
  // Staged last: a pose pending on a decoded asset must be committed or discarded, so nothing above may throw after it.
  const assetClips = stagedState.assetRuntime.animators.length ? agentSceneModule('assets').stageAssetClips(stagedState.assetRuntime, graph, time) : null;
  const movedLook = stagedState.motionSampler && agentSceneModule('motion').motionMovesLook(sampled) ? sampled : null;
  return { graph, materialUpdates, camera, time, clothGeometries, assetClips, hiddenNodes, movedLook, morphs: sampled?.morphs ?? null };
}

/**
 * Geometries of mesh stacks whose ocean time a geometry track drives, keyed by node ID. Each one is built from the cached edits with
 * every ocean node's `time` set to the sampled value, so it equals the still of a recipe that writes that time into the node. The last
 * result of each geometry is kept, so a repeated time reuses the geometry and the renderer sees no change.
 */
function oceanTimeGeometries(stagedState, sampled) {
  const patches = sampled?.geometries;
  if (!patches?.size) {
    return new Map();
  }
  const frames = stagedState.oceanFrames ??= new Map();
  const geometries = new Map();
  for (const [geometryId, patch] of patches) {
    let frame = frames.get(geometryId);
    if (frame?.time !== patch.oceanTime) {
      const definition = stagedState.recipe.geometries.find(candidate => candidate.id === geometryId);
      const stack = definition.stack.map(node => (node.op === 'ocean' ? { ...node, time: patch.oceanTime } : node));
      const scope = cutterScopeOf(stagedState.recipe.geometries);
      frame = { time: patch.oceanTime, geometry: Object.freeze(generateGeometry({ ...definition, stack }, stagedState.maxGeometryVertices, scope)) };
      frames.set(geometryId, frame);
    }
    for (const node of stagedState.recipe.nodes) {
      if (node.geometry === geometryId) geometries.set(node.id, frame.geometry);
    }
  }
  return geometries;
}

// Cloth and particles replace the geometry of their own nodes at a sampled time; no node belongs to both.
function sampledGeometries(stagedState, time, sampled) {
  if (time === null) {
    return null;
  }
  const geometries = oceanTimeGeometries(stagedState, sampled);
  for (const sampler of [stagedState.clothSampler, stagedState.particleSampler]) {
    sampler?.sample(time)?.forEach((geometry, nodeId) => geometries.set(nodeId, geometry));
  }
  return geometries.size ? geometries : null;
}

function partFlagsOf(node) {
  return Object.fromEntries(PART_FLAG_FIELDS.filter(flag => node[flag] !== undefined).map(flag => [flag, node[flag]]));
}

function sameRenderFlags(part, node, usesVisibility, assetExtras) {
  return PART_FLAG_FIELDS.every(flag => part[flag] === (node[flag] ?? assetExtras?.[flag])) && Boolean(part.visibility) === usesVisibility;
}

function recipeUsesVisibility(recipe) {
  return recipe.nodes.some(node => node.visible !== undefined) || Boolean(recipe.motion?.tracks?.some(track => track.kind === 'node' && track.property === 'visible'));
}

/** Node IDs hidden at a pose: a node set invisible by its field or a sampled track, and everything under it. */
function hiddenNodeIds(recipe, sampled) {
  const hidden = new Set();
  if (!recipeUsesVisibility(recipe)) return hidden;
  const byId = new Map(recipe.nodes.map(node => [node.id, node]));
  const hiddenOwn = node => {
    const keyed = sampled?.nodes.get(node.id)?.visible;
    return keyed === undefined ? node.visible === false : keyed < 0.5;
  };
  for (const node of recipe.nodes) {
    for (let cursor = node, depth = 0; cursor && depth < 256; cursor = byId.get(cursor.parent), depth++) {
      if (hiddenOwn(cursor)) {
        hidden.add(node.id);
        break;
      }
    }
  }
  return hidden;
}

// Cloth keeps one geometry per sheet that every sample rewrites, so the parts of a later seek are the previous ones and the
// renderer sees no topology change. Particles still bring a new geometry per time, so those parts are replaced.
function partsWithCloth(restParts, clothGeometries, previousParts) {
  if (!clothGeometries) {
    return restParts;
  }
  const next = restParts.map((part, index) => {
    const geometry = clothGeometries.get(part.name);
    return !geometry ? part : previousParts[index]?.geometry === geometry ? previousParts[index] : Object.freeze({ ...part, geometry });
  });
  return next.every((part, index) => part === previousParts[index]) ? previousParts : Object.freeze(next);
}

// A shape key weighs what its morph track samples at this time, or its starting value when no track names it.
function publishShapeKeyWeights(part, sampledMorphs) {
  const { morphTargetNames, morphTargetValues, morphGrowth } = part.geometry;
  if (!morphTargetNames || !part.morph) return;
  if (morphGrowth) {
    const growth = sampledMorphs?.get(morphGrowth.name)?.weight ?? morphGrowth.value;
    agentSceneModule('modeling').growthWeights(morphGrowth.steps, growth).forEach((weight, index) => {
      part.morph.weights[index] = weight;
    });
    return;
  }
  morphTargetNames.forEach((name, index) => {
    part.morph.weights[index] = sampledMorphs?.get(name)?.weight ?? morphTargetValues[index];
  });
}

/** Returns true when the parts handed to a renderer changed, which the caller counts as a topology change. */
function publishPose(stagedState, pose) {
  for (const part of stagedState.restParts) {
    if (part.visibility) part.visibility.visible = !pose.hiddenNodes.has(part.name);
    Float32Array.prototype.set.call(part.matrix, pose.graph.getNode(part.name).worldMatrix);
    publishShapeKeyWeights(part, pose.morphs);
  }
  for (const update of pose.materialUpdates) {
    update.holder.snapshot = update.snapshot;
  }
  publishSkinPoses(stagedState.skinStages);
  if (pose.assetClips) {
    pose.assetClips.commit();
    for (const part of stagedState.restParts) {
      const matrix = pose.assetClips.matrices.get(part.name);
      if (matrix) Float32Array.prototype.set.call(part.matrix, matrix);
    }
  }
  for (const sequence of stagedState.sequences) sequence.seek(pose.time);
  stagedState.renderCamera = pose.camera;
  stagedState.movedLook = pose.movedLook;
  stagedState.motionTime = pose.time;
  const nextParts = partsWithCloth(stagedState.restParts, pose.clothGeometries, stagedState.parts);
  const partsChanged = nextParts !== stagedState.parts;
  stagedState.parts = nextParts;
  return partsChanged;
}

// The recipe an agent wrote: without the geometries, materials and part nodes that placed assets generate.
function authoredRecipe(recipe) {
  const authored = structuredClone(recipe);
  authored.nodes = authored.nodes.filter(node => !node.assetPart);
  authored.geometries = authored.geometries.filter(geometry => geometry.type !== 'asset');
  authored.materials = authored.materials.filter(material => !material.assetSource);
  return authored;
}

// The mesh geometry an edit names; `remedy` tells what to do when it is another type.
function meshGeometryTarget(candidate, operation, remedy) {
  identifier(operation.geometry);
  const target = candidate.geometries.find(geometry => geometry.id === operation.geometry);
  if (!target) {
    throw invalidField('geometry', operation.geometry, `one of ${[...candidate.geometries.map(known => known.id)].join(', ')}`);
  }
  if (target.type !== 'mesh') {
    throw invalidField('geometry', operation.geometry, `the ID of a mesh geometry, but it is a ${target.type}. ${remedy(target.type)}`, TypeError);
  }
  return target;
}

function removeNode(candidate, operation) {
  knownKeys(operation, ['type', 'id', 'recursive'], 'operation');
  identifier(operation.id);
  const recursive = operation.recursive === undefined ? false : operation.recursive;
  if (typeof recursive !== 'boolean') {
    throw invalidField('recursive', recursive, 'true or false', TypeError);
  }
  if (!candidate.nodes.some(node => node.id === operation.id)) {
    throw invalidField('id', operation.id, 'the ID of a node in nodes; scene_inspect lists them');
  }
  const children = new Map();
  for (const node of candidate.nodes) {
    const siblings = children.get(node.parent) ?? [];
    siblings.push(node.id);
    children.set(node.parent, siblings);
  }
  if (!recursive && (children.get(operation.id)?.length ?? 0) > 0) {
    throw invalidField('recursive', recursive, 'true for a node with children, such as true; or remove the children first');
  }
  const removed = new Set([operation.id]);
  const pending = [operation.id];
  if (recursive) {
    for (let cursor = 0; cursor < pending.length; cursor++) {
      for (const child of children.get(pending[cursor]) ?? []) {
        if (!removed.has(child)) {
          removed.add(child);
          pending.push(child);
        }
      }
    }
  }
  candidate.nodes = candidate.nodes.filter(node => !removed.has(node.id));
  return removed;
}

/** A bounded CPU authoring session. Render adapters must treat geometry as immutable. */
export function createAgentScene(input, inputLimits = {}, options = {}) {
  const limits = resolveLimits(inputLimits);
  const assetOutputCache = new Map();
  let state = null;
  let revision = 0;
  let topologyRevision = 0;
  // Undo revisions the latest stage released to fit the vertex budget; the edit's answer tells the agent.
  let releasedRevisionCount = 0;
  let physicsBake = null;
  let clothBake = null;
  let particleBake = null;
  let lightBake = null;
  let lightLinkCache = null;
  let objectReflectionCache = null;
  const skinCache = new Map();
  const checkpoints = new Map();
  // The states before the last edits, oldest first, each with the revision number it had.
  const revisionHistory = [];

  function snapshotState() {
    return {
      recipe: authoredRecipe(state.recipe),
      geometryRecords: new Map(state.geometryRecords),
      materialHandles: new Map(state.materialHandles),
      restParts: state.restParts,
      sourceRestParts: state.sourceRestParts,
    };
  }

  function drawnNodeGeometry(id, label) {
    identifier(id);
    const node = state.recipe.nodes.find(value => value.id === id);
    const geometry = node && state.geometries.get(node.geometry);
    if (!geometry) throw invalidField(`path.${label}`, id, 'the ID of a node with a drawn geometry; scene_inspect lists node IDs');
    return { geometry, worldMatrix: state.graph.getNode(id).worldMatrix };
  }

  // The route is computed over the authored pose of the ground and of the nodes to avoid, like the bounds in scene_inspect.
  const pathQuery = query => agentSceneModule('navigation').resolvePathQuery(query, drawnNodeGeometry, boundsFor);

  function ownedGeometryRecords() {
    const records = new Set(state?.geometryRecords.values() ?? []);
    const snapshots = [...checkpoints.values(), ...revisionHistory.map(entry => entry.snapshot)];
    for (const snapshot of snapshots) {
      for (const record of snapshot.geometryRecords.values()) {
        records.add(record);
      }
    }
    return records;
  }

  function stage(inputRecipe, preferred = null, removedNodes = new Set(), removedMaterials = new Set()) {
    releasedRevisionCount = 0;
    const recipe = normalizeRecipe(inputRecipe, limits);
    const placedRuntime = recipe.nodes.some(node => node.asset)
      ? agentSceneModule('assets').expandAssetPlacements(recipe, options.assets, limits, assetOutputCache, recipe.nodes.some(node => node.asset?.drive) ? agentSceneModule('drive').createAssetDrive : null)
      : NO_ASSETS;
    // Grown vegetation travels the placed-asset channel; its module returns the placed runtime with its own parts added.
    const assetRuntime = recipe.nodes.some(node => node.vegetation)
      ? agentSceneModule('vegetation').expandVegetation(recipe, limits, assetOutputCache, placedRuntime)
      : placedRuntime;
    if (state) {
      retainedMatrices(state.parts);
    }
    const definitionsById = geometryDefinitions(recipe.geometries);
    const planGeometry = () => {
      const ownedRecords = ownedGeometryRecords();
      const availableRecords = new Map();
      for (const record of ownedRecords) {
        availableRecords.set(record.signature, record);
      }
      const plans = recipe.geometries.map(definition => {
        const signature = geometrySignature(definition, definitionsById);
        const preferredRecord = preferred?.geometryRecords.get(definition.id);
        const activeRecord = state?.geometryRecords.get(definition.id);
        const existing = [preferredRecord, activeRecord, availableRecords.get(signature)]
          .find(record => record?.signature === signature);
        return { definition, signature, existing, estimatedVertices: definition.type === 'asset' ? 0 : geometryEstimate(definition, { definitions: definitionsById, chain: [] }) };
      });
      const residentStats = geometryStats(ownedRecords);
      const pendingVertices = plans.filter(plan => !plan.existing).reduce((total, plan) => total + plan.estimatedVertices, 0);
      const overBudget = residentStats.vertices + pendingVertices > limits.maxVertices ||
        residentStats.geometryBytes + pendingVertices * 56 > limits.maxGeometryBytes;
      return { plans, residentStats, pendingVertices, overBudget };
    };
    let planned = planGeometry();
    // Automatic undo history never blocks an edit: drop the oldest kept revisions before refusing for budget.
    while (planned.overBudget && revisionHistory.length > 0) {
      revisionHistory.shift();
      releasedRevisionCount++;
      planned = planGeometry();
    }
    let { residentStats } = planned;
    const { plans, pendingVertices } = planned;
    if (planned.overBudget) {
      throw new RangeError('Geometry preflight exceeds peak maxVertices or maxGeometryBytes across active, checkpoint and staged resources. Reduce detail or release checkpoints');
    }

    // Validate references, hierarchy and matrix arithmetic before generating any new resource.
    const placeholders = new Map();
    const placeholderBounds = new Map();
    for (const plan of plans) {
      const geometry = plan.existing?.geometry ?? Object.freeze({});
      placeholders.set(plan.definition.id, geometry);
      placeholderBounds.set(geometry, plan.existing?.bounds ?? { min: [0, 0, 0], max: [0, 0, 0] });
    }
    compile(recipe, placeholders, placeholderBounds, limits);

    const geometryRecords = new Map();
    for (const plan of plans) {
      let record = plan.existing;
      if (!record && plan.definition.type === 'asset') {
        // A decoded asset geometry is shared by every placement. Its size is bounded by the asset decoder, not by this scene's budget.
        const geometry = assetRuntime.geometryParts.get(plan.definition.id);
        record = Object.freeze({ signature: plan.signature, geometry, bounds: boundsFor(geometry, mat4.create()), vertices: 0, geometryBytes: 0, estimatedVertices: 0 });
      } else if (!record) {
        const geometry = Object.freeze(generateGeometry(plan.definition, Math.min(limits.maxVertices, 1_000_000), { definitions: definitionsById, chain: [] }));
        const geometryBytes = Object.values(geometry).reduce((total, array) => total + array.byteLength, 0);
        const vertices = geometry.positions.length / 3;
        if (plan.definition.type === 'mesh') {
          // Edits can grow a mesh past its estimate. Undo history never blocks an edit, so release the oldest revisions before refusing.
          while (revisionHistory.length > 0 && residentStats.vertices + pendingVertices - plan.estimatedVertices + vertices > limits.maxVertices) {
            revisionHistory.shift();
            releasedRevisionCount++;
            residentStats = geometryStats(ownedGeometryRecords());
          }
          if (residentStats.vertices + pendingVertices - plan.estimatedVertices + vertices > limits.maxVertices) {
            throw new RangeError(`Mesh ${plan.definition.id} has ${vertices} render vertices after its edits, which exceeds maxVertices across the scene. Reduce detail or edits.`);
          }
        } else if (vertices > plan.estimatedVertices || geometryBytes > plan.estimatedVertices * (56 + TERRAIN_SKY_VISIBILITY_BYTES)) {
          throw new RangeError('Generated geometry exceeds its conservative preflight bound.');
        }
        record = Object.freeze({
          signature: plan.signature, geometry,
          bounds: boundsFor(geometry, mat4.create()),
          vertices, geometryBytes, estimatedVertices: plan.estimatedVertices,
        });
      }
      geometryRecords.set(plan.definition.id, record);
    }
    const geometries = new Map([...geometryRecords].map(([id, record]) => [id, record.geometry]));
    const localBounds = new Map([...geometryRecords.values()].map(record => [record.geometry, record.bounds]));
    if (recipe.nodes.some(node => node.relations?.length)) {
      recipe.nodes = agentSceneModule('relations').solveRelations(recipe.nodes, (node, worldMatrix, region) => {
        const geometry = geometries.get(node.geometry);
        const regionGeometry = region === undefined ? geometry : agentSceneModule('mesh').taggedFacePositions(geometry, region);
        return boundsFor(regionGeometry, worldMatrix);
      });
    }
    const graph = compile(recipe, geometries, localBounds, limits);
    const skinBindings = bindSkins({ recipe, graph, geometryRecords, cache: skinCache });
    const materialHandles = new Map();
    for (const material of recipe.materials) {
      const snapshot = immutableMaterial(material);
      const preferredHandle = preferred?.materialHandles.get(material.id);
      const activeHandle = removedMaterials.has(material.id) ? null : state?.materialHandles.get(material.id);
      // The renderer keeps tag, blending, opacity and sidedness per batch, so a handle is reused only when all match.
      const existing = [preferredHandle, activeHandle].find(handle => handle && batchSignature(handle.holder.snapshot) === batchSignature(material));
      const assetOutput = assetRuntime.materialOutputs.get(material.id);
      const handle = assetOutput ? assetMaterialHandle(snapshot, assetOutput, preferredHandle, activeHandle) : existing ?? materialHandle(snapshot, material.map && agentSceneModule('assets').createTextureSequence(material.id, material.map, options.sequenceFrames));
      materialHandles.set(material.id, handle);
    }
    const activeParts = new Map(state?.sourceRestParts.map(part => [part.name, part]) ?? []);
    const preferredParts = new Map(preferred?.sourceRestParts.map(part => [part.name, part]) ?? []);
    const usesVisibility = recipeUsesVisibility(recipe);
    const nextParts = recipe.nodes.filter(node => node.geometry !== undefined).map(node => {
      const binding = skinBindings.get(node.id);
      const sourceGeometry = binding?.geometry ?? geometries.get(node.geometry);
      const geometry = sourceGeometry.vertexGroups?.foam ? agentSceneModule('mesh').waterFoamGeometry(sourceGeometry, materialHandles.get(node.material).output) : sourceGeometry;
      const material = materialHandles.get(node.material).output;
      const assetExtras = assetRuntime.partExtras.get(node.id);
      // Shape keys of a recipe mesh are morph targets with their own weights per part; an imported asset brings its own pose.
      const shapeKeyMorph = geometry.morphTargetValues && !assetExtras?.morph ? { weights: Float32Array.from(geometry.morphTargetValues) } : undefined;
      const activePart = removedNodes.has(node.id) ? null : activeParts.get(node.id);
      const existing = [activePart, preferredParts.get(node.id)]
        .find(part => part?.geometry === geometry && part.material === material && part.skin === (assetExtras?.skin ?? binding?.skin) && (assetExtras?.morph ? part.morph === assetExtras.morph : Boolean(part.morph) === Boolean(shapeKeyMorph)) && depthLayerOf(part) === depthLayerOf(node) && sameRenderFlags(part, node, usesVisibility, assetExtras));
      return existing ?? Object.freeze({
        name: node.id, geometry, material,
        ...(depthLayerOf(node) ? { depthLayer: depthLayerOf(node) } : {}),
        ...partFlagsOf(node),
        // The renderer reads this holder every update, and publishPose rewrites it for each pose.
        ...(usesVisibility ? { visibility: { visible: true } } : {}),
        matrix: new Float32Array(graph.getNode(node.id).worldMatrix),
        ...(binding ? { skin: binding.skin } : {}),
        ...(shapeKeyMorph ? { morph: shapeKeyMorph } : {}),
        ...assetExtras,
      });
    });
    retainedMatrices(nextParts);
    const sameParts = state && state.sourceRestParts.length === nextParts.length &&
      state.sourceRestParts.every((part, index) => part === nextParts[index]);
    const sourceRestParts = sameParts ? state.sourceRestParts : Object.freeze(nextParts);
    const lightBakeResult = stageLightBake(recipe, sourceRestParts, graph);
    const { reflected, restParts } = stageRestParts(recipe, sourceRestParts, lightBakeResult, graph);
    const stagedState = {
      recipe, geometryRecords, geometries, graph, materialHandles,
      // Part identity decides what the next stage reuses, so it compares the parts as built, before any bake.
      sourceRestParts,
      parts: restParts, restParts,
      bakeReport: lightBakeResult ? { ...lightBakeResult.report, reused: lightBakeResult.reused } : null,
      reflectionReport: reflected ? reflected.report : null,
      // A renderer holding the deformed cloth parts of the old state needs the rest parts back as a topology change.
      topologyChanged: Boolean(state && (restParts !== state.restParts || state.parts !== state.restParts)),
      stats: geometryStats(geometryRecords.values()),
    };
    stagedState.assetRuntime = assetRuntime;
    stagedState.maxGeometryVertices = Math.min(limits.maxVertices, 1_000_000);
    stagedState.sequences = [...materialHandles.values()].map(handle => handle.holder.sequence).filter(Boolean);
    stagedState.localBounds = localBounds;
    stagedState.skinBindings = skinBindings;
    stagedState.skinStages = createSkinStages(skinBindings);
    stagedState.motionSampler = recipe.motion ? agentSceneModule('motion').compileAgentMotion(recipe.motion, recipe) : null;
    stagedState.physicsSampler = stagePhysics(recipe, geometryRecords);
    stagedState.clothSampler = stageCloth(recipe, geometryRecords, stagedState.motionSampler);
    stagedState.particleSampler = stageParticles(recipe, geometryRecords);
    const animated = Boolean(stagedState.motionSampler || stagedState.physicsSampler || stagedState.clothSampler || stagedState.particleSampler || assetRuntime.animators.length);
    stagedState.poseGraph = animated ? compile(recipe, geometries, localBounds, limits) : null;
    stagedState.initialPose = stagePose(stagedState, animated ? 0 : null);
    return stagedState;
  }

  // Parts a linked light skips carry a light mask in their material. The same parts and links give the same objects, so
  // an edit that changes neither is not a topology change for the renderer.
  function stageLightLinks(recipe, parts) {
    if (!environmentLinksLights(recipe.environment)) {
      return parts;
    }
    const { environment } = recipe;
    const linksKey = lightLinksKey(environment);
    if (lightLinkCache?.parts === parts && lightLinkCache.linksKey === linksKey) {
      return lightLinkCache.linked;
    }
    const linking = agentSceneModule('lightLinking');
    const masks = linking.lightMasksFor(parts, environment);
    const wrappers = new Map();
    const linked = Object.freeze(parts.map((part, index) => (masks[index] === ALL_LIGHTS_MASK ? part
      : Object.freeze({ ...part, material: linkedMaterial(part.material, masks[index], wrappers) }))));
    lightLinkCache = { parts, linksKey, linked };
    return linked;
  }

  // The bake no longer matches the frame: motion moved a light, the sun or a part off the pose it was traced at.
  // Only a scene with both a bake and motion pays for this check, and bake.rebake turns it off (it bakes each sampled pose).
  function staleBakeProblems() {
    return lightBake && state.recipe.bake && state.motionSampler ? agentSceneModule('bake').staleBakeProblems(state, lightBake.key) : [];
  }

  function stageRestParts(recipe, sourceRestParts, lightBakeResult, graph) {
    const baked = lightBakeResult?.parts ?? sourceRestParts;
    const reflected = stageObjectReflections(recipe, sourceRestParts, baked, graph);
    return { reflected, restParts: stageCoplanarOffsets(recipe, stageLightLinks(recipe, stageFloorSky(recipe, reflected ? reflected.parts : baked))) };
  }

  // bake.rebake: a frame sampled at a pose the bake was not traced at is lit by a bake of that pose, cached by its key.
  function rebakeAtPose(pose) {
    const rebaked = state.recipe.bake?.rebake && agentSceneModule('bake').bakeAtSampledPose(lightBake, state.recipe, pose);
    if (rebaked) {
      state.restParts = stageRestParts(state.recipe, state.sourceRestParts, rebaked, pose.graph).restParts;
      state.bakeReport = rebaked.report;
    }
  }

  // A light bake costs seconds of ray tracing: it runs when the parts, the lights, the materials or the bake fields
  // change, and every other edit, seek or camera move reuses the last result.
  function stageLightBake(recipe, sourceRestParts, graph) {
    if (!recipe.bake) {
      return null;
    }
    const worldMatrices = new Map(sourceRestParts.map(part => [part.name, new Float32Array(graph.getNode(part.name).worldMatrix)]));
    const generatedGeometryGenerators = agentSceneModule('bake').bakeGenerators(recipe);
    const key = agentSceneModule('bake').lightBakeKey(recipe, generatedGeometryGenerators, recipe.environment, worldMatrices);
    if (lightBake?.key === key && lightBake.sourceRestParts === sourceRestParts) {
      lightBake.currentKey = key;
      return { ...lightBake, reused: true };
    }
    const baked = agentSceneModule('bake').bakeAgentParts(sourceRestParts, worldMatrices, recipe.environment, recipe.bake, generatedGeometryGenerators);
    lightBake = { key, currentKey: key, sourceRestParts, parts: baked.parts, report: baked.report };
    return { ...lightBake, reused: false };
  }

  // Smooth metal parts get a probe of the scene around them (src/agent-reflections.js), unless environment.objectReflections
  // is false. It runs only when that code is loaded, which a recipe with a metallic value of 0.5 or more does.
  function stageObjectReflections(recipe, sourceRestParts, drawnParts, graph) {
    if (recipe.environment.objectReflections === false || !agentSceneModuleLoaded('reflections')) {
      return null;
    }
    objectReflectionCache = agentSceneModule('reflections').stageObjectReflections(objectReflectionCache, recipe, sourceRestParts, drawnParts, graph, agentEnvironmentMap(recipe.environment));
    return objectReflectionCache.result;
  }

  // A closed room a sun lights gets the sky each floor texel sees; the lazy module decides, keeps its result and honours environment.floorSkyTrace.
  function stageFloorSky(recipe, parts) {
    return agentSceneModuleLoaded('floorSky') ? agentSceneModule('floorSky').stageFloorSky(recipe.environment, parts) : parts;
  }

  // A scene that asks for no bake and looks like a closed room gets one diagnostic naming the bake. The ray test costs a
  // few milliseconds, so it runs for scene_inspect only and is kept until the scene changes.
  function isLitByLampsOnly(environment) {
    const lampCount = (environment.pointLights?.length ?? 0) + (environment.spotLights?.length ?? 0) + (environment.areaLights?.length ?? 0);
    const keyColor = environment.keyColor ?? [1, 1, 1];
    const keyLight = (environment.keyIntensity ?? 1) * (keyColor[0] + keyColor[1] + keyColor[2]);
    return lampCount > 0 && keyLight === 0;
  }

  let closedRoomCache = null;
  function closedRoomProblems() {
    if (state.recipe.bake) {
      return [];
    }
    if (closedRoomCache?.revision !== revision) {
      const worldMatrices = new Map(state.parts.map(part => [part.name, state.graph.getNode(part.name).worldMatrix]));
      closedRoomCache = { revision, share: closedRoomShare(state.parts, worldMatrices) };
    }
    const { share } = closedRoomCache;
    return share !== null && share >= CLOSED_ROOM_SHARE ? [closedRoomDiagnostic(share, isLitByLampsOnly(state.recipe.environment))] : [];
  }

  // Near-coplanar triangles are ranked at draw time (issue #751) unless environment.resolveCoplanar is false, once the
  // coplanar code is loaded. The ranks sit beside the parts, so the parts and their geometry stay as they are. The search
  // runs again only when the parts are new objects.
  let flushCache = null;
  function stageCoplanarOffsets(recipe, parts) {
    if (!agentSceneModuleLoaded('coplanar')) {
      return parts;
    }
    const coplanar = agentSceneModule('coplanar');
    if (recipe.environment.resolveCoplanar === false) {
      if (flushCache) {
        coplanar.clearFlushParts(flushCache.parts);
      }
      flushCache = null;
      return parts;
    }
    if (flushCache?.parts !== parts) {
      const resolved = coplanar.resolveFlushParts(parts);
      // Ranked parts batch apart, so the list they are staged in is a new one: the renderer then regroups, also when the
      // ranking is switched on or off for parts that did not change.
      flushCache = { parts, staged: resolved.ranked ? Object.freeze([...parts]) : parts, ...resolved };
    }
    return flushCache.staged;
  }

  // scene_inspect names what the ranking could not settle. A scene that opted out gets the pairs of parts that fight instead:
  // that check is bounded, runs on inspect only and is kept until the scene changes.
  let coplanarReportCache = null;
  function coplanarProblems() {
    if (!agentSceneModuleLoaded('coplanar')) {
      return [];
    }
    if (state.recipe.environment.resolveCoplanar !== false) {
      return agentSceneModule('coplanar').flushLeftoverDiagnostics(flushCache?.leftovers ?? []);
    }
    if (coplanarReportCache?.revision !== revision) {
      const coplanar = agentSceneModule('coplanar');
      coplanarReportCache = { revision, problems: coplanar.coplanarOverlapDiagnostics(coplanar.findCoplanarOverlaps(state.parts)) };
    }
    return coplanarReportCache.problems;
  }

  // A bake costs a solver run, so an unchanged section on unchanged geometry reuses the last one.
  function stagePhysics(recipe, geometryRecords) {
    if (!recipe.physics) {
      return null;
    }
    const key = agentSceneModule('physics').physicsBakeKey(recipe, geometryRecords);
    if (physicsBake?.key !== key) {
      const geometries = new Map([...geometryRecords].map(([id, record]) => [id, record.geometry]));
      physicsBake = { key, sampler: agentSceneModule('physics').bakeAgentPhysics(recipe.physics, recipe, geometries) };
    }
    return physicsBake.sampler;
  }

  // Same rule as physics: an unchanged cloth section on unchanged geometry and nodes reuses the last bake.
  function stageCloth(recipe, geometryRecords, motionSampler) {
    if (!recipe.cloth) {
      return null;
    }
    const involved = new Set([...recipe.cloth.sheets, ...(recipe.cloth.colliders ?? [])].map(entry => entry.node));
    const involvedNodes = recipe.nodes.filter(node => involved.has(node.id));
    const followsMotion = recipe.cloth.sheets.some(sheet => sheet.pinTo) || (recipe.cloth.colliders ?? []).some(collider => collider.node === undefined);
    const key = JSON.stringify([recipe.cloth, involvedNodes, involvedNodes.map(node => geometryRecords.get(node.geometry)?.signature), followsMotion ? [recipe.motion, recipe.nodes, recipe.armatures] : null]);
    if (clothBake?.key !== key) {
      const geometries = new Map([...geometryRecords].map(([id, record]) => [id, record.geometry]));
      clothBake = { key, sampler: agentSceneModule('cloth').bakeAgentCloth(recipe.cloth, recipe, geometries, motionSampler) };
    }
    return clothBake.sampler;
  }

  // Particle launches are cheap to recompute, but an unchanged section on unchanged nodes still reuses them.
  function stageParticles(recipe, geometryRecords) {
    if (!recipe.particles) {
      return null;
    }
    const involvedNodes = recipe.nodes.filter(node => recipe.particles.systems.some(system => system.node === node.id));
    const key = JSON.stringify([recipe.particles, involvedNodes, involvedNodes.map(node => geometryRecords.get(node.geometry).signature)]);
    if (particleBake?.key !== key) {
      const geometries = new Map([...geometryRecords].map(([id, record]) => [id, record.geometry]));
      particleBake = { key, sampler: agentSceneModule('particles').bakeAgentParticles(recipe.particles, recipe, geometries) };
    }
    return particleBake.sampler;
  }

  function commit(stagedState, incrementRevision) {
    publishPose(stagedState, stagedState.initialPose);
    if (stagedState.topologyChanged) {
      topologyRevision++;
    }
    if (incrementRevision && state) {
      revisionHistory.push({ revision, snapshot: snapshotState() });
      while (revisionHistory.length > REVISION_HISTORY_LIMIT) {
        revisionHistory.shift();
      }
    }
    state = stagedState;
    if (incrementRevision) {
      revision++;
    }
    return revision;
  }

  function expected(options) {
    knownKeys(options, ['expectedRevision'], 'transaction options');
    if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision !== revision) {
      throw invalidField('expectedRevision', options.expectedRevision, `the current revision, ${revision}; scene_inspect returns it`);
    }
  }

  commit(stage(input), false);
  return Object.freeze({
    capabilities: AGENT_SCENE_CAPABILITIES,
    limits,
    get parts() {
      return state.parts;
    },
    /** How many oldest undo revisions the latest edit released to fit maxVertices; 0 when none. */
    get releasedRevisions() {
      return releasedRevisionCount;
    },
    get revision() {
      return revision;
    },
    get topologyRevision() {
      return topologyRevision;
    },
    get camera() {
      return structuredClone(state.renderCamera);
    },
    get motionTime() {
      return state.motionTime;
    },
    sequenceTextures() {
      return state.sequences;
    },
    sampleMotion(time) {
      if (time !== null && (!Number.isFinite(time) || time < 0 || time > 3600)) {
        throw invalidField('time', time, 'null or a number of seconds from 0 to 3600, such as 0.5');
      }
      if (time !== null && !state.motionSampler && !state.physicsSampler && !state.clothSampler && !state.particleSampler && !state.assetRuntime.animators.length && !state.sequences.length) {
        throw invalidField('time', time, 'null, because this recipe has no motion, physics, cloth, particles or placed asset clip to sample; add motion first');
      }
      const pose = stagePose(state, time);
      rebakeAtPose(pose);
      if (publishPose(state, pose)) {
        topologyRevision++;
      }
      return state.motionTime;
    },
    // After sampleMotion, the lights, sun and sky the motion tracks set at that time; the recipe keeps its authored values.
    get environment() {
      const environment = structuredClone(state.recipe.environment);
      return state.movedLook ?agentSceneModule('motion').motionEnvironment(environment, state.movedLook) : environment;
    },
    /** World bounds ({ name, min, max }) of the visible mesh parts in the current pose; parts with no known bounds are left out. */
    worldBounds() {
      const bounds = [];
      // A bake or a skin replaces a drawn part's geometry, so the bounds come from the part as built, in the drawn pose.
      const drawnParts = new Map(state.restParts.map(part => [part.name, part]));
      for (const sourcePart of state.sourceRestParts) {
        const part = drawnParts.get(sourcePart.name);
        const local = state.localBounds.get(sourcePart.geometry);
        if (!part || !local || part.visibility?.visible === false) continue;
        const positions = [];
        for (let corner = 0; corner < 8; corner++) {
          positions.push(corner & 1 ? local.max[0] : local.min[0], corner & 2 ? local.max[1] : local.min[1], corner & 4 ? local.max[2] : local.min[2]);
        }
        bounds.push({ name: part.name, ...boundsFor({ positions }, part.matrix) });
      }
      return bounds;
    },
    /** The bake-stale warning, or none: see `staleBakeProblems` in `agent-bake.js`. */
    bakeStaleness: staleBakeProblems,
    get postPasses() {
      return structuredClone(state.recipe.postPasses ?? []);
    },
    get effects() {
      const effects = structuredClone(state.recipe.effects);
      return state.movedLook?.effects ?agentSceneModule('motion').motionEffects(effects, state.movedLook) : effects;
    },
    get shadow() {
      return structuredClone(state.recipe.shadow);
    },
    exportRecipe() {
      return authoredRecipe(state.recipe);
    },
    /** Bone nodes at rest and a clip baked from motion, as `exportGlb` options. Leaves the pose where it was. */
    rigExport(options = {}) {
      if (!state.recipe.armatures) {
        return { nodes: [], clips: [] };
      }
      const exported = bakeRigExport(state.recipe, state.graph, state.motionSampler, options);
      publishPose(state, stagePose(state, state.motionTime));
      return exported;
    },
    apply(inputOperations, options = {}) {
      expected(options);
      if (!Array.isArray(inputOperations) || inputOperations.length === 0 || inputOperations.length > limits.maxOperations) {
        throw invalidField('operations', Array.isArray(inputOperations) ? `${inputOperations.length} operations` : inputOperations, `a list of 1 to ${limits.maxOperations} operations, such as [{ "type": "set-camera", "fov": 50 }]`);
      }
      const operations = copiedJson(inputOperations, limits.maxRecipeBytes);
      const candidate = authoredRecipe(state.recipe);
      const removedNodes = new Set();
      const removedMaterials = new Set();
      for (const operation of operations) {
        const section = Object.hasOwn(NULLABLE_SECTION_OPERATIONS, operation.type) ? NULLABLE_SECTION_OPERATIONS[operation.type] : null;
        if (section) {
          knownKeys(operation, ['type', section], 'operation');
          if (!Object.hasOwn(operation, section)) {
            throw invalidField(section, undefined, `a ${section} value, or null to clear it, in a ${operation.type} operation`, TypeError);
          }
          candidate[section] = operation[section];
          if (candidate.armatures === null) delete candidate.armatures;
          continue;
        }
        const lookField = Object.hasOwn(LOOK_OPERATION_FIELDS, operation.type) ? LOOK_OPERATION_FIELDS[operation.type] : null;
        if (lookField) {
          knownKeys(operation, ['type', lookField], 'operation');
          const patch = operation[lookField];
          // Spot and area lights, cascades and sun links are absent from a recipe until it sets them.
          const optionalFields = lookField === 'environment' ? ['ground', 'spotLights', 'areaLights', 'shadowCascades', 'localVolumes', 'keyAffects', 'objectReflections', 'floorSkyTrace', 'sunBounce', 'specularAntiAliasing', 'sunAngularRadius', 'lines', 'resolveCoplanar', 'viewTransform', 'look', 'hdri', 'sky'] : lookField === 'effects' ? postStepSupport.fields : [];
          knownKeys(patch, [...Object.keys(candidate[lookField]), ...optionalFields], lookField);
          const nestedField = lookField === 'environment' ? 'volumeFog' : 'bloom';
          const merged = { ...candidate[lookField], ...(lookField === 'environment' ? environmentPatchWithSetup(patch) : patch) };
          if (nestedField && Object.hasOwn(patch, nestedField)) {
            const nestedKeys = nestedField === 'volumeFog' ? [...Object.keys(candidate[lookField][nestedField]), ...VOLUME_FOG_FIELDS] : Object.keys(candidate[lookField][nestedField]);
            knownKeys(patch[nestedField], nestedKeys, nestedField);
            merged[nestedField] = { ...candidate[lookField][nestedField], ...patch[nestedField] };
          }
          if (patch.sky) merged.sky = { ...candidate[lookField].sky, ...patch.sky };
          candidate[lookField] = merged;
          continue;
        }
        const addition = Object.hasOwn(ADDITION_FIELDS, operation.type) ? ADDITION_FIELDS[operation.type] : null;
        if (addition) {
          const [collection, field] = addition;
          knownKeys(operation, ['type', field], 'operation');
          const record = operation[field];
          identifier(record?.id);
          if (operation.type === 'add-geometry') {
            geometryEstimate(record);
          } else if (operation.type === 'add-material') {
            materialFrom(record);
          } else {
            nodeFrom(record);
          }
          if (candidate[collection].some(existing => existing.id === record.id)) {
            throw invalidField(`${field}.id`, record.id, `an ID no ${collection} entry uses yet; pick a new ID, or remove the existing one first`);
          }
          candidate[collection].push(record);
          continue;
        }
        if (operation.type === 'bake-motion') {
          agentSceneModule('motionBake').bakeMotion(candidate, operation, motionBakeSource(state));
          continue;
        }
        if (operation.type === 'edit-mesh') {
          knownKeys(operation, ['type', 'geometry', 'edits', 'replace'], 'operation');
          const target = meshGeometryTarget(candidate, operation, type => `Add a mesh geometry with base: { type: '${type}', ... } to edit it.`);
          if (operation.replace !== undefined && typeof operation.replace !== 'boolean') {
            throw invalidField('replace', operation.replace, 'true or false', TypeError);
          }
          if (!Array.isArray(operation.edits)) {
            throw invalidField('edits', operation.edits, 'an array of mesh edits, such as [{ "op": "extrude" }]', TypeError);
          }
          target.edits = operation.replace ? operation.edits : [...(target.edits ?? []), ...operation.edits];
          agentSceneModule('mesh').normalizeMeshEdits(target.edits);
          continue;
        }
        if (operation.type === 'set-mesh-stack') {
          knownKeys(operation, ['type', 'geometry', 'stack', 'apply'], 'operation');
          const target = meshGeometryTarget(candidate, operation, () => 'Only mesh geometries have a modifier stack.');
          const stack = operation.stack ?? target.stack ?? [];
          agentSceneModule('mesh').normalizeMeshStack(stack);
          const applied = operation.apply ?? 0;
          if (!Number.isInteger(applied) || applied < 0 || applied > stack.length) {
            throw invalidField('apply', applied, `a whole number from 0 to the stack length ${stack.length}, such as 0`);
          }
          // Applying moves the first nodes into the edit log, as Blender's Apply modifier does.
          target.edits = [...(target.edits ?? []), ...stack.slice(0, applied)];
          target.stack = stack.slice(applied);
          agentSceneModule('mesh').normalizeMeshEdits(target.edits);
          continue;
        }
        if (operation.type === 'remove-node') {
          for (const id of removeNode(candidate, operation)) {
            removedNodes.add(id);
          }
          continue;
        }
        const removal = Object.hasOwn(REMOVAL_FIELDS, operation.type) ? REMOVAL_FIELDS[operation.type] : null;
        if (removal) {
          knownKeys(operation, ['type', 'id'], 'operation');
          identifier(operation.id);
          const index = candidate[removal].findIndex(record => record.id === operation.id);
          if (index < 0) {
            throw invalidField('id', operation.id, `the ID of an existing ${removal} entry; scene_inspect lists them`);
          }
          candidate[removal].splice(index, 1);
          if (operation.type === 'remove-material') {
            removedMaterials.add(operation.id);
          }
          continue;
        }
        let target;
        let fields;
        if (operation.type === 'set-node') {
          fields = NODE_FIELDS;
          target = candidate.nodes.find(node => node.id === operation.id);
        } else if (operation.type === 'set-material') {
          fields = [...MATERIAL_FIELDS, 'map'];
          target = candidate.materials.find(material => material.id === operation.id);
        } else if (operation.type === 'set-camera') {
          fields = CAMERA_FIELDS;
          target = candidate.camera;
        } else {
          throw invalidField('type', operation.type, `one of ${AGENT_SCENE_CAPABILITIES.operations.join(', ')}`, TypeError);
        }
        knownKeys(operation, ['type', ...(operation.type === 'set-camera' ? [] : ['id']), ...fields], 'operation');
        if (!target) {
          throw invalidField('id', operation.id, `the ID of an existing ${operation.type === 'set-node' ? 'node' : 'material'}; scene_inspect lists them, or add it first with an add operation`);
        }
        if (operation.type === 'set-camera') {
          applyCameraFields(target, operation);
        } else {
          for (const field of fields) {
            if (Object.hasOwn(operation, field)) {
              target[field] = operation[field];
            }
          }
        }
      }
      return commit(stage(candidate, null, removedNodes, removedMaterials), true);
    },
    inspect(options = {}) {
      knownKeys(options, ['ids', 'limit', 'includeBounds', 'path'], 'inspection');
      const maximum = integer(options.limit ?? Math.min(64, limits.maxNodes), 1, limits.maxNodes, 'inspection limit');
      if (options.includeBounds !== undefined && typeof options.includeBounds !== 'boolean') {
        throw invalidField('includeBounds', options.includeBounds, 'true or false', TypeError);
      }
      if (options.ids !== undefined && (!Array.isArray(options.ids) || options.ids.length > limits.maxNodes)) {
        throw invalidField('ids', Array.isArray(options.ids) ? `${options.ids.length} IDs` : options.ids, `a list of at most ${limits.maxNodes} node IDs, such as ["body"]`);
      }
      const selected = options.ids === undefined ? state.recipe.nodes.filter(node => !node.assetPart) : options.ids.map(id => {
        identifier(id);
        const node = state.recipe.nodes.find(value => value.id === id);
        if (!node) {
          throw invalidField('ids', id, 'IDs of existing nodes; call scene_inspect without ids to list them');
        }
        return node;
      });
      const nodes = selected.slice(0, maximum).map(node => {
        const geometry = state.geometries.get(node.geometry);
        const result = {
          id: node.id, label: node.label ?? node.id, parent: node.parent,
          geometry: node.geometry ?? null, material: node.material ?? null,
          vertices: geometry ? geometry.positions.length / 3 : 0,
          triangles: geometry ? geometry.indices.length / 3 : 0,
        };
        if (options.includeBounds) {
          result.bounds = geometry ? boundsFor(geometry, state.graph.getNode(node.id).worldMatrix) : null;
        }
        return result;
      });
      const resident = geometryStats(ownedGeometryRecords());
      const diagnostics = [...recipeDiagnostics(state.recipe), ...closedRoomProblems(), ...staleBakeProblems(), ...coplanarProblems()];
      return {
        revision, topologyRevision,
        ...(state.recipe.motion?.ik?.length ? { motionIk: agentSceneModule('motion').compileAgentMotion(state.recipe.motion, state.recipe).sweepIk() } : {}),
        motion: state.recipe.motion ? { duration: state.recipe.motion.duration, loop: state.recipe.motion.loop, tracks: state.recipe.motion.tracks.length, time: state.motionTime } : null,
        physics: state.physicsSampler ? state.physicsSampler.report() : null,
        ...(state.clothSampler ? { cloth: state.clothSampler.report() } : {}),
        ...(state.particleSampler ? { particles: state.particleSampler.report() } : {}),
        ...(state.assetRuntime.vegetation ? { vegetation: state.assetRuntime.vegetation } : {}),
        ...(state.assetRuntime.placements.length ? { assets: agentSceneModule('assets').describeAssetPlacements(state.assetRuntime, state.graph, geometry => state.localBounds.get(geometry)) } : {}),
        ...(state.sequences.length ? { textureSequences: state.sequences.map(sequence => sequence.describe()) } : {}),
        ...(state.bakeReport ? { bake: state.bakeReport } : {}),
        ...(state.recipe.postPasses?.length ? { postPasses: agentSceneModule('userPass').describeUserPasses(state.recipe.postPasses) } : {}),
        ...(state.reflectionReport ? { reflections: state.reflectionReport } : {}),
        ...(state.recipe.armatures ? { rig: rigReport(state.recipe, state.skinBindings) } : {}),
        boundsSpace: 'authored-base-world',
        ...(diagnostics.length ? { diagnostics } : {}),
        ...(flushCache?.ranked ? { flush: { ranked: flushCache.ranked } } : {}),
        counts: {
          nodes: state.recipe.nodes.length, parts: state.parts.length,
          geometries: state.geometries.size, materials: state.recipe.materials.length,
          vertices: state.stats.vertices,
        },
        geometryBytes: state.stats.geometryBytes,
        estimatedGeometryBytes: state.stats.estimatedGeometryBytes,
        residentGeometryBytes: resident.geometryBytes,
        residentGeometryVertices: resident.vertices,
        look: {
          world: state.recipe.environment.world,
          pointLights: state.recipe.environment.pointLights.length,
          spotLights: state.recipe.environment.spotLights?.length ?? 0,
          areaLights: state.recipe.environment.areaLights?.length ?? 0,
          volumeFogDensity: state.recipe.environment.volumeFog.density,
          exposure: state.recipe.effects.exposure,
        },
        nodes, truncated: selected.length > nodes.length,
        ...(options.path === undefined ? {} : { path: pathQuery(options.path) }),
      };
    },
    /** Polygon counts, parts, face tags and lint problems for recipe geometries (all, or the given IDs). */
    inspectMeshes(options = {}) {
      knownKeys(options, ['geometries'], 'mesh inspection');
      const requested = options.geometries ?? [...state.geometries.keys()];
      if (!Array.isArray(requested) || (options.geometries !== undefined && requested.length > MAX_MESH_REPORTS)) {
        throw invalidField('geometries', Array.isArray(requested) ? `${requested.length} IDs` : requested, `a list of at most ${MAX_MESH_REPORTS} geometry IDs, such as ["block"]`);
      }
      const selected = requested.slice(0, MAX_MESH_REPORTS);
      const meshes = selected.map(id => {
        identifier(id);
        const geometry = state.geometries.get(id);
        if (!geometry) {
          throw invalidField('geometries', id, `one of ${[...state.geometries.keys()].join(', ')}`);
        }
        return { geometry: id, ...agentSceneModule('mesh').meshReport(geometry) };
      });
      return { revision, meshes, truncated: requested.length > selected.length };
    },
    checkpoint() {
      if (checkpoints.size >= limits.maxCheckpoints) {
        throw invalidField('checkpoints', `${checkpoints.size} saved`, `at most ${limits.maxCheckpoints} saved checkpoints; release one with scene_release_checkpoint first`);
      }
      const handle = Object.freeze({});
      checkpoints.set(handle, snapshotState());
      return handle;
    },
    restore(handle, options = {}) {
      expected(options);
      const checkpoint = checkpoints.get(handle);
      if (!checkpoint) {
        throw invalidField('checkpointId', handle, 'a checkpointId that scene_checkpoint returned and you have not released');
      }
      return commit(stage(checkpoint.recipe, checkpoint), true);
    },
    /** Go back to an earlier revision that scene_apply or scene_restore left behind; no checkpoint is needed. */
    restoreRevision(target, options = {}) {
      expected(options);
      const entry = revisionHistory.find(candidate => candidate.revision === target);
      if (!entry) {
        const kept = revisionHistory.map(candidate => candidate.revision);
        throw invalidField('revision', target, kept.length > 0
          ? `one of the kept revisions: ${kept.join(', ')} (the last ${REVISION_HISTORY_LIMIT} are kept; older ones are dropped)`
          : 'a revision this session kept, but none is kept yet because nothing has been edited; apply an edit first');
      }
      return commit(stage(entry.snapshot.recipe, entry.snapshot), true);
    },
    releaseCheckpoint(handle) {
      if (!checkpoints.delete(handle)) {
        throw invalidField('checkpointId', handle, 'a checkpointId that scene_checkpoint returned and you have not released');
      }
    },
  });
}
