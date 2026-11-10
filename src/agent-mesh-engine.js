// Everything the agent scene needs for mesh geometry, behind one on-demand import (see agent-scene-modules.js).
export { meshReport, generateMeshGeometry, taggedFacePositions, waterFoamGeometry } from './agent-mesh.js';
export { normalizeMeshEdits, normalizeMeshStack } from './mesh-recipe.js';
export { normalizeShapeKeys } from './mesh-shape-keys.js';
export { generateMeshLods, generateGeometryLods, generateAssetLods } from './mesh-lod.js';
export { expandInstancedNodes } from './mesh-instances.js';
export { loadMeshBooleans, meshBooleansLoaded, setManifoldModuleLoader } from './mesh-boolean.js';
export { editImportedGeometry } from './mesh-import.js';
export { meshReport as importedMeshReport, registerEditedMesh } from './agent-mesh.js';
