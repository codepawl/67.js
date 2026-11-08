import { editMesh, meshData } from './mesh-edit.js';
import { countSelected, selectFaces } from './mesh-select.js';
import {
  extrudeFaceRegion, extrudeIndividual, insetRegion, insetIndividual, deleteFaces, flipFaces, translateFaces, mergeByDistance, tagFaces,
  FALLOFF_CURVES,
} from './mesh-ops.js';
import { meshBoolean, BOOLEAN_OPERATIONS } from './mesh-boolean.js';
import { createMeshData } from './mesh-data.js';
import { mirrorMesh, arrayMesh, solidifyMesh } from './mesh-stack.js';
import { bevelEdges } from './mesh-bevel.js';
import { loopCut } from './mesh-loopcut.js';
import { CUT_OPERATIONS, normalizeCutEdit, runCutEdit, checkCutBudget } from './mesh-cut-edits.js';
import { unwrapUv } from './mesh-uv.js';
import { runKernel, KernelDeferred } from './kernel-offload.js';
import { validateField } from './mesh-fields.js';
import { setPosition, displaceMesh, DISPLACE_DIRECTIONS } from './mesh-field-edits.js';
import { normalizeVertexColorEdit, normalizeVertexGroupEdit, setVertexColor, setVertexGroup } from './mesh-attribute-edits.js';
import { subdivideMesh, subdivisionSize, MAX_SUBDIVISION_LEVELS, MAX_CREASE_SHARPNESS } from './mesh-subdivide.js';
import { decimateMesh } from './mesh-decimate.js';
import { isModifierOperation, normalizeModifierEdit, runModifierEdit } from './mesh-modifiers.js';
import { sculptMesh, checkSculptBudget } from './mesh-sculpt.js';
import { shrinkwrapMesh } from './mesh-shrinkwrap.js';
import { triangulatedSurface } from './mesh-surface-distance.js';
import { createTriangleSurfaceIndex } from './mesh-query.js';
import './mesh-field-surfaces.js';
import './field-rotation.js';
import './mesh-hull-modifiers.js';
import { remeshMesh, remeshGridSize, MAX_REMESH_RESOLUTION } from './mesh-remesh.js';
import {
  MESH_EDIT_OPERATIONS, MAX_MESH_EDITS, STACK_OPERATIONS, MAX_STACK_NODES, SCULPT_STROKE_TYPES, MAX_SCULPT_STROKES, SHRINKWRAP_MODES,
} from './mesh-operations.js';
export { MESH_EDIT_OPERATIONS, MAX_MESH_EDITS, STACK_OPERATIONS, MAX_STACK_NODES };

// Replayable edit log for agent recipes. Each edit is plain JSON; names follow Blender's bmesh.ops where they match.

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const MAX_OFFSET = 1e6;


function editError(index, message) {
  return new TypeError(`Mesh edit ${index} (${message})`);
}

function finiteNumber(value, index, label, { minimum = -MAX_OFFSET, maximum = MAX_OFFSET, exclusiveMinimum = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (exclusiveMinimum && value === minimum)) {
    throw editError(index, `${label} must be a number ${exclusiveMinimum ? 'above' : 'from'} ${minimum}${maximum < MAX_OFFSET ? ` to ${maximum}` : ''}`);
  }
  return value;
}

function vector(value, index, label) {
  if (!Array.isArray(value) || value.length !== 3) throw editError(index, `${label} needs three numbers`);
  return value.map(component => finiteNumber(component, index, label));
}

function checkedField(expression, index, label, kind) {
  try {
    validateField(expression, { kind });
  } catch (error) {
    throw editError(index, `${label}: ${error.message}`);
  }
  return expression;
}

/** translation, rotation (XYZW quaternion) and scale that place a primitive in the mesh's local space. */
function normalizePlacement(edit, normalized, index) {
  normalized.translation = edit.translation === undefined ? [0, 0, 0] : vector(edit.translation, index, 'translation');
  normalized.scale = edit.scale === undefined ? [1, 1, 1] : vector(edit.scale, index, 'scale');
  if (normalized.scale.some(value => value <= 0)) throw editError(index, 'scale components must be positive');
  if (edit.rotation === undefined) {
    normalized.rotation = [0, 0, 0, 1];
    return;
  }
  if (!Array.isArray(edit.rotation) || edit.rotation.length !== 4) throw editError(index, 'rotation is an XYZW quaternion');
  const rotation = edit.rotation.map(component => finiteNumber(component, index, 'rotation'));
  const length = Math.hypot(...rotation);
  if (length === 0) throw editError(index, 'rotation quaternion must be nonzero');
  normalized.rotation = rotation.map(component => component / length);
}

function normalizeStroke(stroke, index, strokeIndex) {
  const label = `strokes[${strokeIndex}]`;
  if (!stroke || typeof stroke !== 'object' || Array.isArray(stroke)) throw editError(index, `${label} must be an object`);
  for (const key of Object.keys(stroke)) {
    if (!['type', 'center', 'radius', 'strength', 'direction'].includes(key)) throw editError(index, `${label} does not take ${key}; fields: type, center, radius, strength, direction`);
  }
  if (!SCULPT_STROKE_TYPES.includes(stroke.type)) throw editError(index, `${label}.type must be one of ${SCULPT_STROKE_TYPES.join(', ')}`);
  const normalized = {
    type: stroke.type,
    center: vector(stroke.center, index, `${label}.center`),
    radius: finiteNumber(stroke.radius, index, `${label}.radius`, { minimum: 0, exclusiveMinimum: true }),
    strength: finiteNumber(stroke.strength, index, `${label}.strength`),
  };
  if (stroke.type === 'smooth' && (normalized.strength < 0 || normalized.strength > 1)) throw editError(index, `${label}.strength of a smooth stroke is from 0 to 1`);
  if (stroke.type === 'displace') {
    normalized.direction = vector(stroke.direction, index, `${label}.direction`);
    if (normalized.direction.every(component => component === 0)) throw editError(index, `${label}.direction must be nonzero`);
  } else if (stroke.direction !== undefined) {
    throw editError(index, `${label}.direction applies only to a displace stroke`);
  }
  return normalized;
}

/** Validate an edit list without running it. Returns normalized copies with default names filled in. */
export function normalizeMeshEdits(edits) {
  if (!Array.isArray(edits)) throw new TypeError('edits must be an array.');
  if (edits.length > MAX_MESH_EDITS) throw new RangeError(`A mesh holds at most ${MAX_MESH_EDITS} edits. Apply fewer or start from a new base.`);
  return edits.map((edit, index) => {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw editError(index, 'each edit must be an object');
    const definition = MESH_EDIT_OPERATIONS[edit.op];
    if (!definition) throw editError(index, `op must be one of ${Object.keys(MESH_EDIT_OPERATIONS).join(', ')}`);
    for (const key of Object.keys(edit)) {
      if (key !== 'op' && !definition.fields.includes(key)) throw editError(index, `${edit.op} does not take ${key}; fields: ${definition.fields.join(', ')}`);
    }
    const normalized = { op: edit.op };
    if (definition.fields.includes('select')) {
      if (edit.select === undefined && ['delete', 'tag', 'dissolve_faces'].includes(edit.op)) throw editError(index, `${edit.op} needs select`);
      normalized.select = edit.select ?? { all: true };
    }
    if (definition.fields.includes('name')) {
      const name = edit.name ?? (['tag', 'vertex_group'].includes(edit.op) ? undefined : `${edit.op.split('_')[0]}-${index + 1}`);
      if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw editError(index, 'name must be 1 to 48 letters, digits, dots, dashes or underscores');
      normalized.name = name;
    }
    switch (edit.op) {
      case 'extrude_face_region':
      case 'extrude_individual':
        normalized.offset = finiteNumber(edit.offset, index, 'offset');
        if (edit.direction !== undefined) normalized.direction = vector(edit.direction, index, 'direction');
        if (edit.alongNormals !== undefined) {
          if (typeof edit.alongNormals !== 'boolean') throw editError(index, 'alongNormals must be boolean');
          if (edit.alongNormals && edit.direction !== undefined) throw editError(index, 'alongNormals and direction cannot be combined');
          normalized.alongNormals = edit.alongNormals;
        }
        break;
      case 'inset_region':
      case 'inset_individual':
        normalized.thickness = finiteNumber(edit.thickness, index, 'thickness', { minimum: 0, exclusiveMinimum: true });
        normalized.depth = edit.depth === undefined ? 0 : finiteNumber(edit.depth, index, 'depth');
        break;
      case 'translate':
        normalized.offset = vector(edit.offset, index, 'offset');
        if (edit.falloff !== undefined) {
          const falloff = edit.falloff;
          if (!falloff || typeof falloff !== 'object') throw editError(index, 'falloff must be { radius, curve, connected }');
          for (const key of Object.keys(falloff)) {
            if (!['radius', 'curve', 'connected'].includes(key)) throw editError(index, `falloff does not take ${key}`);
          }
          const curve = falloff.curve ?? 'smooth';
          if (!Object.hasOwn(FALLOFF_CURVES, curve)) throw editError(index, `falloff curve must be one of ${Object.keys(FALLOFF_CURVES).join(', ')}`);
          if (falloff.connected !== undefined && typeof falloff.connected !== 'boolean') throw editError(index, 'falloff.connected must be boolean');
          normalized.falloff = {
            radius: finiteNumber(falloff.radius, index, 'falloff.radius', { minimum: 0, exclusiveMinimum: true }),
            curve, connected: falloff.connected ?? false,
          };
        }
        break;
      case 'boolean': {
        if (!BOOLEAN_OPERATIONS.includes(edit.operation)) throw editError(index, `operation must be one of ${BOOLEAN_OPERATIONS.join(', ')}`);
        normalized.operation = edit.operation;
        if (!edit.cutter || typeof edit.cutter !== 'object' || Array.isArray(edit.cutter) || typeof edit.cutter.type !== 'string') {
          throw editError(index, 'cutter must be a primitive record such as { "type": "cylinder", "segments": 32 }');
        }
        normalized.cutter = edit.cutter;
        normalizePlacement(edit, normalized, index);
        break;
      }
      case 'sculpt':
        if (!Array.isArray(edit.strokes) || edit.strokes.length < 1 || edit.strokes.length > MAX_SCULPT_STROKES) {
          throw editError(index, `strokes must be an array of 1 to ${MAX_SCULPT_STROKES} brush strokes`);
        }
        normalized.strokes = edit.strokes.map((stroke, strokeIndex) => normalizeStroke(stroke, index, strokeIndex));
        break;
      case 'shrinkwrap':
        if (!edit.target || typeof edit.target !== 'object' || Array.isArray(edit.target) || typeof edit.target.type !== 'string') {
          throw editError(index, 'target must be a primitive record such as { "type": "sphere", "radius": 0.5 }');
        }
        normalized.target = edit.target;
        normalizePlacement(edit, normalized, index);
        if (!SHRINKWRAP_MODES.includes(edit.mode ?? 'nearest')) throw editError(index, `mode must be one of ${SHRINKWRAP_MODES.join(', ')}`);
        normalized.mode = edit.mode ?? 'nearest';
        if (normalized.mode === 'project') {
          normalized.direction = vector(edit.direction, index, 'direction');
          if (normalized.direction.every(component => component === 0)) throw editError(index, 'direction must be nonzero');
        } else if (edit.direction !== undefined) {
          throw editError(index, 'direction applies only to mode project');
        }
        normalized.offset = edit.offset === undefined ? 0 : finiteNumber(edit.offset, index, 'offset', { minimum: 0 });
        if (edit.maxDistance !== undefined) normalized.maxDistance = finiteNumber(edit.maxDistance, index, 'maxDistance', { minimum: 0 });
        if (!['error', 'keep'].includes(edit.onMiss ?? 'error')) throw editError(index, 'onMiss must be error or keep');
        normalized.onMiss = edit.onMiss ?? 'error';
        break;
      case 'mirror':
        if (!['x', 'y', 'z'].includes(edit.axis ?? 'x')) throw editError(index, 'axis must be x, y or z');
        normalized.axis = edit.axis ?? 'x';
        normalized.merge = edit.merge === undefined ? 0.001 : finiteNumber(edit.merge, index, 'merge', { minimum: 0, maximum: 1e3 });
        break;
      case 'array':
        if (!Number.isInteger(edit.count ?? 2) || (edit.count ?? 2) < 1 || (edit.count ?? 2) > 256) throw editError(index, 'count must be an integer from 1 to 256');
        normalized.count = edit.count ?? 2;
        normalized.offset = edit.offset === undefined ? [0, 0, 0] : vector(edit.offset, index, 'offset');
        normalized.relativeOffset = edit.relativeOffset === undefined ? (edit.offset === undefined ? [1, 0, 0] : [0, 0, 0]) : vector(edit.relativeOffset, index, 'relativeOffset');
        normalized.merge = edit.merge === undefined ? 0 : finiteNumber(edit.merge, index, 'merge', { minimum: 0, maximum: 1e3 });
        break;
      case 'solidify':
        normalized.thickness = finiteNumber(edit.thickness, index, 'thickness', { minimum: 0, exclusiveMinimum: true });
        normalized.offset = edit.offset === undefined ? -1 : finiteNumber(edit.offset, index, 'offset', { minimum: -1, maximum: 1 });
        if (edit.evenThickness !== undefined && typeof edit.evenThickness !== 'boolean') throw editError(index, 'evenThickness must be boolean');
        normalized.evenThickness = edit.evenThickness ?? true;
        break;
      case 'bevel':
        if (edit.edges !== undefined && (!edit.edges || typeof edit.edges !== 'object' || Array.isArray(edit.edges))) {
          throw editError(index, 'edges must be a rule: { "between": [faceRule, faceRule] }, { "angle": degrees }, { "boundaryOf": faceRule } or { "all": true }');
        }
        normalized.edges = edit.edges ?? { angle: 30 };
        normalized.width = finiteNumber(edit.width, index, 'width', { minimum: 0, exclusiveMinimum: true });
        if (!Number.isInteger(edit.segments ?? 1) || (edit.segments ?? 1) < 1 || (edit.segments ?? 1) > 16) throw editError(index, 'segments must be an integer from 1 to 16');
        normalized.segments = edit.segments ?? 1;
        normalized.profile = edit.profile === undefined ? 0.5 : finiteNumber(edit.profile, index, 'profile', { minimum: 0, maximum: 1 });
        if (edit.clampOverlap !== undefined && typeof edit.clampOverlap !== 'boolean') throw editError(index, 'clampOverlap must be boolean');
        normalized.clampOverlap = edit.clampOverlap ?? true;
        break;
      case 'loop_cut':
        if (!edit.edges || typeof edit.edges !== 'object' || Array.isArray(edit.edges)) {
          throw editError(index, 'edges must be a rule that picks the ring, for example { "along": [0, 1, 0] } for the vertical edges');
        }
        normalized.edges = edit.edges;
        if (!Number.isInteger(edit.cuts ?? 1) || (edit.cuts ?? 1) < 1 || (edit.cuts ?? 1) > 16) throw editError(index, 'cuts must be an integer from 1 to 16');
        normalized.cuts = edit.cuts ?? 1;
        if (edit.factor !== undefined && normalized.cuts !== 1) throw editError(index, 'factor applies only to a single cut');
        normalized.factor = edit.factor === undefined ? 0.5 : finiteNumber(edit.factor, index, 'factor', { minimum: 0, maximum: 1 });
        if (normalized.factor === 0 || normalized.factor === 1) throw editError(index, 'factor must be strictly between 0 and 1');
        break;
      case 'uv_unwrap':
        if (edit.seams !== undefined && (!edit.seams || typeof edit.seams !== 'object' || Array.isArray(edit.seams))) {
          throw editError(index, 'seams must be an edge rule, for example { "angle": 60 } or { "boundaryOf": { "tag": "lid.cap" } }');
        }
        normalized.seams = edit.seams ?? { angle: 60 };
        normalized.margin = edit.margin === undefined ? 0.01 : finiteNumber(edit.margin, index, 'margin', { minimum: 0, maximum: 0.2 });
        normalized.maxDistortion = edit.maxDistortion === undefined ? 0.25 : finiteNumber(edit.maxDistortion, index, 'maxDistortion', { minimum: 0, maximum: 100 });
        break;
      case 'subdivide':
        if (!Number.isInteger(edit.levels ?? 1) || (edit.levels ?? 1) < 1 || (edit.levels ?? 1) > MAX_SUBDIVISION_LEVELS) {
          throw editError(index, `levels must be an integer from 1 to ${MAX_SUBDIVISION_LEVELS}`);
        }
        normalized.levels = edit.levels ?? 1;
        if (edit.crease !== undefined) {
          if (!edit.crease || typeof edit.crease !== 'object' || Array.isArray(edit.crease)) {
            throw editError(index, 'crease must be an edge rule, for example { "angle": 60 } or { "between": [faceRule, faceRule] }');
          }
          normalized.crease = edit.crease;
          normalized.sharpness = edit.sharpness === undefined
            ? MAX_CREASE_SHARPNESS
            : finiteNumber(edit.sharpness, index, 'sharpness', { minimum: 0, maximum: MAX_CREASE_SHARPNESS, exclusiveMinimum: true });
        } else if (edit.sharpness !== undefined) {
          throw editError(index, 'sharpness needs a crease rule');
        }
        break;
      case 'set_position':
        if (edit.position === undefined && edit.offset === undefined) throw editError(index, 'set_position needs a position or an offset expression');
        if (edit.position !== undefined) normalized.position = checkedField(edit.position, index, 'position', 'vector');
        if (edit.offset !== undefined) normalized.offset = checkedField(edit.offset, index, 'offset', 'vector');
        break;
      case 'displace':
        normalized.field = checkedField(edit.field, index, 'field', 'scalar');
        normalized.strength = edit.strength === undefined ? 1 : finiteNumber(edit.strength, index, 'strength');
        normalized.midlevel = edit.midlevel === undefined ? 0.5 : finiteNumber(edit.midlevel, index, 'midlevel');
        if (edit.direction !== undefined && !DISPLACE_DIRECTIONS.includes(edit.direction)) throw editError(index, `direction must be one of ${DISPLACE_DIRECTIONS.join(', ')}`);
        normalized.direction = edit.direction ?? 'normal';
        if (edit.group !== undefined) {
          if (typeof edit.group !== 'string' || !NAME_PATTERN.test(edit.group)) throw editError(index, 'group must be the name of a vertex group');
          normalized.group = edit.group;
        }
        break;
      case 'vertex_group':
        normalizeVertexGroupEdit(edit, normalized, index, { finiteNumber, checkedField });
        break;
      case 'vertex_color':
        normalizeVertexColorEdit(edit, normalized, index, { finiteNumber, checkedField });
        break;
      case 'decimate':
        normalized.ratio = finiteNumber(edit.ratio, index, 'ratio', { minimum: 0, maximum: 1, exclusiveMinimum: true });
        break;
      case 'remesh':
        if ((edit.voxelSize === undefined) === (edit.resolution === undefined)) throw editError(index, 'remesh needs exactly one of voxelSize or resolution');
        if (edit.voxelSize !== undefined) normalized.voxelSize = finiteNumber(edit.voxelSize, index, 'voxelSize', { minimum: 0, exclusiveMinimum: true });
        if (edit.resolution !== undefined) {
          if (!Number.isInteger(edit.resolution) || edit.resolution < 4 || edit.resolution > MAX_REMESH_RESOLUTION) {
            throw editError(index, `resolution must be an integer from 4 to ${MAX_REMESH_RESOLUTION}`);
          }
          normalized.resolution = edit.resolution;
        }
        break;
      case 'merge_by_distance':
        normalized.distance =finiteNumber(edit.distance ?? 1e-4, index, 'distance', { minimum: 0, maximum: 1e3 });
        break;
    }
    if (CUT_OPERATIONS.includes(edit.op)) normalizeCutEdit(edit, normalized, index, { finiteNumber, vector });
    if (isModifierOperation(edit.op)) normalizeModifierEdit(edit, normalized, index, { finiteNumber, checkedField });
    return normalized;
  });
}

// An array multiplies a mesh in one step, so its size must be known before it allocates.
function checkSubdivideBudget(mesh, edit, limits, index) {
  const size = subdivisionSize(mesh, edit.levels);
  if (size.vertices > limits.maxVertices || size.faces > limits.maxFaces) {
    throw new RangeError(`Mesh edit ${index} (subdivide) would make ${size.vertices} vertices and ${size.faces} faces, over the limit of ${limits.maxVertices} vertices and ${limits.maxFaces} faces. Lower levels, or use a simpler mesh.`);
  }
}

function checkArrayBudget(mesh, edit, limits, index) {
  checkCutBudget(mesh, edit, limits, index);
  if (edit.op === 'sculpt') {
    try {
      checkSculptBudget(mesh, edit.strokes.length);
    } catch (error) {
      throw new error.constructor(`Mesh edit ${index} (sculpt): ${error.message}`);
    }
    return;
  }
  if (edit.op === 'subdivide') {
    checkSubdivideBudget(mesh, edit, limits, index);
    return;
  }
  if (edit.op === 'remesh') {
    try {
      remeshGridSize(mesh, edit);
    } catch (error) {
      throw new error.constructor(`Mesh edit ${index} (remesh): ${error.message}`);
    }
    return;
  }
  if (edit.op !== 'array') return;
  const vertices = mesh.vertexCount * edit.count;
  const faces = mesh.faceCount * edit.count;
  if (vertices > limits.maxVertices || faces > limits.maxFaces) {
    throw new RangeError(`Mesh edit ${index} (array) would make ${vertices} vertices and ${faces} faces, over the limit of ${limits.maxVertices} vertices and ${limits.maxFaces} faces. Lower count, or use a simpler mesh.`);
  }
}

function checkBudget(mesh, limits, index, op) {
  if (mesh.vertexCount > limits.maxVertices || mesh.faceCount > limits.maxFaces) {
    throw new RangeError(`Mesh edit ${index} (${op}) grows the mesh to ${mesh.vertexCount} vertices and ${mesh.faceCount} faces, over the limit of ${limits.maxVertices} vertices or ${limits.maxFaces} faces.`);
  }
}

/** Copy of a mesh with positions scaled, rotated by a unit XYZW quaternion, then translated. */
export function transformMesh(mesh, { translation, rotation, scale }) {
  const [x, y, z, w] = rotation;
  const positions = new Float32Array(mesh.positions.length);
  for (let offset = 0; offset < positions.length; offset += 3) {
    const pointX = mesh.positions[offset] * scale[0];
    const pointY = mesh.positions[offset + 1] * scale[1];
    const pointZ = mesh.positions[offset + 2] * scale[2];
    // v' = v + 2w(q x v) + 2q x (q x v)
    const crossX = y * pointZ - z * pointY;
    const crossY = z * pointX - x * pointZ;
    const crossZ = x * pointY - y * pointX;
    positions[offset] = pointX + 2 * (w * crossX + y * crossZ - z * crossY) + translation[0];
    positions[offset + 1] = pointY + 2 * (w * crossY + z * crossX - x * crossZ) + translation[1];
    positions[offset + 2] = pointZ + 2 * (w * crossZ + x * crossY - y * crossX) + translation[2];
  }
  return createMeshData({
    positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges, attributes: mesh.attributes,
  });
}

function runShrinkwrap(current, edit, resolveCutter) {
  if (!resolveCutter) throw new TypeError('shrinkwrap needs a target resolver; recipe meshes provide one.');
  return shrinkwrapMesh(current, transformMesh(resolveCutter(edit.target), edit), edit);
}

/** Run one normalized edit on MeshData and describe what it did. */
// Field inputs that read another surface take a geometry record here, built by the same resolver as a boolean cutter.
function surfaceLoader(resolveCutter) {
  return surface => {
    if (!resolveCutter || typeof surface === 'string') throw new TypeError('A mesh edit field reads a surface given as a geometry record such as { "type": "terrain", ... }, not an id.');
    return createTriangleSurfaceIndex(triangulatedSurface(resolveCutter(surface)));
  };
}

function runEdit(current, edit, index, { resolveCutter, limits }) {
  const loadSurface = surfaceLoader(resolveCutter);
  const result = { op: edit.op };
  if (edit.name) result.name = edit.name;
  if (isModifierOperation(edit.op)) {
    let outcome;
    try {
      outcome = runModifierEdit(current, edit, limits);
    } catch (error) {
      throw new error.constructor(`Mesh edit ${index} (${edit.op}): ${error.message}`);
    }
    Object.assign(result, outcome.result);
    return { mesh: outcome.mesh, result };
  }
  if (edit.op === 'boolean') {
    if (!resolveCutter) throw new TypeError(`Mesh edit ${index} (boolean) needs a cutter resolver; recipe meshes provide one.`);
    let cutter;
    try {
      cutter = transformMesh(resolveCutter(edit.cutter), edit);
    } catch (error) {
      throw new error.constructor(`Mesh edit ${index} (boolean cutter): ${error.message}`);
    }
    const cutTag = `${edit.name}.cut`;
    let outcome;
    try {
      outcome = meshBoolean(current, cutter, edit.operation, { cutTag });
    } catch (error) {
      throw new error.constructor(`Mesh edit ${index} (boolean ${edit.operation}): ${error.message}`);
    }
    result.operation = edit.operation;
    result.tags = { [cutTag]: outcome.cutterFaces };
    return { mesh: outcome.mesh, result };
  }
  if (edit.op === 'merge_by_distance') {
    const merged = mergeByDistance(current, edit.distance);
    result.removedVertices = merged.removedVertices;
    result.removedFaces = merged.removedFaces;
    return { mesh: merged.mesh, result };
  }
  if (edit.op === 'loop_cut') {
    let outcome;
    try {
      outcome = loopCut(current, edit.edges, edit);
    } catch (error) {
      throw new error.constructor(`Mesh edit ${index} (loop_cut): ${error.message}`);
    }
    result.rings = outcome.rings;
    result.closedRings = outcome.closedRings;
    result.splitEdges = outcome.splitEdges;
    result.tags = tagSummary(outcome.mesh, edit.name);
    return { mesh: outcome.mesh, result };
  }
  if (edit.op === 'bevel') {
    let outcome;
    try {
      outcome = bevelEdges(current, edit.edges, edit);
    } catch (error) {
      throw new error.constructor(`Mesh edit ${index} (bevel): ${error.message}`);
    }
    result.edges = outcome.bevelEdges;
    result.width = outcome.width;
    if (outcome.clamped) result.clamped = true;
    result.tags = tagSummary(outcome.mesh, edit.name);
    return { mesh: outcome.mesh, result };
  }
  if (CUT_OPERATIONS.includes(edit.op)) {
    let outcome;
    try {
      outcome = runCutEdit(current, edit);
    } catch (error) {
      throw new error.constructor(`Mesh edit ${index} (${edit.op}): ${error.message}`);
    }
    Object.assign(result, outcome.result);
    const tags = tagSummary(outcome.mesh, edit.name);
    if (Object.keys(tags).length) result.tags = tags;
    return { mesh: outcome.mesh, result };
  }
  if (edit.op === 'set_position' || edit.op === 'displace') {
    let outcome;
    try {
      outcome = edit.op === 'set_position' ? setPosition(current, edit, loadSurface) : displaceMesh(current, edit, loadSurface);
    } catch (error) {
      throw new error.constructor(`Mesh edit ${index} (${edit.op}): ${error.message}`);
    }
    result.movedVertices = outcome.movedVertices;
    return { mesh: outcome.mesh, result };
  }
  if (edit.op === 'vertex_group' || edit.op === 'vertex_color') {
    let outcome;
    try {
      outcome = edit.op === 'vertex_group' ? setVertexGroup(current, edit, loadSurface) : setVertexColor(current, edit, loadSurface);
    } catch (error) {
      throw new error.constructor(`Mesh edit ${index} (${edit.op}): ${error.message}`);
    }
    if (edit.op === 'vertex_group') {
      result.group = edit.name;
      result.assignedVertices = outcome.assignedVertices;
    } else {
      result.assignedCorners = outcome.assignedCorners;
    }
    return { mesh: outcome.mesh, result };
  }
  if (edit.op === 'sculpt' || edit.op === 'shrinkwrap') {
    let outcome;
    try {
      outcome = edit.op === 'sculpt' ? sculptMesh(current, edit) : runShrinkwrap(current, edit, resolveCutter);
    } catch (error) {
      throw new error.constructor(`Mesh edit ${index} (${edit.op}): ${error.message}`);
    }
    result.movedVertices = outcome.movedVertices;
    if (outcome.missedVertices) result.missedVertices = outcome.missedVertices;
    return { mesh: outcome.mesh, result };
  }
  if (edit.op === 'subdivide') {
    let subdivided;
    try {
      subdivided = subdivideMesh(current, { levels: edit.levels, crease: edit.crease, sharpness: edit.sharpness });
    } catch (error) {
      throw new error.constructor(`Mesh edit ${index} (subdivide): ${error.message}`);
    }
    result.levels = edit.levels;
    return { mesh: subdivided, result };
  }
  if (edit.op === 'decimate') {
    let outcome;
    try {
      outcome = decimateMesh(current, edit);
    } catch (error) {
      throw new error.constructor(`Mesh edit ${index} (decimate): ${error.message}`);
    }
    result.triangles = outcome.triangles;
    if (!outcome.reachedTarget) result.stoppedEarly = true;
    return { mesh: outcome.mesh, result };
  }
  if (edit.op === 'remesh') {
    let outcome;
    try {
      outcome = remeshMesh(current, edit);
    } catch (error) {
      throw new error.constructor(`Mesh edit ${index} (remesh): ${error.message}`);
    }
    result.voxelSize = Number(outcome.voxelSize.toPrecision(5));
    return { mesh: outcome.mesh, result };
  }
  if (edit.op === 'uv_unwrap') {
    let outcome;
    try {
      const unwrapped = runKernel('uvUnwrap', [current, edit], unwrapUv);
      outcome = { ...unwrapped, mesh: createMeshData(unwrapped.mesh) };
    } catch (error) {
      if (error instanceof KernelDeferred) {
        throw error;
      }
      throw new error.constructor(`Mesh edit ${index} (uv_unwrap): ${error.message}`);
    }
    result.islands = outcome.islands;
    result.seamEdges = outcome.seamEdges;
    result.cutEdges = outcome.cutEdges;
    result.chartEdges = outcome.chartEdges;
    result.flipped = outcome.flipped;
    result.areaDistortion = Number(outcome.areaDistortion.toFixed(4));
    result.utilization = Number(outcome.utilization.toFixed(4));
    return { mesh: outcome.mesh, result };
  }
  if (Object.hasOwn(GENERATORS, edit.op)) {
    const generated = GENERATORS[edit.op](current, edit);
    result.tags = tagSummary(generated, edit.name);
    return { mesh: generated, result };
  }
  let mask;
  try {
    mask = selectFaces(current, edit.select);
  } catch (error) {
    throw new error.constructor(`Mesh edit ${index} (${edit.op}): ${error.message}`);
  }
  const selected = countSelected(mask);
  if (selected === 0) throw new RangeError(`Mesh edit ${index} (${edit.op}) selects no faces. Check the rule with mesh_inspect tags and counts.`);
  result.selected = selected;
  const editable = editMesh(current);
  let created = null;
  switch (edit.op) {
    case 'extrude_face_region':
      created = extrudeFaceRegion(editable, mask, edit);
      break;
    case 'extrude_individual':
      created = extrudeIndividual(editable, mask, edit);
      break;
    case 'inset_region':
    case 'inset_individual': {
      const inset = edit.op === 'inset_region' ? insetRegion(editable, mask, edit) : insetIndividual(editable, mask, edit);
      created = { capFaces: inset.capFaces, sideFaces: inset.sideFaces, sideTag: 'rim' };
      break;
    }
    case 'delete':
      result.deletedFaces = deleteFaces(editable, mask).deletedFaces;
      break;
    case 'flip_normals':
      flipFaces(editable, mask);
      break;
    case 'translate':
      result.movedVertices = translateFaces(editable, mask, edit).movedVertices;
      break;
    case 'tag':
      tagFaces(editable, Array.from(mask.keys()).filter(face => mask[face]), edit.name);
      result.tags = { [edit.name]: selected };
      break;
  }
  if (created) {
    const sideTag = `${edit.name}.${created.sideTag ?? 'side'}`;
    tagFaces(editable, created.capFaces, `${edit.name}.cap`);
    tagFaces(editable, created.sideFaces, sideTag);
    result.tags = { [`${edit.name}.cap`]: created.capFaces.length, [sideTag]: created.sideFaces.length };
  }
  return { mesh: meshData(editable), result };
}

const GENERATORS = Object.freeze({
  mirror: (mesh, edit) => mirrorMesh(mesh, edit),
  array: (mesh, edit) => arrayMesh(mesh, edit),
  solidify: (mesh, edit) => solidifyMesh(mesh, edit),
});

/** Face counts of the tags an edit named `name` created (tags starting with "<name>."). */
function tagSummary(mesh, name) {
  const summary = {};
  for (const [attributeName, attribute] of Object.entries(mesh.attributes.face)) {
    if (!attributeName.startsWith(`tag:${name}.`)) continue;
    let count = 0;
    for (let face = 0; face < mesh.faceCount; face++) count += attribute.data[face] ? 1 : 0;
    summary[attributeName.slice(4)] = count;
  }
  return summary;
}

/**
 * Run an edit log on MeshData. Returns the final mesh and one compact result per edit: how many faces it selected,
 * the tags it created (and their face counts) and the mesh size after it.
 * An edit that selects no faces throws, because silently doing nothing hides a wrong selection from the agent.
 */
export function applyMeshEdits(mesh, edits, { maxVertices = 250_000, maxFaces = 250_000, resolveCutter } = {}) {
  const normalized = normalizeMeshEdits(edits);
  const limits = { maxVertices, maxFaces };
  const results = [];
  let current = mesh;
  normalized.forEach((edit, index) => {
    checkArrayBudget(current, edit, limits, index);
    const outcome = runEdit(current, edit, index, { resolveCutter, limits });
    current = outcome.mesh;
    checkBudget(current, limits, index, edit.op);
    outcome.result.after = { vertices: current.vertexCount, faces: current.faceCount };
    results.push(outcome.result);
  });
  return { mesh: current, results };
}


/** Validate a modifier stack: nodes restricted to STACK_OPERATIONS, at most 16. */
export function normalizeMeshStack(stack) {
  if (!Array.isArray(stack)) throw new TypeError('stack must be an array.');
  if (stack.length > MAX_STACK_NODES) throw new RangeError(`A stack holds at most ${MAX_STACK_NODES} nodes.`);
  for (const [index, node] of stack.entries()) {
    if (!STACK_OPERATIONS.includes(node?.op)) throw new TypeError(`Stack node ${index} op must be one of ${STACK_OPERATIONS.join(', ')}.`);
  }
  // Stack nodes default their names from their own position, separately from the edit log.
  return normalizeMeshEdits(stack.map((node, index) => {
    if (!MESH_EDIT_OPERATIONS[node.op].fields.includes('name')) return node;
    return { ...node, name: node.name ?? `${node.op}-s${index + 1}` };
  }));
}

/**
 * Evaluate a modifier stack after the edits, non-destructively, as Blender's modifier stack does. With a cache
 * ({ get(key), set(key, value) }) and a key for the input, every prefix of the stack is cached, so changing a late
 * node reuses the earlier ones. Returns the mesh and one result per node, marked `cached` when reused.
 */
export function evaluateMeshStack(mesh, stack, { maxVertices = 250_000, maxFaces = 250_000, cache, cacheKey } = {}) {
  const normalized = normalizeMeshStack(stack);
  const limits = { maxVertices, maxFaces };
  const results = [];
  let current = mesh;
  let key = cacheKey;
  normalized.forEach((node, index) => {
    key = key === undefined ? undefined : `${key}|${JSON.stringify(node)}`;
    const hit = key === undefined ? undefined : cache?.get(key);
    let result;
    if (hit) {
      current = hit.mesh;
      result = { ...hit.result, cached: true };
    } else {
      checkArrayBudget(current, node, limits, index);
      const outcome = runEdit(current, node, index, { limits });
      current = outcome.mesh;
      checkBudget(current, limits, index, node.op);
      outcome.result.after = { vertices: current.vertexCount, faces: current.faceCount };
      result = outcome.result;
      if (key !== undefined) cache?.set(key, { mesh: current, result });
    }
    results.push(result);
  });
  return { mesh: current, results };
}
