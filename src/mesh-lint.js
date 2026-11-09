import { meshBounds, tagCounts } from './mesh-data.js';
import { lintMeshGeometry } from './mesh-lint-geometry.js';
import { faceNormals } from './mesh-normals.js';
import { cornerFaces, edgeCornerTable, faceParts } from './mesh-topology.js';

const SAMPLE_LIMIT = 8;

// Every problem names the operation that usually fixes it, so an agent can act without another lookup.
const PROBLEMS = Object.freeze({
  'non-manifold-edge': { severity: 'error', fix: 'Delete the extra faces or split the edge; booleans and solidify need two faces per edge.' },
  'inconsistent-winding': { severity: 'error', fix: 'Run recalc_normals on the part so neighbouring faces wind the same way.' },
  'inverted-part': { severity: 'error', fix: 'Run flip_normals on the part; its normals point inward.' },
  'degenerate-face': { severity: 'error', fix: 'Run merge_by_distance or dissolve the zero-area faces.' },
  'loose-vertex': { severity: 'warning', fix: 'Delete loose vertices; they do not render and confuse bounds.' },
  'boundary-edge': { severity: 'warning', fix: 'Open surface. Run fill_holes to cap each boundary loop, or add solidify if the part must be closed.' },
});

// Spatial checks, opt in through lintMesh(mesh, { geometry: true }) because each builds a BVH. All are warnings: a mesh
// can cross itself, be thin or float on purpose, so none of them turns ok off.
export const GEOMETRY_PROBLEMS = Object.freeze({
  'intersecting-parts': { severity: 'warning', fix: 'Two parts cross each other (sample holds first * 1000 + second part index). Move them apart, or run a union boolean if they should be one solid.' },
  'self-intersection': { severity: 'warning', fix: 'A closed part cuts through itself. Undo the last extrude, inset or translate that folded it, or lower its offset.' },
  'thin-wall': { severity: 'warning', fix: 'The wall behind these faces (sample is face indices) is under 0.5% of the mesh size thick. Thicken it with solidify, or move the faces apart.' },
  'floating-part': { severity: 'warning', fix: 'This part (sample is part indices) touches no other part. Translate it onto its neighbour, or ignore this if it is meant to stand alone.' },
  asymmetric: { severity: 'warning', fix: 'The mesh is mirror-symmetric except for the vertices in sample. Rebuild one half and mirror it, or set_position those vertices to their partners.' },
  'non-planar-quad': { severity: 'warning', fix: 'These quads (sample is face indices) fold by more than 45 degrees across their diagonal and pinch shading. Triangulate them, or flatten their corners.' },
  'skewed-quad': { severity: 'warning', fix: 'These quads (sample is face indices) have a corner over 60 degrees from a right angle. Dissolve or slide edges so corners stay near 90 degrees.' },
});

const NON_PLANAR_QUAD_DEGREES = 45;
const SKEWED_QUAD_DEGREES = 60;

function roundMetric(value) {
  return Math.round(value * 1e4) / 1e4;
}

/**
 * Interior vertex valence and quad shape quality (corner angle deviation from 90 degrees, aspect ratio and diagonal fold).
 * Boundary vertices are excluded from pole counts because an open rim naturally has degree 2 or 3.
 */
export function meshTopologyMetrics(mesh, table = edgeCornerTable(mesh), problems = null) {
  const degree = new Uint32Array(mesh.vertexCount);
  const boundaryVertex = new Uint8Array(mesh.vertexCount);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const first = mesh.edgeVertices[edge * 2];
    const second = mesh.edgeVertices[edge * 2 + 1];
    degree[first]++;
    degree[second]++;
    if (table.edgeOffsets[edge + 1] - table.edgeOffsets[edge] !== 2) {
      boundaryVertex[first] = 1;
      boundaryVertex[second] = 1;
    }
  }
  let regular = 0;
  let valence3 = 0;
  let valence5 = 0;
  let valence6Plus = 0;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (degree[vertex] === 0 || boundaryVertex[vertex]) continue;
    if (degree[vertex] === 4) regular++;
    else if (degree[vertex] === 3) valence3++;
    else if (degree[vertex] === 5) valence5++;
    else if (degree[vertex] >= 6) valence6Plus++;
  }
  const positions = mesh.positions;
  let quadCount = 0;
  let meanAngleDeviation = 0;
  let maxAngleDeviation = 0;
  let maxAspectRatio = 1;
  let maxWarpAngle = 0;
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    if (mesh.faceOffsets[face + 1] - start !== 4) continue;
    quadCount++;
    const v0 = mesh.cornerVertices[start] * 3;
    const v1 = mesh.cornerVertices[start + 1] * 3;
    const v2 = mesh.cornerVertices[start + 2] * 3;
    const v3 = mesh.cornerVertices[start + 3] * 3;
    const corners = [v0, v1, v2, v3];
    let shortestEdge = Infinity;
    let longestEdge = 0;
    let faceMaxDeviation = 0;
    let faceDeviationSum = 0;
    for (let index = 0; index < 4; index++) {
      const current = corners[index];
      const next = corners[(index + 1) & 3];
      const previous = corners[(index + 3) & 3];
      const nextX = positions[next] - positions[current];
      const nextY = positions[next + 1] - positions[current + 1];
      const nextZ = positions[next + 2] - positions[current + 2];
      const prevX = positions[previous] - positions[current];
      const prevY = positions[previous + 1] - positions[current + 1];
      const prevZ = positions[previous + 2] - positions[current + 2];
      const edgeLength = Math.hypot(nextX, nextY, nextZ);
      if (edgeLength < shortestEdge) shortestEdge = edgeLength;
      if (edgeLength > longestEdge) longestEdge = edgeLength;
      const crossLength = Math.hypot(nextY * prevZ - nextZ * prevY, nextZ * prevX - nextX * prevZ, nextX * prevY - nextY * prevX);
      const angle = Math.atan2(crossLength, nextX * prevX + nextY * prevY + nextZ * prevZ) * 180 / Math.PI;
      const deviation = Math.abs(angle - 90);
      faceDeviationSum += deviation;
      if (deviation > faceMaxDeviation) faceMaxDeviation = deviation;
    }
    meanAngleDeviation += faceDeviationSum / 4;
    if (faceMaxDeviation > maxAngleDeviation) maxAngleDeviation = faceMaxDeviation;
    if (shortestEdge > 1e-12) {
      const aspect = longestEdge / shortestEdge;
      if (aspect > maxAspectRatio) maxAspectRatio = aspect;
    }
    const diagX = positions[v2] - positions[v0];
    const diagY = positions[v2 + 1] - positions[v0 + 1];
    const diagZ = positions[v2 + 2] - positions[v0 + 2];
    const e01x = positions[v1] - positions[v0];
    const e01y = positions[v1 + 1] - positions[v0 + 1];
    const e01z = positions[v1 + 2] - positions[v0 + 2];
    const e03x = positions[v3] - positions[v0];
    const e03y = positions[v3 + 1] - positions[v0 + 1];
    const e03z = positions[v3 + 2] - positions[v0 + 2];
    const n1x = e01y * diagZ - e01z * diagY;
    const n1y = e01z * diagX - e01x * diagZ;
    const n1z = e01x * diagY - e01y * diagX;
    const n2x = diagY * e03z - diagZ * e03y;
    const n2y = diagZ * e03x - diagX * e03z;
    const n2z = diagX * e03y - diagY * e03x;
    const len1 = Math.hypot(n1x, n1y, n1z);
    const len2 = Math.hypot(n2x, n2y, n2z);
    let warpAngle = 0;
    if (len1 > 1e-12 && len2 > 1e-12) {
      const cosine = Math.max(-1, Math.min(1, (n1x * n2x + n1y * n2y + n1z * n2z) / (len1 * len2)));
      warpAngle = Math.acos(cosine) * 180 / Math.PI;
      if (warpAngle > maxWarpAngle) maxWarpAngle = warpAngle;
    }
    if (problems) {
      if (warpAngle > NON_PLANAR_QUAD_DEGREES) addQualityProblem(problems, 'non-planar-quad', face);
      const touchesHighPole = [v0, v1, v2, v3].some(offset => degree[offset / 3] >= 6);
      if (faceMaxDeviation > SKEWED_QUAD_DEGREES && !touchesHighPole) addQualityProblem(problems, 'skewed-quad', face);
    }
  }
  return {
    valence: { regular, poles3: valence3, poles5: valence5, poles6Plus: valence6Plus },
    quadQuality: {
      meanAngleError: quadCount ? roundMetric(meanAngleDeviation / quadCount) : 0,
      maxAngleError: roundMetric(maxAngleDeviation),
      maxAspect: roundMetric(maxAspectRatio),
      maxWarp: roundMetric(maxWarpAngle),
    },
  };
}

function addQualityProblem(problems, kind, element) {
  let problem = problems.get(kind);
  if (!problem) {
    problem = { kind, ...GEOMETRY_PROBLEMS[kind], count: 0, sample: [] };
    problems.set(kind, problem);
  }
  problem.count++;
  if (problem.sample.length < SAMPLE_LIMIT) problem.sample.push(element);
}

function addProblem(problems, kind, element) {
  let problem = problems.get(kind);
  if (!problem) {
    problem = { kind, ...PROBLEMS[kind], count: 0, sample: [] };
    problems.set(kind, problem);
  }
  problem.count++;
  if (problem.sample.length < SAMPLE_LIMIT) problem.sample.push(element);
}

/**
 * Signed volume of each part, from the divergence theorem over its triangulated fan.
 * Only meaningful for closed, consistently wound parts.
 */
function partVolumes(mesh, facePart, partCount) {
  const volumes = new Float64Array(partCount);
  const positions = mesh.positions;
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    const anchor = mesh.cornerVertices[start] * 3;
    for (let corner = start + 1; corner + 1 < end; corner++) {
      const second = mesh.cornerVertices[corner] * 3;
      const third = mesh.cornerVertices[corner + 1] * 3;
      volumes[facePart[face]] += (
        positions[anchor] * (positions[second + 1] * positions[third + 2] - positions[second + 2] * positions[third + 1]) +
        positions[anchor + 1] * (positions[second + 2] * positions[third] - positions[second] * positions[third + 2]) +
        positions[anchor + 2] * (positions[second] * positions[third + 1] - positions[second + 1] * positions[third])
      ) / 6;
    }
  }
  return volumes;
}

// A slightly skewed ray direction avoids running exactly along axis-aligned edges and faces.
const RAY_DIRECTION = [0.8017837, 0.5345225, 0.2672612];

/** Whether the ray from origin along RAY_DIRECTION crosses triangle (a, b, c), by Moller-Trumbore. */
function rayHitsTriangle(origin, positions, a, b, c) {
  const edgeFirst = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
  const edgeSecond = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
  const [directionX, directionY, directionZ] = RAY_DIRECTION;
  const perpendicular = [
    directionY * edgeSecond[2] - directionZ * edgeSecond[1],
    directionZ * edgeSecond[0] - directionX * edgeSecond[2],
    directionX * edgeSecond[1] - directionY * edgeSecond[0],
  ];
  const determinant = edgeFirst[0] * perpendicular[0] + edgeFirst[1] * perpendicular[1] + edgeFirst[2] * perpendicular[2];
  if (Math.abs(determinant) < 1e-12) return false;
  const inverse = 1 / determinant;
  const toOrigin = [origin[0] - positions[a], origin[1] - positions[a + 1], origin[2] - positions[a + 2]];
  const u = (toOrigin[0] * perpendicular[0] + toOrigin[1] * perpendicular[1] + toOrigin[2] * perpendicular[2]) * inverse;
  if (u < 0 || u > 1) return false;
  const cross = [
    toOrigin[1] * edgeFirst[2] - toOrigin[2] * edgeFirst[1],
    toOrigin[2] * edgeFirst[0] - toOrigin[0] * edgeFirst[2],
    toOrigin[0] * edgeFirst[1] - toOrigin[1] * edgeFirst[0],
  ];
  const v = (directionX * cross[0] + directionY * cross[1] + directionZ * cross[2]) * inverse;
  if (v < 0 || u + v > 1) return false;
  const distance = (edgeSecond[0] * cross[0] + edgeSecond[1] * cross[1] + edgeSecond[2] * cross[2]) * inverse;
  return distance > 0;
}

/** Whether a vertex of `part` lies inside the faces of the other parts (odd number of ray crossings). */
function insideOtherPart(mesh, facePart, part) {
  let face = 0;
  while (facePart[face] !== part) face++;
  const vertex = mesh.cornerVertices[mesh.faceOffsets[face]] * 3;
  const origin = [mesh.positions[vertex], mesh.positions[vertex + 1], mesh.positions[vertex + 2]];
  let crossings = 0;
  for (let other = 0; other < mesh.faceCount; other++) {
    if (facePart[other] === part) continue;
    const start = mesh.faceOffsets[other];
    const anchor = mesh.cornerVertices[start] * 3;
    for (let corner = start + 1; corner + 1 < mesh.faceOffsets[other + 1]; corner++) {
      if (rayHitsTriangle(origin, mesh.positions, anchor, mesh.cornerVertices[corner] * 3, mesh.cornerVertices[corner + 1] * 3)) crossings++;
    }
  }
  return crossings % 2 === 1;
}

/**
 * Check a mesh for problems that break later operations or rendering.
 * Returns { ok, counts, parts, tags, bounds, problems }, where each problem has kind, severity, count, a sample of
 * element indices (faces, edges or vertices by kind) and a suggested fix. ok is false when any error is present.
 */
export function lintMesh(mesh, { geometry = false } = {}) {
  const problems = new Map();
  const table = edgeCornerTable(mesh);
  const facesOfCorners = cornerFaces(mesh);
  const { facePart, partCount } = faceParts(mesh, table, facesOfCorners);
  const partOpen = new Uint8Array(partCount);
  const partWindingBroken = new Uint8Array(partCount);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const start = table.edgeOffsets[edge];
    const faceCount = table.edgeOffsets[edge + 1] - start;
    const part = facePart[facesOfCorners[table.edgeCorners[start]]];
    if (faceCount === 1) {
      addProblem(problems, 'boundary-edge', edge);
      partOpen[part] = 1;
    } else if (faceCount > 2) {
      addProblem(problems, 'non-manifold-edge', edge);
      partOpen[part] = 1;
    } else if (mesh.cornerVertices[table.edgeCorners[start]] === mesh.cornerVertices[table.edgeCorners[start + 1]]) {
      addProblem(problems, 'inconsistent-winding', edge);
      partWindingBroken[part] = 1;
    }
  }
  const bounds = meshBounds(mesh);
  const diagonal = Math.hypot(...bounds.max.map((value, axis) => value - bounds.min[axis]));
  const minimumArea = (diagonal * 1e-7) ** 2;
  const { areas } = faceNormals(mesh);
  for (let face = 0; face < mesh.faceCount; face++) {
    if (areas[face] <= minimumArea) addProblem(problems, 'degenerate-face', face);
  }
  const used = new Uint8Array(mesh.vertexCount);
  for (const vertex of mesh.cornerVertices) used[vertex] = 1;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (!used[vertex]) addProblem(problems, 'loose-vertex', vertex);
  }
  const volumes = partVolumes(mesh, facePart, partCount);
  let closedParts = 0;
  let cavities = 0;
  const solidParts = [];
  for (let part = 0; part < partCount; part++) {
    if (partOpen[part] || partWindingBroken[part]) continue;
    closedParts++;
    if (volumes[part] >= 0) {
      solidParts.push(part);
      continue;
    }
    // A negative shell inside another part is a cavity (a hollow), which is valid; elsewhere it is inside out.
    if (insideOtherPart(mesh, facePart, part)) cavities++;
    else addProblem(problems, 'inverted-part', part);
  }
  const topology = meshTopologyMetrics(mesh, table, geometry ? problems : null);
  const problemList = [...problems.values()];
  let skippedChecks;
  if (geometry) {
    const spatial = lintMeshGeometry(mesh, { facePart, partCount, solidParts, bounds, diagonal });
    for (const found of spatial.problems) problemList.push({ ...found, ...GEOMETRY_PROBLEMS[found.kind] });
    if (spatial.skipped.length) skippedChecks = spatial.skipped;
  }
  const ok = !problemList.some(problem => problem.severity === 'error');
  return {
    ok,
    counts: { vertices: mesh.vertexCount, edges: mesh.edgeCount, faces: mesh.faceCount, corners: mesh.cornerCount },
    parts: { count: partCount, closed: closedParts, cavities },
    valence: topology.valence,
    quadQuality: topology.quadQuality,
    topologyScore: computeTopologyScore(mesh, ok, topology),
    tags: tagCounts(mesh),
    bounds,
    problems: problemList,
    ...(skippedChecks ? { skippedChecks } : {}),
  };
}

function computeTopologyScore(mesh, ok, { valence, quadQuality }) {
  if (!ok || mesh.faceCount === 0) return 0;
  let quadCount = 0;
  for (let face = 0; face < mesh.faceCount; face++) {
    if (mesh.faceOffsets[face + 1] - mesh.faceOffsets[face] === 4) quadCount++;
  }
  const quadShare = quadCount / mesh.faceCount;
  const interiorVertices = valence.regular + valence.poles3 + valence.poles5 + valence.poles6Plus;
  const regularShare = interiorVertices > 0 ? (valence.regular + 0.5 * valence.poles3 + 0.5 * valence.poles5) / interiorVertices : 1;
  const angleHealth = Math.max(0, 1 - quadQuality.meanAngleError / 60);
  const warpHealth = Math.max(0, 1 - quadQuality.maxWarp / 90);
  const shapeHealth = (angleHealth + warpHealth) / 2;
  return roundMetric(0.5 * quadShare + 0.25 * regularShare + 0.25 * shapeHealth);
}
