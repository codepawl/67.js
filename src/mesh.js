// Polygon mesh core for agent modeling: compact MeshData, half-edge EditMesh, conversion, normals, render
// extraction and lint. See docs/mesh.md.
export {
  createMeshData, deriveEdges, meshTags, facesWithTag, tagCounts, meshBounds,
  DOMAINS, TAG_PREFIX, MAX_MESH_VERTICES, MAX_MESH_CORNERS,
} from './mesh-data.js';
export { EditMesh, editMesh, meshData } from './mesh-edit.js';
export { validateTopology } from './mesh-validate.js';
export { faceNormals, cornerNormals } from './mesh-normals.js';
export { triangulateMesh, extractRender, gatherRenderPositions } from './mesh-render.js';
export { meshFromGeometry, joinTriangles, tagFacesByAxis, weldVertices, rebuildFromCorners, withFaceAttributes } from './mesh-convert.js';
export { lintMesh } from './mesh-lint.js';
export { selectFaces, countSelected } from './mesh-select.js';
export { applyMeshEdits, normalizeMeshEdits, transformMesh, MESH_EDIT_OPERATIONS, MAX_MESH_EDITS } from './mesh-recipe.js';
export { evaluateMeshStack, normalizeMeshStack, STACK_OPERATIONS, MAX_STACK_NODES } from './mesh-recipe.js';
export { mirrorMesh, arrayMesh, solidifyMesh, removeCoincidentFaces } from './mesh-stack.js';
export { bevelEdges, selectEdges } from './mesh-bevel.js';
export { meshEdgesToSplines } from './mesh-to-curve.js';
export { loopCut } from './mesh-loopcut.js';
export { unwrapUv } from './mesh-uv.js';
export { projectUv, packUvIslands } from './mesh-uv-project.js';
export { decimateMesh } from './mesh-decimate.js';
export { remeshMesh, MAX_REMESH_RESOLUTION, MAX_REMESH_CELLS } from './mesh-remesh.js';
export { generateMeshLods, generateGeometryLods, generateAssetLods, DEFAULT_LOD_RATIOS } from './mesh-lod.js';
export { surfaceDeviation, signedVolume } from './mesh-surface-distance.js';
export { loadMeshBooleans, meshBooleansLoaded, meshBoolean, BOOLEAN_OPERATIONS } from './mesh-boolean.js';
export {
  extrudeFaceRegion, extrudeIndividual, insetRegion, insetIndividual, deleteFaces, flipFaces, translateFaces,
  mergeByDistance, tagFaces, connectedRegions, FALLOFF_CURVES,
} from './mesh-ops.js';
export { cornerFaces, cornerCycles, edgeCornerTable, faceParts } from './mesh-topology.js';
export { triangulateFaces, splitSharpEdges } from './mesh-restructure.js';
export { runModifierEdit, normalizeModifierEdit, SIMPLE_DEFORM_MODES, MAX_SMOOTH_ITERATIONS } from './mesh-modifiers.js';
