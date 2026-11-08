// Particle collision surfaces: triangles in world space, tested against the straight path a particle takes in one step.
// A path (not a point) is tested, so a fast particle cannot tunnel through a thin mesh.

const PARALLEL_EPSILON = 1e-12;

/**
 * Packs the triangles of several meshes. `meshes` are { positions (world space), indices }. Each mesh keeps its own
 * bounding box so a path far from a mesh skips all of its triangles.
 */
export function createCollisionSurface(meshes) {
  const triangleCount = meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0);
  // Per triangle: first corner, then the two edges leaving it.
  const triangles = new Float64Array(triangleCount * 9);
  const groups = [];
  let written = 0;
  for (const mesh of meshes) {
    const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const first = written;
    for (let corner = 0; corner < mesh.indices.length; corner += 3) {
      const base = written * 9;
      const [a, b, c] = [0, 1, 2].map(offset => mesh.indices[corner + offset] * 3);
      for (let axis = 0; axis < 3; axis++) {
        triangles[base + axis] = mesh.positions[a + axis];
        triangles[base + 3 + axis] = mesh.positions[b + axis] - mesh.positions[a + axis];
        triangles[base + 6 + axis] = mesh.positions[c + axis] - mesh.positions[a + axis];
        for (const vertex of [a, b, c]) {
          bounds[axis] = Math.min(bounds[axis], mesh.positions[vertex + axis]);
          bounds[3 + axis] = Math.max(bounds[3 + axis], mesh.positions[vertex + axis]);
        }
      }
      written++;
    }
    groups.push({ first, end: written, bounds });
  }
  return Object.freeze({ triangles, groups, triangleCount });
}

function pathMissesBounds(bounds, from, to) {
  for (let axis = 0; axis < 3; axis++) {
    if (Math.max(from[axis], to[axis]) < bounds[axis] || Math.min(from[axis], to[axis]) > bounds[3 + axis]) return true;
  }
  return false;
}

/**
 * Finds the earliest triangle crossed by the path `from` to `to`. When it is earlier than `contact.fraction`, writes the
 * fraction of the path and the triangle normal facing the incoming side, and returns true.
 */
export function findFirstCollision(surface, from, to, contact) {
  const directionX = to[0] - from[0];
  const directionY = to[1] - from[1];
  const directionZ = to[2] - from[2];
  let found = false;
  for (const group of surface.groups) {
    if (pathMissesBounds(group.bounds, from, to)) continue;
    for (let triangle = group.first; triangle < group.end; triangle++) {
      const base = triangle * 9;
      const edgeOneX = surface.triangles[base + 3];
      const edgeOneY = surface.triangles[base + 4];
      const edgeOneZ = surface.triangles[base + 5];
      const edgeTwoX = surface.triangles[base + 6];
      const edgeTwoY = surface.triangles[base + 7];
      const edgeTwoZ = surface.triangles[base + 8];
      const pvecX = directionY * edgeTwoZ - directionZ * edgeTwoY;
      const pvecY = directionZ * edgeTwoX - directionX * edgeTwoZ;
      const pvecZ = directionX * edgeTwoY - directionY * edgeTwoX;
      const determinant = edgeOneX * pvecX + edgeOneY * pvecY + edgeOneZ * pvecZ;
      if (Math.abs(determinant) < PARALLEL_EPSILON) continue;
      const originX = from[0] - surface.triangles[base];
      const originY = from[1] - surface.triangles[base + 1];
      const originZ = from[2] - surface.triangles[base + 2];
      const along = (originX * pvecX + originY * pvecY + originZ * pvecZ) / determinant;
      if (along < 0 || along > 1) continue;
      const qvecX = originY * edgeOneZ - originZ * edgeOneY;
      const qvecY = originZ * edgeOneX - originX * edgeOneZ;
      const qvecZ = originX * edgeOneY - originY * edgeOneX;
      const across = (directionX * qvecX + directionY * qvecY + directionZ * qvecZ) / determinant;
      if (across < 0 || along + across > 1) continue;
      const fraction = (edgeTwoX * qvecX + edgeTwoY * qvecY + edgeTwoZ * qvecZ) / determinant;
      if (fraction < 0 || fraction > 1 || fraction >= contact.fraction) continue;
      const normalX = edgeOneY * edgeTwoZ - edgeOneZ * edgeTwoY;
      const normalY = edgeOneZ * edgeTwoX - edgeOneX * edgeTwoZ;
      const normalZ = edgeOneX * edgeTwoY - edgeOneY * edgeTwoX;
      const length = Math.hypot(normalX, normalY, normalZ);
      const facing = normalX * directionX + normalY * directionY + normalZ * directionZ > 0 ? -1 : 1;
      contact.fraction = fraction;
      contact.normal[0] = facing * normalX / length;
      contact.normal[1] = facing * normalY / length;
      contact.normal[2] = facing * normalZ / length;
      contact.onFloor = false;
      found = true;
    }
  }
  return found;
}
