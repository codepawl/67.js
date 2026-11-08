import { traceObjectProbes } from './probe-trace.js';
import { placeProbes } from './reflection-probes.js';

// Object reflections: every smooth metal part of a recipe gets a probe of its own, traced from the scene around it, so
// a chrome sphere shows the floor and its neighbours and not only the sky. A scene with no such part never loads this
// module, and one that has it pays one small trace when the parts, lights or materials change.

/**
 * Places an object probe on each reflective part. `sourceParts` hold world matrices at rest and are what the probes see;
 * `drawnParts` are the same parts after any bake, and the result keeps their order.
 * Returns the parts as given when the scene has nothing to reflect (no reflective part, one part, or too many reflective
 * parts), with a report that says why.
 */
export function placeObjectReflections(sourceParts, drawnParts, environment, environmentMap) {
  const sunScale = environment.keyIntensity ?? 1;
  const lighting = {
    pointLights: environment.pointLights,
    spotLights: environment.spotLights,
    areaLights: environment.areaLights,
    keyColor: Array.from(environment.keyColor, channel => channel * sunScale),
    lightDirection: environment.lightDirection,
  };
  const trace = traceObjectProbes(sourceParts, lighting, { environment, environmentMap, rotation: environmentMap?.rotation ?? 0 });
  if (trace.traced.length === 0) {
    return { parts: drawnParts, report: { placed: 0, skipped: trace.skipped } };
  }
  const placed = placeProbes(drawnParts, trace, { rotation: environmentMap?.rotation ?? 0 });
  return { parts: placed.parts, report: { placed: placed.report.placed.length, partsWithProbe: placed.report.partsWithProbe, seconds: trace.seconds } };
}

/**
 * The recipe stage: places the probes, and traces again only when the parts, lights, setup or materials change.
 * `cache` is what the last call returned (or null); the result of the new call is its `result`, null when no part got a probe.
 */
export function stageObjectReflections(cache, recipe, sourceParts, drawnParts, graph, environmentMap) {
  const { environment } = recipe;
  const worldMatrices = sourceParts.map(part => Array.from(graph.getNode(part.name).worldMatrix));
  const key = JSON.stringify([environment.pointLights, environment.spotLights, environment.areaLights, environment.keyColor, environment.keyIntensity, environment.lightDirection,
    environment.skyTop, environment.skyBottom, environment.setup, environment.hdri, environment.environmentIntensity, environment.environmentRotation, recipe.materials, worldMatrices]);
  if (cache?.key === key && cache.sourceParts === sourceParts && cache.drawnParts === drawnParts) {
    return cache;
  }
  const placed = placeObjectReflections(sourceParts, drawnParts, environment, environmentMap);
  return { key, sourceParts, drawnParts, result: placed.report.placed > 0 ? placed : null };
}
