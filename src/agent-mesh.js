import { meshFromGeometry } from './mesh-convert.js';
import { facesWithTag } from './mesh-data.js';
import { invalidField } from './field-error.js';
import { lintMesh } from './mesh-lint.js';
import { applyMeshEdits, evaluateMeshStack } from './mesh-recipe.js';
import { extractRender } from './mesh-render.js';
import { normalizeShapeKeys, shapeKeyTargets } from './mesh-shape-keys.js';
import { MESH_SMOOTH_ANGLE_DEFAULT } from './agent-scene-capabilities.js';

export { MESH_SMOOTH_ANGLE_DEFAULT };
export { needsMeshBooleans } from './agent-scene-modules.js';

// Compact, agent-facing mesh reports for scene geometry. Reports are cached per immutable geometry object, so
// repeated inspection of an unchanged scene costs nothing.

const reports = new WeakMap();

// Render geometry generated from a mesh recipe keeps its polygon mesh and edit results here.
const polygonMeshes = new WeakMap();

const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Least-recently-used cache of evaluated meshes keyed by their recipe prefix (base, edits, then each stack node),
 * bounded by entry count and array bytes. Unchanged prefixes are reused when only later parts change.
 */
class MeshEvaluationCache {
  constructor() {
    this.entries = new Map();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    const bytes = meshBytes(value.mesh);
    if (bytes > CACHE_MAX_BYTES) return;
    const previous = this.entries.get(key);
    if (previous) {
      this.bytes -= previous.bytes;
      this.entries.delete(key);
    }
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.entries.size > CACHE_MAX_ENTRIES || this.bytes > CACHE_MAX_BYTES) {
      const [oldestKey, oldest] = this.entries.entries().next().value;
      this.entries.delete(oldestKey);
      this.bytes -= oldest.bytes;
    }
  }
}

function meshBytes(mesh) {
  let bytes = mesh.positions.byteLength + mesh.faceOffsets.byteLength + mesh.cornerVertices.byteLength +
    mesh.edgeVertices.byteLength + mesh.cornerEdges.byteLength;
  for (const domain of Object.values(mesh.attributes)) {
    for (const attribute of Object.values(domain)) bytes += attribute.data.byteLength;
  }
  return bytes;
}

const evaluationCache = new MeshEvaluationCache();

/** Hit and miss counts of the mesh evaluation cache, for tests and diagnostics. */
export function meshCacheStats() {
  return { hits: evaluationCache.hits, misses: evaluationCache.misses, entries: evaluationCache.entries.size, bytes: evaluationCache.bytes };
}

/**
 * Build render geometry for a recipe `mesh` geometry: convert the base, run the edit log, evaluate the modifier
 * stack, and extract triangles with edges sharper than smoothAngle (degrees) kept hard, as Blender's auto smooth
 * does. `cacheKey` identifies the base; the edit result and every stack prefix are cached under it.
 */
export function generateMeshGeometry(baseGeometry, edits, {
  maxVertices, smoothAngle = MESH_SMOOTH_ANGLE_DEFAULT, resolveCutter, stack = [], cacheKey, shapeKeys = [],
}) {
  const editsKey = cacheKey === undefined ? undefined : `${cacheKey}|edits|${JSON.stringify(edits)}`;
  let edited = editsKey === undefined ? undefined : evaluationCache.get(editsKey);
  if (!edited) {
    const base = meshFromGeometry(baseGeometry());
    const outcome = applyMeshEdits(base, edits, {
      maxVertices, maxFaces: maxVertices,
      resolveCutter: resolveCutter && (cutter => meshFromGeometry(resolveCutter(cutter))),
    });
    edited = { mesh: outcome.mesh, result: outcome.results };
    if (editsKey !== undefined) evaluationCache.set(editsKey, edited);
  }
  const evaluated = evaluateMeshStack(edited.mesh, stack, { maxVertices, maxFaces: maxVertices, cache: evaluationCache, cacheKey: editsKey });
  const { geometry, renderVertexSource } = extractRender(evaluated.mesh, { sharpAngle: smoothAngle * Math.PI / 180 });
  if (geometry.positions.length / 3 > maxVertices) {
    throw invalidField('edits', geometry.positions.length / 3, `an edited mesh of at most ${maxVertices} render vertices (maxVertices); use fewer subdivisions or segments`);
  }
  const keys = normalizeShapeKeys(shapeKeys);
  if (keys.length) {
    geometry.morphTargets = shapeKeyTargets(evaluated.mesh, renderVertexSource, keys, { maxVertices, maxFaces: maxVertices, resolveCutter: resolveCutter && (cutter => meshFromGeometry(resolveCutter(cutter))) });
    geometry.morphTargetNames = keys.map(key => key.name);
    geometry.morphTargetValues = Float32Array.from(keys, key => key.value);
  }
  polygonMeshes.set(geometry, { mesh: evaluated.mesh, results: edited.result, stack: evaluated.results });
  return geometry;
}

/** Remember the polygon mesh and edit results behind geometry built outside generateMeshGeometry (imported parts). */
export function registerEditedMesh(geometry, mesh, results) {
  polygonMeshes.set(geometry, { mesh, results, stack: [] });
}

/**
 * Local-space positions of the faces that carry a mesh tag, shaped like geometry so bounds code can read them. Throws a
 * message naming the next step when the part is a plain shape, or the tag is unknown or on no faces.
 */
export function taggedFacePositions(geometry, tag) {
  const polygon = polygonMeshes.get(geometry);
  if (!polygon) {
    throw invalidField('region', tag, 'a tag on a mesh geometry; tag faces with a mesh_edit tag op, or drop region');
  }
  const { mesh } = polygon;
  const positions = [];
  for (const face of facesWithTag(mesh, tag)) {
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      const vertex = mesh.cornerVertices[corner];
      positions.push(mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]);
    }
  }
  if (positions.length === 0) {
    throw invalidField('region', tag, 'a tag that is on some faces; tag faces with a mesh_edit tag op, or use another region');
  }
  return { positions: Float32Array.from(positions) };
}

function faceSizeHistogram(mesh) {
  const histogram = { triangles: 0, quads: 0, ngons: 0 };
  for (let face = 0; face < mesh.faceCount; face++) {
    const size = mesh.faceOffsets[face + 1] - mesh.faceOffsets[face];
    if (size === 3) histogram.triangles++;
    else if (size === 4) histogram.quads++;
    else histogram.ngons++;
  }
  return histogram;
}

function roundedBounds(bounds) {
  const round = value => Math.round(value * 1e5) / 1e5;
  return { min: bounds.min.map(round), max: bounds.max.map(round) };
}

/**
 * Polygon view and lint of renderer geometry: counts, face sizes, connected parts, face tags, bounds and problems
 * with suggested fixes. The geometry is welded and joined into quads first, as meshFromGeometry does.
 */
export function meshReport(geometry) {
  let report = reports.get(geometry);
  if (report) return report;
  const polygon = polygonMeshes.get(geometry);
  const mesh = polygon?.mesh ?? meshFromGeometry(geometry);
  const lint = lintMesh(mesh, { geometry: true });
  report = Object.freeze({
    ok: lint.ok,
    counts: { ...lint.counts, triangles: geometry.indices.length / 3, renderVertices: geometry.positions.length / 3 },
    faces: faceSizeHistogram(mesh),
    parts: lint.parts,
    tags: lint.tags,
    bounds: roundedBounds(lint.bounds),
    problems: lint.problems,
    ...(lint.skippedChecks ? { skippedChecks: lint.skippedChecks } : {}),
    ...(polygon ? { edits: polygon.results, stack: polygon.stack } : {}),
  });
  reports.set(geometry, report);
  return report;
}
