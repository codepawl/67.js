// Names the field of every dangling index before anything reads through it, instead of a "Cannot read properties" TypeError.

function requireIndex(value, listName, list, fieldPath) {
  if (Number.isInteger(value) && Array.isArray(list) && value >= 0 && value < list.length) return;
  const range = list?.length ? `valid: 0 to ${list.length - 1}` : `the document has no ${listName}`;
  throw new Error(`Invalid glTF ${fieldPath} ${JSON.stringify(value)}: ${range}.`);
}

function requireObject(value, fieldPath) {
  if (!value || typeof value !== 'object') throw new Error(`Invalid glTF ${fieldPath}: expected an object.`);
}

function validateMeshReferences(document) {
  (document.meshes ?? []).forEach((mesh, meshIndex) => {
    requireObject(mesh, `meshes[${meshIndex}]`);
    if (!Array.isArray(mesh.primitives)) throw new Error(`Invalid glTF meshes[${meshIndex}].primitives: expected an array.`);
    mesh.primitives.forEach((primitive, primitiveIndex) => {
      const path = `meshes[${meshIndex}].primitives[${primitiveIndex}]`;
      requireObject(primitive, path);
      if (primitive.material !== undefined) requireIndex(primitive.material, 'materials', document.materials, `${path}.material (primitive.material)`);
    });
  });
}

function validateAccessorReferences(document) {
  (document.accessors ?? []).forEach((accessor, accessorIndex) => {
    requireObject(accessor, `accessors[${accessorIndex}]`);
    if (accessor.bufferView !== undefined) requireIndex(accessor.bufferView, 'bufferViews', document.bufferViews, `accessors[${accessorIndex}].bufferView`);
  });
}

function validateSceneReferences(document) {
  const sceneIndex = document.scene ?? 0;
  const sceneNodes = document.scenes?.[sceneIndex]?.nodes;
  if (sceneNodes !== undefined && !Array.isArray(sceneNodes)) throw new Error(`Invalid glTF scenes[${sceneIndex}].nodes: expected an array.`);
  (sceneNodes ?? []).forEach((nodeIndex, position) => {
    requireIndex(nodeIndex, 'nodes', document.nodes, `scenes[${sceneIndex}].nodes[${position}]`);
  });
}

function validateNodeObjects(document) {
  (document.nodes ?? []).forEach((node, nodeIndex) => requireObject(node, `nodes[${nodeIndex}]`));
}

/** Throws an error naming the field for each dangling reference the loader would otherwise trip over. */
export function validateDocumentReferences(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('glTF JSON must be an object. Fix: pass a glTF 2.0 document.');
  validateMeshReferences(document);
  validateAccessorReferences(document);
  validateNodeObjects(document);
  validateSceneReferences(document);
}
