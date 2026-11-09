import { invalidField } from './field-error.js';
import { createMeshQueryIndex } from './mesh-query.js';
import { triangulatedSurface } from './mesh-surface-distance.js';
import { selectedVertices, withPositions } from './mesh-field-edits.js';
import { MAX_SHRINKWRAP_TRIANGLE_TESTS } from './mesh-operations.js';

// The shrinkwrap mesh edit, after Blender's Shrinkwrap modifier: the vertices of the selected faces move onto a target
// surface, either to the nearest point (mode "nearest") or along a direction (mode "project"), and stand `offset` off
// it along the surface normal. The target is a closed or open primitive in the mesh's local space, placed like a
// boolean cutter. The same BVH queries as the shrinkwrap addon do the work.

function findSurface(index, origin, { mode, direction, maxDistance }, remainingTests) {
  if (mode === 'project') return index.project({ origin, direction, maxDistance, maxTriangleTests: remainingTests });
  return index.nearest(origin, { maxDistance, maxTriangleTests: remainingTests });
}

// A projected vertex stands off on the side it came from, as in Blender, so a sheet projected from outside a closed
// target stays outside and one projected from inside stays inside. A nearest-point vertex stands off along the face normal.
function standOffSide(normal, { mode, direction }) {
  if (mode !== 'project') return 1;
  return normal[0] * direction[0] + normal[1] * direction[1] + normal[2] * direction[2] > 0 ? -1 : 1;
}

/**
 * Move the selected vertices onto `target` (MeshData in the same space as `mesh`). Returns the new mesh, how many
 * vertices moved and how many found no surface (kept in place when `onMiss` is "keep", an error otherwise).
 */
export function shrinkwrapMesh(mesh, target, edit) {
  const { select, offset, onMiss } = edit;
  const flags = selectedVertices(mesh, select);
  const surface = triangulatedSurface(target);
  const index = createMeshQueryIndex({ positions: new Float32Array(surface.positions), indices: surface.indices });
  const positions = new Float32Array(mesh.positions);
  let movedVertices = 0;
  let missedVertices = 0;
  let triangleTests = 0;
  try {
    for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
      if (!flags[vertex]) continue;
      const remainingTests = MAX_SHRINKWRAP_TRIANGLE_TESTS - triangleTests;
      if (remainingTests <= 0) throw invalidField('select', 'a selection that needs too many triangle tests', 'fewer faces or a simpler target, such as a smaller select');
      const origin = Array.from(mesh.positions.subarray(vertex * 3, vertex * 3 + 3));
      const found = findSurface(index, origin, edit, remainingTests);
      triangleTests += found.triangleTests;
      if (!found.hit) {
        missedVertices++;
        if (onMiss === 'error') throw invalidField('onMiss', onMiss, `"keep", such as onMiss "keep", to leave vertices that find no surface in place (vertex ${vertex} found none); or raise maxDistance, or change the direction`);
        continue;
      }
      const side = standOffSide(found.hit.normal, edit);
      for (let axis = 0; axis < 3; axis++) positions[vertex * 3 + axis] = found.hit.point[axis] + found.hit.normal[axis] * side * offset;
      movedVertices++;
    }
  } finally {
    index.dispose();
  }
  return { mesh: withPositions(mesh, positions), movedVertices, missedVertices };
}
