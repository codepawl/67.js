import { vertexGroupNames, vertexGroupWeights } from './mesh-data.js';
import { cornerNormals } from './mesh-normals.js';
import { cornerCycles, edgeCornerTable, UnionFind } from './mesh-topology.js';

const MAX_EAR_CLIPPING_CORNERS = 4096;

function signedArea2d(points, polygon) {
  let area = 0;
  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    area += points[current * 2] * points[next * 2 + 1] - points[next * 2] * points[current * 2 + 1];
  }
  return area / 2;
}

function cross2d(points, first, second, third) {
  return (points[second * 2] - points[first * 2]) * (points[third * 2 + 1] - points[first * 2 + 1]) -
    (points[second * 2 + 1] - points[first * 2 + 1]) * (points[third * 2] - points[first * 2]);
}

function pointInTriangle(points, point, first, second, third) {
  const firstSide = cross2d(points, first, second, point);
  const secondSide = cross2d(points, second, third, point);
  const thirdSide = cross2d(points, third, first, point);
  return firstSide >= 0 && secondSide >= 0 && thirdSide >= 0;
}

/**
 * Triangulate one polygon given as corner indices into a 2D point list (counter-clockwise).
 * O(n^2) ear clipping; falls back to a fan when no ear is found (self-intersecting input).
 */
function earClip(points, cornerCount, output) {
  const polygon = Array.from({ length: cornerCount }, (_, index) => index);
  // Clip in counter-clockwise order, then emit triangles in the face's own winding.
  const reversed = signedArea2d(points, polygon) < 0;
  if (reversed) polygon.reverse();
  const emit = (first, second, third) => {
    if (reversed) output.push(third, second, first);
    else output.push(first, second, third);
  };
  let guard = 0;
  while (polygon.length > 3 && guard < cornerCount * cornerCount) {
    guard++;
    let clipped = false;
    for (let index = 0; index < polygon.length; index++) {
      const previous = polygon[(index + polygon.length - 1) % polygon.length];
      const current = polygon[index];
      const next = polygon[(index + 1) % polygon.length];
      if (cross2d(points, previous, current, next) <= 0) continue;
      let containsOther = false;
      for (const other of polygon) {
        if (other === previous || other === current || other === next) continue;
        if (pointInTriangle(points, other, previous, current, next)) {
          containsOther = true;
          break;
        }
      }
      if (containsOther) continue;
      emit(previous, current, next);
      polygon.splice(index, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  for (let index = 1; index + 1 < polygon.length; index++) emit(polygon[0], polygon[index], polygon[index + 1]);
}

function projectFace(mesh, start, end, normal) {
  const absolute = normal.map(Math.abs);
  let dropAxis = 2;
  if (absolute[0] >= absolute[1] && absolute[0] >= absolute[2]) dropAxis = 0;
  else if (absolute[1] >= absolute[2]) dropAxis = 1;
  const firstAxis = (dropAxis + 1) % 3;
  const secondAxis = (dropAxis + 2) % 3;
  const flip = normal[dropAxis] < 0;
  const points = new Float64Array((end - start) * 2);
  for (let corner = start; corner < end; corner++) {
    const vertex = mesh.cornerVertices[corner] * 3;
    const index = corner - start;
    points[index * 2] = mesh.positions[vertex + (flip ? secondAxis : firstAxis)];
    points[index * 2 + 1] = mesh.positions[vertex + (flip ? firstAxis : secondAxis)];
  }
  return points;
}

function squaredDistance(positions, first, second) {
  const deltaX = positions[first * 3] - positions[second * 3];
  const deltaY = positions[first * 3 + 1] - positions[second * 3 + 1];
  const deltaZ = positions[first * 3 + 2] - positions[second * 3 + 2];
  return deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
}

/**
 * Triangles as corner indices (three per triangle) and the face of each triangle.
 * Quads split along the shorter diagonal; larger polygons use ear clipping in the plane of their normal.
 */
export function triangulateMesh(mesh, faceNormal) {
  let triangleCount = 0;
  for (let face = 0; face < mesh.faceCount; face++) triangleCount += mesh.faceOffsets[face + 1] - mesh.faceOffsets[face] - 2;
  const triangleCorners = new Uint32Array(triangleCount * 3);
  const triangleFaces = new Uint32Array(triangleCount);
  const vertices = mesh.cornerVertices;
  const local = [];
  let output = 0;
  const write = (face, first, second, third) => {
    triangleCorners[output * 3] = first;
    triangleCorners[output * 3 + 1] = second;
    triangleCorners[output * 3 + 2] = third;
    triangleFaces[output] = face;
    output++;
  };
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    const size = end - start;
    if (size === 3) {
      write(face, start, start + 1, start + 2);
    } else if (size === 4) {
      const firstDiagonal = squaredDistance(mesh.positions, vertices[start], vertices[start + 2]);
      const secondDiagonal = squaredDistance(mesh.positions, vertices[start + 1], vertices[start + 3]);
      if (firstDiagonal <= secondDiagonal) {
        write(face, start, start + 1, start + 2);
        write(face, start, start + 2, start + 3);
      } else {
        write(face, start, start + 1, start + 3);
        write(face, start + 1, start + 2, start + 3);
      }
    } else {
      if (size > MAX_EAR_CLIPPING_CORNERS) throw new RangeError(`Face ${face} has ${size} corners; triangulation supports ${MAX_EAR_CLIPPING_CORNERS}.`);
      const normal = [faceNormal[face * 3], faceNormal[face * 3 + 1], faceNormal[face * 3 + 2]];
      local.length = 0;
      earClip(projectFace(mesh, start, end, normal), size, local);
      for (let index = 0; index < local.length; index += 3) write(face, start + local[index], start + local[index + 1], start + local[index + 2]);
    }
  }
  return { triangleCorners, triangleFaces };
}

function equalCornerValues(attributes, first, second) {
  for (const attribute of attributes) {
    for (let component = 0; component < attribute.size; component++) {
      if (attribute.data[first * attribute.size + component] !== attribute.data[second * attribute.size + component]) return false;
    }
  }
  return true;
}

function joinRenderCorners(renderSets, groupOfCorner, splitAttributes, first, second) {
  if (groupOfCorner[first] !== groupOfCorner[second]) return;
  if (!equalCornerValues(splitAttributes, first, second)) return;
  renderSets.union(first, second);
}

// Vertex group weights per render vertex, so cloth and other bakes can read a group by name. Absent when the mesh has none.
function renderVertexGroups(mesh, renderVertexSource) {
  const names = vertexGroupNames(mesh);
  if (!names.length) return undefined;
  const groups = {};
  for (const name of names) {
    const weights = vertexGroupWeights(mesh, name);
    groups[name] = Float32Array.from(renderVertexSource, vertex => weights[vertex]);
  }
  return groups;
}

/**
 * Convert MeshData into renderer geometry: Float32 positions, normals, optional uvs and colors, Uint32 triangles.
 * Render vertices are shared between corners of one vertex unless a hard edge or a UV/colour seam separates them.
 * The returned maps let a deform-only change re-gather positions without re-running this function.
 */
export function extractRender(mesh, { sharpAngle = Infinity } = {}) {
  const { groupNormals, groupOfCorner, groupCount, groupFirstCorner, faceNormals } = cornerNormals(mesh, { sharpAngle });
  const uvAttribute = mesh.attributes.corner.uv?.size === 2 ? mesh.attributes.corner.uv : undefined;
  const colorAttribute = mesh.attributes.corner.color?.size === 3 ? mesh.attributes.corner.color : undefined;
  const normalAttribute = mesh.attributes.corner.normal?.size === 3 ? mesh.attributes.corner.normal : undefined;
  const splitAttributes = [uvAttribute, colorAttribute, normalAttribute].filter(Boolean);
  let cornerRenderVertex = groupOfCorner;
  let renderVertexCorner = groupFirstCorner;
  let renderVertexCount = groupCount;
  if (splitAttributes.length) {
    // Smooth groups that also agree on UV and colour across each shared edge become one render vertex.
    const { nextCorner } = cornerCycles(mesh);
    const table = edgeCornerTable(mesh);
    const renderSets = new UnionFind(mesh.cornerCount);
    for (let edge = 0; edge < mesh.edgeCount; edge++) {
      if (table.edgeOffsets[edge + 1] - table.edgeOffsets[edge] !== 2) continue;
      const first = table.edgeCorners[table.edgeOffsets[edge]];
      const second = table.edgeCorners[table.edgeOffsets[edge] + 1];
      if (mesh.cornerVertices[first] === mesh.cornerVertices[second]) continue;
      // Opposite winding: the corners at the shared start vertex are first and next(second), and vice versa.
      joinRenderCorners(renderSets, groupOfCorner, splitAttributes, first, nextCorner[second]);
      joinRenderCorners(renderSets, groupOfCorner, splitAttributes, nextCorner[first], second);
    }
    cornerRenderVertex = new Uint32Array(mesh.cornerCount);
    const renderVertexOfRoot = new Int32Array(mesh.cornerCount).fill(-1);
    const firstCorners = new Uint32Array(mesh.cornerCount);
    renderVertexCount = 0;
    for (let corner = 0; corner < mesh.cornerCount; corner++) {
      const root = renderSets.find(corner);
      if (renderVertexOfRoot[root] === -1) {
        renderVertexOfRoot[root] = renderVertexCount;
        firstCorners[renderVertexCount] = corner;
        renderVertexCount++;
      }
      cornerRenderVertex[corner] = renderVertexOfRoot[root];
    }
    renderVertexCorner = firstCorners.subarray(0, renderVertexCount);
  }
  const positions = new Float32Array(renderVertexCount * 3);
  const normals = new Float32Array(renderVertexCount * 3);
  const renderVertexSource = new Uint32Array(renderVertexCount);
  const uvs = uvAttribute ? new Float32Array(renderVertexCount * 2) : undefined;
  const colors = colorAttribute ? new Float32Array(renderVertexCount * 3) : undefined;
  for (let renderVertex = 0; renderVertex < renderVertexCount; renderVertex++) {
    const corner = renderVertexCorner[renderVertex];
    const vertex = mesh.cornerVertices[corner];
    const group = groupOfCorner[corner];
    renderVertexSource[renderVertex] = vertex;
    positions[renderVertex * 3] = mesh.positions[vertex * 3];
    positions[renderVertex * 3 + 1] = mesh.positions[vertex * 3 + 1];
    positions[renderVertex * 3 + 2] = mesh.positions[vertex * 3 + 2];
    const normalSource = normalAttribute ? normalAttribute.data : groupNormals;
    const normalIndex = normalAttribute ? corner : group;
    normals[renderVertex * 3] = normalSource[normalIndex * 3];
    normals[renderVertex * 3 + 1] = normalSource[normalIndex * 3 + 1];
    normals[renderVertex * 3 + 2] = normalSource[normalIndex * 3 + 2];
    if (uvs) {
      uvs[renderVertex * 2] = uvAttribute.data[corner * 2];
      uvs[renderVertex * 2 + 1] = uvAttribute.data[corner * 2 + 1];
    }
    if (colors) {
      for (let channel = 0; channel < 3; channel++) colors[renderVertex * 3 + channel] = colorAttribute.data[corner * 3 + channel];
    }
  }
  const { triangleCorners, triangleFaces } = triangulateMesh(mesh, faceNormals);
  const indices = new Uint32Array(triangleCorners.length);
  for (let index = 0; index < triangleCorners.length; index++) indices[index] = cornerRenderVertex[triangleCorners[index]];
  const geometry = { positions, normals, indices };
  if (uvs) geometry.uvs = uvs;
  if (colors) geometry.colors = colors;
  const vertexGroups = renderVertexGroups(mesh, renderVertexSource);
  if (vertexGroups) geometry.vertexGroups = vertexGroups;
  return { geometry, renderVertexSource, cornerRenderVertex, triangleFaces };
}

/** Re-gather positions after a deform-only edit, reusing the maps from extractRender. */
export function gatherRenderPositions(mesh, renderVertexSource, target = new Float32Array(renderVertexSource.length * 3)) {
  for (let renderVertex = 0; renderVertex < renderVertexSource.length; renderVertex++) {
    const vertex = renderVertexSource[renderVertex];
    target[renderVertex * 3] = mesh.positions[vertex * 3];
    target[renderVertex * 3 + 1] = mesh.positions[vertex * 3 + 1];
    target[renderVertex * 3 + 2] = mesh.positions[vertex * 3 + 2];
  }
  return target;
}
