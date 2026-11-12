// The instanced trace scene of a bench scene for the native cycles kernel: copies of one geometry stay instances, and a part that hides
// from some ray kinds gets those visibility bits cleared (buildTraceScene reads `rayVisibility`, #1054). The scene is built with the
// native triangle bound (#1041), so a scene above the 400,000 unique triangles of the CPU and WebGL paths, such as the Classroom, packs directly.
import { MAX_NATIVE_TRACE_TRIANGLES } from '../../src/path-tracer-scene.js';
import { buildTraceSceneWithManyLights } from './trace-scene-many-lights.mjs';

export function buildInstancedTraceScene(parts, environment) {
  const scene = buildTraceSceneWithManyLights(parts, environment, { instancing: true, maximumTriangles: MAX_NATIVE_TRACE_TRIANGLES });
  if (!scene.instances) {
    throw new RangeError('The scene has no shared geometry and was flattened.');
  }
  return scene;
}
