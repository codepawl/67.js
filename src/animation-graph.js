// Animation state graph for live play: states that hold a clip or a 1D / 2D blend space, transitions that fire on parameter
// conditions and crossfade, and layers that each run their own graph over a bone group. Game logic sets parameters; the graph
// advances in fixed steps and says which clip plays at which time and weight. It knows no rig: `poseLayers()` hands the
// result to createSkeletonPose / createAssetPose, and any retargeted clip can be a motion. Same parameters and the same
// steps always give the same weights. See docs/animation-graph.md.
import { extractRootMotion, normalizeRootMotionSettings } from './animation-root-motion.js';

export { createFootPlacement, createLookAt } from './animation-ik.js';
export { extractRootMotion } from './animation-root-motion.js';
export { createPathFollower, NPC_FOLLOWER_LIMITS } from './npc-follower.js';

export const ANIMATION_GRAPH_LIMITS = Object.freeze({
  maximumFadingStates: 4,
  maximumParameters: 64,
  maximumLayers: 8,
  maximumStates: 64,
  maximumTransitions: 256,
  maximumConditions: 8,
  maximumMotions: 16,
  maximumFadeSeconds: 10,
  maximumDeltaSeconds: 10,
});

const PARAMETER_TYPES = ['number', 'boolean', 'trigger'];
const NUMBER_COMPARATORS = {
  greater: (value, limit) => value > limit,
  atLeast: (value, limit) => value >= limit,
  less: (value, limit) => value < limit,
  atMost: (value, limit) => value <= limit,
  equals: (value, limit) => value === limit,
  notEquals: (value, limit) => value !== limit,
};
const FADE_EPSILON = 1e-9;

function describe(value) {
  return value === null ? 'null' : typeof value;
}

function requireName(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${label} must be a non-empty string, got ${describe(value)}.`);
  }
  return value;
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object, got ${Array.isArray(value) ? 'array' : describe(value)}.`);
  }
  return value;
}

function requireArray(value, label, maximum) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new RangeError(`${label} must be an array of 1 to ${maximum} entries.`);
  }
  return value;
}

function requireFiniteNumber(value, label, minimum = -Infinity, maximum = Infinity) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    const range = minimum === -Infinity && maximum === Infinity ? 'a finite number' : `a number from ${minimum} to ${maximum}`;
    throw new RangeError(`${label} must be ${range}, got ${String(value)}.`);
  }
  return value;
}

// With root motion, `clip` is the in-place copy that poses read and `rootMotion` carries the travel taken out of it.
function compileClips(clips, rootMotion) {
  requireObject(clips, 'createAnimationGraph clips');
  const table = new Map();
  for (const [name, clip] of Object.entries(clips)) {
    const label = `createAnimationGraph clips.${name}`;
    requireObject(clip, label);
    requireFiniteNumber(clip.duration, `${label}.duration`, 1e-6);
    const extracted = rootMotion && Array.isArray(clip.tracks) ? extractRootMotion(clip, rootMotion) : null;
    table.set(name, {
      name,
      clip: extracted ? extracted.clip : clip,
      duration: clip.duration,
      loop: clip.loop === true,
      rootMotion: extracted?.hasMotion ? extracted : null,
    });
  }
  return table;
}

function compileParameters(parameters) {
  requireObject(parameters, 'createAnimationGraph parameters');
  const entries = Object.entries(parameters);
  if (entries.length > ANIMATION_GRAPH_LIMITS.maximumParameters) {
    throw new RangeError(`createAnimationGraph holds at most ${ANIMATION_GRAPH_LIMITS.maximumParameters} parameters. Merge some.`);
  }
  const table = new Map();
  for (const [name, definition] of entries) {
    const label = `createAnimationGraph parameters.${name}`;
    requireObject(definition, label);
    if (!PARAMETER_TYPES.includes(definition.type)) {
      throw new TypeError(`${label}.type must be one of ${PARAMETER_TYPES.join(', ')}, got ${String(definition.type)}.`);
    }
    let initial = definition.type === 'boolean' ? false : 0;
    if (definition.type === 'number') initial = requireFiniteNumber(definition.initial ?? 0, `${label}.initial`);
    if (definition.type === 'boolean') {
      initial = definition.initial ?? false;
      if (typeof initial !== 'boolean') throw new TypeError(`${label}.initial must be a boolean, got ${describe(initial)}.`);
    }
    if (definition.type === 'trigger') initial = false;
    table.set(name, { name, type: definition.type, initial, value: initial });
  }
  return table;
}

function parameterOf(parameters, name, label) {
  const parameter = parameters.get(name);
  if (!parameter) {
    throw new RangeError(`${label} names parameter "${String(name)}", which is not declared. Declared: ${[...parameters.keys()].join(', ') || 'none'}.`);
  }
  return parameter;
}

function numberParameterOf(parameters, name, label) {
  const parameter = parameterOf(parameters, name, label);
  if (parameter.type !== 'number') throw new TypeError(`${label} needs a number parameter, but "${name}" is a ${parameter.type}.`);
  return parameter;
}

function compileMask(mask, boneGroups, label) {
  if (mask === undefined) return undefined;
  let definition = mask;
  if (typeof mask === 'string') {
    definition = boneGroups[mask];
    if (!definition) throw new RangeError(`${label} names bone group "${mask}", which is not in boneGroups. Declared: ${Object.keys(boneGroups).join(', ') || 'none'}.`);
  }
  requireObject(definition, label);
  requireArray(definition.joints, `${label}.joints`, 256).forEach((joint, index) => requireName(joint, `${label}.joints[${index}]`));
  const compiled = { joints: [...definition.joints] };
  if (definition.descendants !== undefined) compiled.descendants = definition.descendants !== false;
  if (definition.exclude !== undefined) {
    compiled.exclude = requireArray(definition.exclude, `${label}.exclude`, 256).map((joint, index) => requireName(joint, `${label}.exclude[${index}]`));
  }
  return compiled;
}

function compileMotion(motion, label, clips) {
  requireObject(motion, label);
  const clipName = requireName(motion.clip, `${label}.clip`);
  const clip = clips.get(clipName);
  if (!clip) throw new RangeError(`${label}.clip names "${clipName}", which is not in clips. Declared: ${[...clips.keys()].join(', ') || 'none'}.`);
  return { clip };
}

function compileBlend1D(blend, label, clips, parameters) {
  numberParameterOf(parameters, blend.parameter, `${label}.parameter`);
  const motions = requireArray(blend.motions, `${label}.motions`, ANIMATION_GRAPH_LIMITS.maximumMotions).map((motion, index) => ({
    ...compileMotion(motion, `${label}.motions[${index}]`, clips),
    threshold: requireFiniteNumber(motion.threshold, `${label}.motions[${index}].threshold`),
  }));
  const sorted = [...motions].sort((first, second) => first.threshold - second.threshold);
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index].threshold === sorted[index - 1].threshold) {
      throw new RangeError(`${label}.motions has two motions at threshold ${sorted[index].threshold}. Give each its own threshold.`);
    }
  }
  return { kind: 'blend1d', parameterNames: [blend.parameter], motions, sorted };
}

function compileBlend2D(blend, label, clips, parameters) {
  if (!Array.isArray(blend.parameters) || blend.parameters.length !== 2) {
    throw new TypeError(`${label}.parameters must be two number parameter names such as ["strafe", "forward"].`);
  }
  blend.parameters.forEach((name, index) => numberParameterOf(parameters, name, `${label}.parameters[${index}]`));
  const motions = requireArray(blend.motions, `${label}.motions`, ANIMATION_GRAPH_LIMITS.maximumMotions).map((motion, index) => {
    const position = motion.position;
    if (!Array.isArray(position) || position.length !== 2) throw new TypeError(`${label}.motions[${index}].position must be [x, y].`);
    return {
      ...compileMotion(motion, `${label}.motions[${index}]`, clips),
      x: requireFiniteNumber(position[0], `${label}.motions[${index}].position[0]`),
      y: requireFiniteNumber(position[1], `${label}.motions[${index}].position[1]`),
    };
  });
  for (let first = 0; first < motions.length; first++) {
    for (let second = first + 1; second < motions.length; second++) {
      if (motions[first].x === motions[second].x && motions[first].y === motions[second].y) {
        throw new RangeError(`${label}.motions[${second}] sits at the same position as motions[${first}]. Move one of them.`);
      }
    }
  }
  return { kind: 'blend2d', parameterNames: [...blend.parameters], motions };
}

function compileState(definition, label, clips, parameters) {
  requireObject(definition, label);
  const name = requireName(definition.name, `${label}.name`);
  if ((definition.clip === undefined) === (definition.blend === undefined)) {
    throw new TypeError(`${label} (state "${name}") needs exactly one of clip (a clip name) or blend (a blend space).`);
  }
  let motion;
  if (definition.clip !== undefined) {
    motion = { kind: 'clip', parameterNames: [], motions: [compileMotion({ clip: definition.clip }, label, clips)] };
  } else {
    requireObject(definition.blend, `${label}.blend`);
    motion = definition.blend.parameters === undefined
      ? compileBlend1D(definition.blend, `${label}.blend`, clips, parameters)
      : compileBlend2D(definition.blend, `${label}.blend`, clips, parameters);
  }
  const speed = requireFiniteNumber(definition.speed ?? 1, `${label}.speed`, 0, 100);
  const speedParameter = definition.speedParameter;
  if (speedParameter !== undefined) numberParameterOf(parameters, speedParameter, `${label}.speedParameter`);
  const loop = definition.loop ?? (motion.kind === 'clip' ? motion.motions[0].clip.loop : true);
  if (typeof loop !== 'boolean') throw new TypeError(`${label}.loop must be a boolean, got ${describe(loop)}.`);
  return { name, ...motion, speed, speedParameter, loop };
}

function compileCondition(condition, label, parameters) {
  requireObject(condition, label);
  const parameter = parameterOf(parameters, condition.parameter, `${label}.parameter`);
  const keys = Object.keys(condition).filter(key => key !== 'parameter');
  if (parameter.type === 'number') {
    const comparators = keys.filter(key => Object.hasOwn(NUMBER_COMPARATORS, key));
    if (comparators.length !== 1 || keys.length !== 1) {
      throw new TypeError(`${label} on number parameter "${parameter.name}" needs exactly one of ${Object.keys(NUMBER_COMPARATORS).join(', ')}, such as { parameter: "${parameter.name}", greater: 0.1 }.`);
    }
    const comparator = comparators[0];
    return { parameter, test: NUMBER_COMPARATORS[comparator], limit: requireFiniteNumber(condition[comparator], `${label}.${comparator}`) };
  }
  if (keys.some(key => key !== 'is')) {
    throw new TypeError(`${label} on ${parameter.type} parameter "${parameter.name}" takes only is: true or is: false.`);
  }
  const expected = condition.is ?? true;
  if (typeof expected !== 'boolean') throw new TypeError(`${label}.is must be a boolean, got ${describe(expected)}.`);
  return { parameter, test: (value, limit) => value === limit, limit: expected };
}

function interruptOf(value, label) {
  if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`${label}.interrupt must be true or false, got ${describe(value)}.`);
  return value === true;
}

function compileTransition(definition, label, states, parameters) {
  requireObject(definition, label);
  const from = definition.from ?? '*';
  if (from !== '*' && !states.has(from)) throw new RangeError(`${label}.from names "${String(from)}", which is not a state of this layer. Use a state name or "*" for any state.`);
  const to = definition.to;
  if (!states.has(to)) throw new RangeError(`${label}.to names "${String(to)}", which is not a state of this layer. States: ${[...states.keys()].join(', ')}.`);
  if (from === to) throw new RangeError(`${label} goes from "${to}" to itself. Remove it, or use a different target state.`);
  const conditions = definition.when === undefined ? [] : requireArray(definition.when, `${label}.when`, ANIMATION_GRAPH_LIMITS.maximumConditions);
  const exitPhase = definition.exitPhase;
  if (exitPhase !== undefined) requireFiniteNumber(exitPhase, `${label}.exitPhase`, 0, 1000);
  if (conditions.length === 0 && exitPhase === undefined) {
    throw new TypeError(`${label} needs when (a list of parameter conditions) or exitPhase, or it would fire at once, every step.`);
  }
  return {
    from,
    to,
    duration: requireFiniteNumber(definition.duration ?? 0, `${label}.duration`, 0, ANIMATION_GRAPH_LIMITS.maximumFadeSeconds),
    exitPhase,
    interrupt: interruptOf(definition.interrupt, label),
    conditions: conditions.map((condition, index) => compileCondition(condition, `${label}.when[${index}]`, parameters)),
  };
}

function compileLayer(definition, position, clips, parameters, boneGroups) {
  const label = `createAnimationGraph layers[${position}]`;
  requireObject(definition, label);
  const name = requireName(definition.name, `${label}.name`);
  const stateDefinitions = requireArray(definition.states, `${label}.states`, ANIMATION_GRAPH_LIMITS.maximumStates);
  const states = new Map();
  stateDefinitions.forEach((stateDefinition, index) => {
    const state = compileState(stateDefinition, `${label}.states[${index}]`, clips, parameters);
    if (states.has(state.name)) throw new RangeError(`${label} has two states named "${state.name}". Rename one.`);
    states.set(state.name, state);
  });
  const initial = definition.initial ?? stateDefinitions[0].name;
  if (!states.has(initial)) throw new RangeError(`${label}.initial names "${String(initial)}", which is not a state. States: ${[...states.keys()].join(', ')}.`);
  const transitions = (definition.transitions === undefined ? [] : requireArray(definition.transitions, `${label}.transitions`, ANIMATION_GRAPH_LIMITS.maximumTransitions))
    .map((transition, index) => compileTransition(transition, `${label}.transitions[${index}]`, states, parameters));
  const reference = definition.reference ?? 0;
  requireFiniteNumber(reference, `${label}.reference`);
  if (definition.additive !== undefined && typeof definition.additive !== 'boolean') throw new TypeError(`${label}.additive must be a boolean.`);

  // One slot per clip of the layer. A slot has one time, so a clip shared by both ends of a crossfade plays at the incoming state's time.
  const slots = [];
  const slotOf = new Map();
  for (const state of states.values()) {
    for (const motion of state.motions) {
      if (slotOf.has(motion.clip.name)) continue;
      slotOf.set(motion.clip.name, slots.length);
      slots.push({ clip: motion.clip, weight: 0, time: 0, poseWeight: 0 });
    }
  }
  return {
    name,
    states,
    initial,
    transitions,
    slots,
    slotOf,
    mask: compileMask(definition.mask, boneGroups, `${label}.mask`),
    additive: definition.additive === true,
    reference,
    initialWeight: requireFiniteNumber(definition.weight ?? 1, `${label}.weight`, 0, 1),
  };
}

// Weights of the motions of a state for the current parameters. They always sum to 1.
function writeMotionWeights(state, parameters, weights) {
  weights.fill(0);
  if (state.kind === 'clip') {
    weights[0] = 1;
  } else if (state.kind === 'blend1d') {
    writeBlend1DWeights(state, parameters.get(state.parameterNames[0]).value, weights);
  } else {
    writeBlend2DWeights(state, parameters.get(state.parameterNames[0]).value, parameters.get(state.parameterNames[1]).value, weights);
  }
}

function writeBlend1DWeights(state, value, weights) {
  const { sorted, motions } = state;
  const last = sorted.length - 1;
  if (value <= sorted[0].threshold) {
    weights[motions.indexOf(sorted[0])] = 1;
    return;
  }
  if (value >= sorted[last].threshold) {
    weights[motions.indexOf(sorted[last])] = 1;
    return;
  }
  let upper = 1;
  while (sorted[upper].threshold < value) upper += 1;
  const lower = sorted[upper - 1];
  const progress = (value - lower.threshold) / (sorted[upper].threshold - lower.threshold);
  weights[motions.indexOf(lower)] = 1 - progress;
  weights[motions.indexOf(sorted[upper])] = progress;
}

// Gradient band interpolation: a motion's weight falls to 0 at every other motion and stays local, with no triangulation.
function writeBlend2DWeights(state, x, y, weights) {
  const { motions } = state;
  let total = 0;
  for (let index = 0; index < motions.length; index++) {
    let weight = 1;
    for (let other = 0; other < motions.length && weight > 0; other++) {
      if (other === index) continue;
      const directionX = motions[other].x - motions[index].x;
      const directionY = motions[other].y - motions[index].y;
      const along = ((x - motions[index].x) * directionX + (y - motions[index].y) * directionY) / (directionX * directionX + directionY * directionY);
      weight = Math.min(weight, Math.max(0, 1 - along));
    }
    weights[index] = weight;
    total += weight;
  }
  if (total === 0) {
    weights[0] = 1;
    return;
  }
  for (let index = 0; index < motions.length; index++) weights[index] /= total;
}

function createStateRuntime(state) {
  return { state, phase: 0, previousPhase: 0, frozen: false, weights: new Float64Array(state.motions.length) };
}

function stateSpeed(runtime, parameters) {
  const { state } = runtime;
  const multiplier = state.speedParameter ? parameters.get(state.speedParameter).value : 1;
  return state.speed * Math.max(0, multiplier);
}

function advanceStateRuntime(runtime, parameters, deltaSeconds) {
  const { state, weights } = runtime;
  if (!runtime.frozen) writeMotionWeights(state, parameters, weights);
  let duration = 0;
  for (let index = 0; index < weights.length; index++) duration += weights[index] * state.motions[index].clip.duration;
  runtime.previousPhase = runtime.phase;
  runtime.phase += deltaSeconds * stateSpeed(runtime, parameters) / duration;
}

// Adds the weighted root travel of one state over the last step to `total` ([x, z]).
function addRootTravel(runtime, stateWeight, total) {
  const { state, weights, phase, previousPhase } = runtime;
  state.motions.forEach((motion, index) => {
    const share = stateWeight * weights[index];
    const rootMotion = motion.clip.rootMotion;
    if (share <= 0 || !rootMotion) return;
    const after = rootMotion.displacement(phase, state.loop);
    const afterX = after[0];
    const afterZ = after[1];
    const before = rootMotion.displacement(previousPhase, state.loop);
    total[0] += share * (afterX - before[0]);
    total[1] += share * (afterZ - before[1]);
  });
}

function motionTime(runtime, motion) {
  const { phase, state } = runtime;
  const cycle = state.loop ? phase - Math.floor(phase) : Math.min(phase, 1);
  return cycle * motion.clip.duration;
}

function conditionsHold(transition, currentRuntime) {
  if (transition.exitPhase !== undefined && currentRuntime.phase < transition.exitPhase) return false;
  return transition.conditions.every(condition => condition.test(condition.parameter.value, condition.limit));
}

function createLayerRuntime(layer, parameters) {
  const runtime = {
    layer,
    weight: layer.initialWeight,
    current: null,
    // States fading out, oldest first, each with the share `base` it had when the running crossfade began. Their shares and
    // the incoming state's always sum to 1; an interrupting transition adds the state it interrupts.
    fading: [],
    fadeElapsed: 0,
    fadeDuration: 0,
    rootTravel: [0, 0],
  };

  function begin() {
    runtime.current = createStateRuntime(layer.states.get(layer.initial));
    runtime.fading = [];
    runtime.fadeElapsed = 0;
    runtime.fadeDuration = 0;
    runtime.rootTravel = [0, 0];
    runtime.weight = layer.initialWeight;
    writeMotionWeights(runtime.current.state, parameters, runtime.current.weights);
  }

  function fadeProgress() {
    return runtime.fading.length ? Math.min(1, runtime.fadeElapsed / runtime.fadeDuration) : 1;
  }

  // The outgoing blend keeps the weights it had, so a parameter change does not bend the fade.
  function fadeOutCurrent(duration) {
    const progress = fadeProgress();
    for (const entry of runtime.fading) entry.base *= 1 - progress;
    runtime.current.frozen = true;
    runtime.fading.push({ stateRuntime: runtime.current, base: progress });
    runtime.fading = runtime.fading.filter(entry => entry.base > 0);
    if (runtime.fading.length > ANIMATION_GRAPH_LIMITS.maximumFadingStates) runtime.fading.shift();
    const total = runtime.fading.reduce((sum, entry) => sum + entry.base, 0);
    for (const entry of runtime.fading) entry.base /= total;
    runtime.fadeElapsed = 0;
    runtime.fadeDuration = duration;
  }

  function startTransition() {
    const name = runtime.current.state.name;
    const fading = runtime.fading.length > 0;
    const transition = layer.transitions.find(candidate => (!fading || candidate.interrupt) && (candidate.from === '*' || candidate.from === name) && candidate.to !== name && conditionsHold(candidate, runtime.current));
    if (!transition) return;
    for (const condition of transition.conditions) {
      if (condition.parameter.type === 'trigger') condition.parameter.value = false;
    }
    const next = createStateRuntime(layer.states.get(transition.to));
    if (transition.duration > 0) fadeOutCurrent(transition.duration);
    else runtime.fading = [];
    runtime.current = next;
  }

  function collect() {
    for (const slot of layer.slots) slot.weight = 0;
    const progress = fadeProgress();
    const contributors = [...runtime.fading.map(entry => [entry.stateRuntime, entry.base * (1 - progress)]), [runtime.current, progress]];
    for (const [stateRuntime, stateWeight] of contributors) {
      stateRuntime.state.motions.forEach((motion, index) => {
        const contribution = stateWeight * stateRuntime.weights[index];
        if (contribution <= 0) return;
        const slot = layer.slots[layer.slotOf.get(motion.clip.name)];
        slot.weight += contribution;
        slot.time = motionTime(stateRuntime, motion);
      });
    }
    writePoseWeights();
  }

  // createSkeletonPose layers blend one over another, so a normalized set of weights becomes a chain of lerp factors.
  function writePoseWeights() {
    let accumulated = 0;
    for (const slot of layer.slots) {
      const share = runtime.weight * slot.weight;
      if (layer.additive) {
        slot.poseWeight = share;
        continue;
      }
      const remaining = 1 - accumulated;
      slot.poseWeight = remaining > 0 ? Math.min(1, Math.max(0, share / remaining)) : 0;
      accumulated += share;
    }
  }

  return {
    begin() {
      begin();
      collect();
    },
    advance(deltaSeconds) {
      startTransition();
      advanceStateRuntime(runtime.current, parameters, deltaSeconds);
      for (const entry of runtime.fading) advanceStateRuntime(entry.stateRuntime, parameters, deltaSeconds);
      runtime.fadeElapsed += deltaSeconds;
      if (layer.followsRootMotion) {
        const progress = fadeProgress();
        runtime.rootTravel = [0, 0];
        for (const entry of runtime.fading) addRootTravel(entry.stateRuntime, entry.base * (1 - progress), runtime.rootTravel);
        addRootTravel(runtime.current, progress, runtime.rootTravel);
      }
      if (runtime.fading.length && runtime.fadeElapsed >= runtime.fadeDuration - FADE_EPSILON) {
        runtime.fading = [];
        runtime.fadeElapsed = 0;
      }
      collect();
    },
    // Root travel of the last step, [x, z] in metres, scaled by the layer weight.
    rootTravel() {
      return [runtime.rootTravel[0] * runtime.weight, runtime.rootTravel[1] * runtime.weight];
    },
    setWeight(weight) {
      runtime.weight = weight;
      writePoseWeights();
    },
    describe() {
      return {
        state: runtime.current.state.name,
        previousState: runtime.fading.length ? runtime.fading[runtime.fading.length - 1].stateRuntime.state.name : null,
        fade: runtime.fading.length ? fadeProgress() : null,
        phase: runtime.current.phase,
        weight: runtime.weight,
        clips: layer.slots.filter(slot => slot.weight > 0).map(slot => ({ clip: slot.clip.name, time: slot.time, weight: slot.weight })),
      };
    },
  };
}

const NO_ROOT_MOTION = Object.freeze({ delta: Object.freeze([0, 0]), distance: 0, speed: 0 });

function describeRootMotion(travel, deltaSeconds) {
  const distance = Math.hypot(travel[0], travel[1]);
  return Object.freeze({ delta: Object.freeze(travel), distance, speed: deltaSeconds > 0 ? distance / deltaSeconds : 0 });
}

// The layer whose travel becomes the root motion: the named one, else the first. Fails when no clip carries the bone's translation.
function chooseRootMotionLayer(settings, layers, clips) {
  const layer = settings.layer === undefined ? layers[0] : layers.find(candidate => candidate.name === settings.layer);
  if (!layer) {
    throw new RangeError(`createAnimationGraph rootMotion.layer names "${String(settings.layer)}", which is not a layer. Layers: ${layers.map(candidate => candidate.name).join(', ')}.`);
  }
  if (![...clips.values()].some(clip => clip.rootMotion)) {
    throw new RangeError(`createAnimationGraph rootMotion.bone "${settings.bone}" has no translation track in any clip. Name the bone that the clips move, as the track target.`);
  }
  return layer;
}

/**
 * Build a graph from { clips, parameters, boneGroups, layers }. `clips` maps a name to a clip (`createAnimationClip`,
 * `clipFromGltfAnimation` or `retargetClip` output; only `duration` and `loop` are read). `parameters` maps a name to
 * { type: 'number' | 'boolean' | 'trigger', initial }. Each layer is { name, states, transitions, initial, weight, mask,
 * additive }. The graph is deterministic: it reads no clock and no random source.
 */
export function createAnimationGraph(definition) {
  requireObject(definition, 'createAnimationGraph definition');
  const rootMotionSettings = definition.rootMotion === undefined ? null : normalizeRootMotionSettings(definition.rootMotion, 'createAnimationGraph rootMotion');
  const clips = compileClips(definition.clips ?? {}, rootMotionSettings);
  const parameters = compileParameters(definition.parameters ?? {});
  const boneGroups = requireObject(definition.boneGroups ?? {}, 'createAnimationGraph boneGroups');
  const layerDefinitions = requireArray(definition.layers, 'createAnimationGraph layers', ANIMATION_GRAPH_LIMITS.maximumLayers);
  const layers = layerDefinitions.map((layer, position) => compileLayer(layer, position, clips, parameters, boneGroups));
  const layerNames = new Set();
  for (const layer of layers) {
    if (layerNames.has(layer.name)) throw new RangeError(`createAnimationGraph has two layers named "${layer.name}". Rename one.`);
    layerNames.add(layer.name);
  }
  const rootMotionLayer = rootMotionSettings ? chooseRootMotionLayer(rootMotionSettings, layers, clips) : null;
  for (const layer of layers) layer.followsRootMotion = layer === rootMotionLayer;
  const runtimes = layers.map(layer => createLayerRuntime(layer, parameters));
  let elapsedSeconds = 0;
  let lastRootMotion = NO_ROOT_MOTION;

  function runtimeOf(name) {
    const index = layers.findIndex(layer => layer.name === name);
    if (index < 0) throw new RangeError(`No layer named "${String(name)}". Layers: ${layers.map(layer => layer.name).join(', ')}.`);
    return runtimes[index];
  }

  const graph = {
    get layers() { return layers.map(layer => layer.name); },
    get time() { return elapsedSeconds; },

    // Root travel of the last advance as { delta: [x, z], distance, speed } in metres: x to the right, negative z forward (the
    // player's convention), scaled by the layer weight. Needs the rootMotion option.
    get rootMotion() {
      if (!rootMotionSettings) throw new TypeError('graph.rootMotion needs the rootMotion option, for example createAnimationGraph({ rootMotion: { bone: "Root" }, ... }).');
      return lastRootMotion;
    },

    // Sets a number or boolean parameter. Read by the transitions and blend spaces on the next advance.
    set(name, value) {
      const parameter = parameterOf(parameters, name, 'graph.set name');
      if (parameter.type === 'trigger') throw new TypeError(`Parameter "${name}" is a trigger. Call graph.trigger("${name}") instead.`);
      if (parameter.type === 'boolean' && typeof value !== 'boolean') throw new TypeError(`Parameter "${name}" is a boolean; pass true or false, got ${describe(value)}.`);
      if (parameter.type === 'number') requireFiniteNumber(value, `Parameter "${name}"`);
      parameter.value = value;
      return graph;
    },

    // Raises a trigger. It stays raised until a transition that lists it fires, or until reset(name).
    trigger(name) {
      const parameter = parameterOf(parameters, name, 'graph.trigger name');
      if (parameter.type !== 'trigger') throw new TypeError(`Parameter "${name}" is a ${parameter.type}, not a trigger. Use graph.set("${name}", value).`);
      parameter.value = true;
      return graph;
    },

    // Puts one parameter back to its initial value (clears a raised trigger).
    resetParameter(name) {
      const parameter = parameterOf(parameters, name, 'graph.resetParameter name');
      parameter.value = parameter.initial;
      return graph;
    },

    get(name) {
      return parameterOf(parameters, name, 'graph.get name').value;
    },

    setLayerWeight(name, weight) {
      requireFiniteNumber(weight, `Layer "${name}" weight`, 0, 1);
      runtimeOf(name).setWeight(weight);
      return graph;
    },

    // Steps every layer by deltaSeconds: transitions are checked first, then clock, crossfade and weights move on.
    advance(deltaSeconds) {
      requireFiniteNumber(deltaSeconds, 'graph.advance deltaSeconds', 0, ANIMATION_GRAPH_LIMITS.maximumDeltaSeconds);
      for (const runtime of runtimes) runtime.advance(deltaSeconds);
      elapsedSeconds += deltaSeconds;
      if (rootMotionLayer) lastRootMotion = describeRootMotion(runtimes[layers.indexOf(rootMotionLayer)].rootTravel(), deltaSeconds);
      return graph;
    },

    // Back to the initial states, the initial parameter values and time 0.
    reset() {
      for (const parameter of parameters.values()) parameter.value = parameter.initial;
      for (const runtime of runtimes) runtime.begin();
      elapsedSeconds = 0;
      lastRootMotion = NO_ROOT_MOTION;
      return graph;
    },

    // The state a layer is in, its crossfade progress (null when not fading), and the clips it plays: [{ clip, time, weight }].
    layerState(name) {
      return runtimeOf(name).describe();
    },

    // One createSkeletonPose layer per clip of each graph layer, in order. Weight, clip time and mask follow the graph; build the pose once.
    poseLayers() {
      return layers.flatMap(layer => layer.slots.map(slot => ({
        clip: slot.clip.clip,
        weight: () => slot.poseWeight,
        clipTime: () => slot.time,
        ...(layer.mask ? { mask: layer.mask } : {}),
        ...(layer.additive ? { additive: true, reference: layer.reference } : {}),
      })));
    },

    // A runtime system (docs/runtime.md). Fixed steps advance the graph; in 'variable' mode the frame time does. `apply` runs every frame.
    system({ name = 'animation-graph', apply } = {}) {
      requireName(name, 'graph.system name');
      if (apply !== undefined && typeof apply !== 'function') throw new TypeError('graph.system apply must be a function (graph, context) or left out.');
      return {
        name,
        fixedUpdate(stepSeconds) {
          graph.advance(stepSeconds);
        },
        update(deltaSeconds, context) {
          if (context.mode === 'variable') graph.advance(deltaSeconds);
          apply?.(graph, context);
        },
      };
    },
  };

  graph.reset();
  return graph;
}
