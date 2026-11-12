// buildTraceScene takes at most MAX_TRACE_LIGHTS point, spot and area lights, because light linking keeps one mask bit per light.
// The parity harness has no light links, so a scene with more lights is built in chunks of that size and the light lists are joined.
// Every joined light gets bit -1, which the native packer reads as "all groups", so no two lights share a link bit.
import { buildTraceScene, MAX_TRACE_LIGHTS } from '../../src/path-tracer-scene.js';
import { applyCookOnlyFields } from './cook-only-fields.mjs';

const UNLINKED_LIGHT_BIT = -1;

function listAnalyticLights(environment) {
  return [
    ...(environment.pointLights ?? []).map(light => ({ kind: 'pointLights', light })),
    ...(environment.spotLights ?? []).map(light => ({ kind: 'spotLights', light })),
    ...(environment.areaLights ?? []).map(light => ({ kind: 'areaLights', light })),
  ];
}

function chunkEnvironment(environment, chunk) {
  const lightsByKind = { pointLights: [], spotLights: [], areaLights: [] };
  for (const entry of chunk) {
    lightsByKind[entry.kind].push(entry.light);
  }
  return { ...environment, keyColor: [0, 0, 0], ...lightsByKind };
}

function unlinkedLights(lights) {
  return lights.map(light => ({ ...light, bit: UNLINKED_LIGHT_BIT }));
}

// `options.instancing` keeps copies of one geometry as instances (a scene packed with buildNativeInputV2 for the cycles kernel).
export function buildTraceSceneWithManyLights(parts, environment, options = {}) {
  const analyticLights = listAnalyticLights(environment);
  if (analyticLights.length <= MAX_TRACE_LIGHTS) {
    return applyCookOnlyFields(buildTraceScene(parts, environment, options), parts, environment);
  }
  const points = [];
  const spots = [];
  const areas = [];
  for (let start = 0; start < analyticLights.length; start += MAX_TRACE_LIGHTS) {
    const chunk = analyticLights.slice(start, start + MAX_TRACE_LIGHTS);
    const chunkLights = buildTraceScene(parts, chunkEnvironment(environment, chunk), options).lights;
    points.push(...unlinkedLights(chunkLights.points));
    spots.push(...unlinkedLights(chunkLights.spots));
    areas.push(...unlinkedLights(chunkLights.areas));
  }
  const traceScene = buildTraceScene(parts, { ...environment, pointLights: [], spotLights: [], areaLights: [] }, options);
  traceScene.lights = { sun: traceScene.lights.sun, points, spots, areas };
  return applyCookOnlyFields(traceScene, parts, environment);
}
