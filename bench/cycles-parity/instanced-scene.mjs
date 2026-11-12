// The instanced trace scene of a bench scene for the native cycles kernel: copies of one geometry stay instances, and a part that hides
// from some ray kinds gets those visibility bits cleared (buildTraceScene does not read `rayVisibility`). The scene is built with the
// native triangle bound (#1041), so a scene above the 400,000 unique triangles of the CPU and WebGL paths, such as the Classroom, packs directly.
import { MAX_NATIVE_TRACE_TRIANGLES } from '../../src/path-tracer-scene.js';
import { buildTraceSceneWithManyLights } from './trace-scene-many-lights.mjs';

// FORMAT-v2 instance visibility bits: 1 camera, 2 diffuse, 4 glossy, 8 transmission, 16 shadow, 32 volume scatter.
const RAY_VISIBILITY_BITS = { camera: 1, diffuse: 2, glossy: 4, transmission: 8, shadow: 16, volumeScatter: 32 };
const ALL_RAY_KINDS = 63;

function visibilityFlagsFor(part) {
  let flags = ALL_RAY_KINDS;
  for (const [kind, isVisible] of Object.entries(part.rayVisibility ?? {})) {
    if (isVisible === false) {
      flags &= ~RAY_VISIBILITY_BITS[kind];
    }
  }
  return flags;
}

// Each instance of the scene is its part, in order.
function applyRayVisibility(scene, parts) {
  scene.instances.forEach((instance, index) => {
    if (parts[index].rayVisibility) {
      instance.visibilityFlags = visibilityFlagsFor(parts[index]);
    }
  });
}

export function buildInstancedTraceScene(parts, environment) {
  const scene = buildTraceSceneWithManyLights(parts, environment, { instancing: true, maximumTriangles: MAX_NATIVE_TRACE_TRIANGLES });
  if (!scene.instances) {
    throw new RangeError('The scene has no shared geometry and was flattened.');
  }
  applyRayVisibility(scene, parts);
  return scene;
}
