import { resolveShadowLight } from './shadow-light.js';

/**
 * Diagnostics for a frame that renders without error but not as asked. They use the shape of `agent-diagnostics.js`
 * (kind, severity, target, message, fix) and are read from `renderer.diagnostics`.
 */
const SHADOW_DISAGREEMENT_DEGREES = 10;
const NO_DIAGNOSTICS = Object.freeze([]);

function warning(kind, target, message, fix) {
  return { kind, severity: 'warning', target, message, fix };
}

function angleBetweenDegrees(first, second) {
  const dot = first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
  const lengths = Math.hypot(...first) * Math.hypot(...second);
  if (!(lengths > 1e-6)) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot / lengths))) * 180 / Math.PI;
}

function shadowDirectionProblem(world, lightDirection, shadowBounds) {
  const light = resolveShadowLight(world, lightDirection, shadowBounds);
  const towardShadowEye = light.eye.map((value, axis) => value - light.target[axis]);
  const degrees = angleBetweenDegrees(towardShadowEye, lightDirection);
  if (degrees < SHADOW_DISAGREEMENT_DEGREES) return null;
  return warning('shadow-light-direction-mismatch', 'shadowBounds.eye',
    `shadowBounds.eye is ${Math.round(degrees)} degrees off lightDirection; the eye sets the shadow direction.`,
    'Drop shadowBounds.eye, or point lightDirection from shadowBounds.target to it.');
}

export function frameDiagnostics({ world, depth, effects, lightDirection, shadowBounds, coplanarProblems = null, skinProblems = null }) {
  const problems = [];
  if (effects.ambientOcclusion > 0 && !depth) {
    problems.push(warning('ambient-occlusion-without-depth', 'effects.ambientOcclusion',
      `ambientOcclusion is ${effects.ambientOcclusion} but the renderer has no depth, so the pass is skipped.`,
      'Build the renderer with depth: true, or set ambientOcclusion to 0.'));
  }
  if (shadowBounds?.eye && lightDirection) {
    const problem = shadowDirectionProblem(world, lightDirection, shadowBounds);
    if (problem) problems.push(problem);
  }
  if (coplanarProblems?.length) problems.push(...coplanarProblems);
  if (skinProblems?.length) problems.push(...skinProblems);
  return problems.length ? problems : NO_DIAGNOSTICS;
}
