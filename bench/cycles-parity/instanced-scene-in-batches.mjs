// buildTraceScene({ instancing: true }) refuses more than MAX_TRACE_TRIANGLES (400,000) unique triangles, counted once per shared
// geometry. The native cycles kernel has no such limit (bench/cycles-parity/large-scene.mjs packs bigger scenes directly), and the
// Classroom scene holds 427,769 unique triangles. This builds the instanced scene in two batches that each fit under the cap and joins
// their instance and material lists, so the bench needs no change to src/.
import { MAX_TRACE_TRIANGLES } from '../../src/path-tracer-scene.js';
import { buildTraceSceneWithManyLights } from './trace-scene-many-lights.mjs';

function triangleCountOf(geometry) {
  return geometry.indices.length / 3;
}

function groupPartsByGeometry(parts) {
  const groups = new Map();
  for (const part of parts) {
    if (!groups.has(part.geometry)) {
      groups.set(part.geometry, []);
    }
    groups.get(part.geometry).push(part);
  }
  return groups;
}

function uniqueTriangleTotal(geometries) {
  let total = 0;
  for (const geometry of geometries) {
    total += triangleCountOf(geometry);
  }
  return total;
}

/**
 * Splits the geometries into one batch that fits the cap and, when the scene is over it, a second batch seeded with the biggest
 * shared geometries, so each batch still has shared geometry (a batch without any is flattened by buildTraceScene).
 */
export function splitGeometriesIntoBatches(groups) {
  const allGeometries = [...groups.keys()];
  if (uniqueTriangleTotal(allGeometries) <= MAX_TRACE_TRIANGLES) {
    return [allGeometries];
  }
  const sharedBySize = allGeometries
    .filter((geometry) => groups.get(geometry).length > 1)
    .sort((first, second) => triangleCountOf(second) - triangleCountOf(first));
  const secondBatch = new Set();
  let firstBatch = new Set(allGeometries);
  for (const geometry of sharedBySize) {
    if (uniqueTriangleTotal(firstBatch) <= MAX_TRACE_TRIANGLES && secondBatch.size > 0) {
      break;
    }
    secondBatch.add(geometry);
    firstBatch.delete(geometry);
  }
  if (uniqueTriangleTotal(firstBatch) > MAX_TRACE_TRIANGLES || uniqueTriangleTotal(secondBatch) > MAX_TRACE_TRIANGLES) {
    throw new RangeError('The scene needs more than two batches of instanced geometry; split it further in instanced-scene-in-batches.mjs.');
  }
  return [[...firstBatch], [...secondBatch]];
}

export function buildInstancedTraceSceneInBatches(parts, environment) {
  const groups = groupPartsByGeometry(parts);
  const batches = splitGeometriesIntoBatches(groups);
  const scenes = batches.map((geometries) => {
    const batchParts = geometries.flatMap((geometry) => groups.get(geometry));
    const scene = buildTraceSceneWithManyLights(batchParts, environment, { instancing: true });
    if (!scene.instances) {
      throw new RangeError('A batch of the instanced scene has no shared geometry and was flattened.');
    }
    return scene;
  });
  const [firstScene, ...otherScenes] = scenes;
  const joined = { ...firstScene, instances: [...firstScene.instances], materials: [...firstScene.materials], traceMaterials: [...firstScene.traceMaterials] };
  for (const scene of otherScenes) {
    const partOffset = joined.materials.length;
    for (const instance of scene.instances) {
      joined.instances.push({ ...instance, materialIndex: instance.materialIndex + partOffset, objectId: instance.objectId + partOffset });
    }
    joined.materials.push(...scene.materials);
    joined.traceMaterials.push(...scene.traceMaterials);
    joined.surfaceOffset = Math.max(joined.surfaceOffset, scene.surfaceOffset);
    joined.farDistance = Math.max(joined.farDistance, scene.farDistance);
  }
  return { scene: joined, batchCount: batches.length, uniqueTrianglesPerBatch: batches.map(uniqueTriangleTotal) };
}
