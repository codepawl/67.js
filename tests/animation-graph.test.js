import assert from 'node:assert/strict';
import test from 'node:test';
import { quat } from 'gl-matrix';
import { createAnimationClip } from '../src/animation.js';
import { ANIMATION_GRAPH_LIMITS, createAnimationGraph } from '../src/animation-graph.js';
import { createRuntime } from '../src/runtime.js';
import { createSkeletonPose } from '../src/skeleton-pose.js';

function poseClip(target, degrees, { duration = 1, loop = true } = {}) {
  const value = Array.from(quat.setAxisAngle(new Float64Array(4), [0, 0, 1], degrees * Math.PI / 180));
  return createAnimationClip({
    duration,
    loop,
    tracks: [{ target, property: 'rotation', keyframes: [{ time: 0, value }, { time: duration, value }] }],
  });
}

const CLIPS = {
  idle: poseClip('spine', 0, { duration: 2 }),
  walk: poseClip('spine', 30, { duration: 1 }),
  run: poseClip('spine', 60, { duration: 0.5 }),
  wave: poseClip('arm', 90, { loop: false }),
};

function locomotionDefinition(overrides = {}) {
  return {
    clips: CLIPS,
    parameters: { speed: { type: 'number' }, jump: { type: 'trigger' }, armed: { type: 'boolean' } },
    layers: [{
      name: 'base',
      states: [
        { name: 'idle', clip: 'idle' },
        { name: 'move', blend: { parameter: 'speed', motions: [{ clip: 'idle', threshold: 0 }, { clip: 'walk', threshold: 2 }, { clip: 'run', threshold: 6 }] } },
        { name: 'wave', clip: 'wave' },
      ],
      transitions: [
        { from: 'idle', to: 'move', when: [{ parameter: 'speed', greater: 0.1 }], duration: 0.2 },
        { from: 'move', to: 'idle', when: [{ parameter: 'speed', atMost: 0.1 }], duration: 0.2 },
        { from: '*', to: 'wave', when: [{ parameter: 'jump' }], duration: 0 },
      ],
    }],
    ...overrides,
  };
}

function clipWeights(graph, layer = 'base') {
  return Object.fromEntries(graph.layerState(layer).clips.map(entry => [entry.clip, entry.weight]));
}

function run(graph, steps, delta = 0.05) {
  for (let step = 0; step < steps; step++) graph.advance(delta);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

test('starts in the initial state and stays there without a matching condition', () => {
  const graph = createAnimationGraph(locomotionDefinition());
  run(graph, 10);
  assert.equal(graph.layerState('base').state, 'idle');
  assert.deepEqual(clipWeights(graph), { idle: 1 });
});

test('a parameter condition starts a transition that crossfades over fixed steps', () => {
  const graph = createAnimationGraph(locomotionDefinition());
  graph.set('speed', 2);
  graph.advance(0.05);
  let state = graph.layerState('base');
  assert.equal(state.state, 'move');
  assert.equal(state.previousState, 'idle');
  assert.ok(Math.abs(state.fade - 0.25) < 1e-9);
  run(graph, 2);
  assert.ok(Math.abs(graph.layerState('base').fade - 0.75) < 1e-9);
  graph.advance(0.05);
  state = graph.layerState('base');
  assert.equal(state.previousState, null);
  assert.equal(state.fade, null);
  assert.deepEqual(clipWeights(graph), { walk: 1 });
});

test('a crossfade blends the outgoing and incoming weights and they always sum to 1', () => {
  const graph = createAnimationGraph(locomotionDefinition());
  graph.set('speed', 6);
  for (let step = 0; step < 4; step++) {
    graph.advance(0.05);
    assert.ok(Math.abs(sum(Object.values(clipWeights(graph))) - 1) < 1e-9);
  }
  assert.deepEqual(clipWeights(graph), { run: 1 });
  graph.set('speed', 0);
  graph.advance(0.05);
  assert.equal(graph.layerState('base').state, 'idle');
  assert.ok(Math.abs(clipWeights(graph).run - 0.75) < 1e-9);
});

test('a transition waits for a running crossfade to end before the next one starts', () => {
  const graph = createAnimationGraph(locomotionDefinition());
  graph.set('speed', 2);
  graph.advance(0.05);
  graph.set('speed', 0);
  graph.advance(0.05);
  assert.equal(graph.layerState('base').state, 'move');
  run(graph, 3);
  graph.advance(0.05);
  assert.equal(graph.layerState('base').state, 'idle');
});

test('1D blend weights interpolate between thresholds and clamp outside them', () => {
  const graph = createAnimationGraph(locomotionDefinition({ layers: [{
    name: 'base',
    initial: 'move',
    states: [{ name: 'move', blend: { parameter: 'speed', motions: [{ clip: 'run', threshold: 6 }, { clip: 'idle', threshold: 0 }, { clip: 'walk', threshold: 2 }] } }],
  }] }));
  graph.set('speed', -5).advance(0.01);
  assert.deepEqual(clipWeights(graph), { idle: 1 });
  graph.set('speed', 1).advance(0.01);
  assert.deepEqual(clipWeights(graph), { idle: 0.5, walk: 0.5 });
  graph.set('speed', 5).advance(0.01);
  assert.deepEqual(clipWeights(graph), { walk: 0.25, run: 0.75 });
  graph.set('speed', 99).advance(0.01);
  assert.deepEqual(clipWeights(graph), { run: 1 });
});

test('blend space clips share one phase so the steps stay in sync', () => {
  const graph = createAnimationGraph(locomotionDefinition({ layers: [{
    name: 'base',
    states: [{ name: 'move', blend: { parameter: 'speed', motions: [{ clip: 'walk', threshold: 0 }, { clip: 'run', threshold: 1 }] } }],
  }] }));
  graph.set('speed', 0.5);
  run(graph, 5, 0.1);
  const [walk, fast] = graph.layerState('base').clips;
  assert.ok(Math.abs(walk.time / 1 - fast.time / 0.5) < 1e-9);
  assert.ok(walk.time > 0);
});

test('2D blend weights are 1 at a motion, local between motions, and sum to 1', () => {
  const graph = createAnimationGraph({
    clips: CLIPS,
    parameters: { strafe: { type: 'number' }, forward: { type: 'number' } },
    layers: [{
      name: 'base',
      states: [{ name: 'move', blend: { parameters: ['strafe', 'forward'], motions: [
        { clip: 'idle', position: [0, 0] }, { clip: 'walk', position: [0, 1] }, { clip: 'run', position: [1, 0] },
      ] } }],
    }],
  });
  graph.set('strafe', 0).set('forward', 1).advance(0.01);
  assert.deepEqual(clipWeights(graph), { walk: 1 });
  graph.set('forward', 0.5).advance(0.01);
  assert.deepEqual(clipWeights(graph), { idle: 0.5, walk: 0.5 });
  graph.set('strafe', 0.3).set('forward', 0.2).advance(0.01);
  const weights = clipWeights(graph);
  assert.equal(Object.keys(weights).length, 3);
  assert.ok(Math.abs(sum(Object.values(weights)) - 1) < 1e-9);
  assert.ok(weights.idle > weights.walk && weights.idle > weights.run);
  graph.set('strafe', 10).set('forward', 0).advance(0.01);
  assert.deepEqual(clipWeights(graph), { run: 1 });
});

test('a trigger fires once, is consumed, and any-state transitions work', () => {
  const graph = createAnimationGraph(locomotionDefinition());
  graph.trigger('jump').advance(0.05);
  assert.equal(graph.layerState('base').state, 'wave');
  assert.equal(graph.get('jump'), false);
  run(graph, 5);
  assert.equal(graph.layerState('base').state, 'wave');
});

test('exitPhase holds a transition until the state has played that far', () => {
  const graph = createAnimationGraph(locomotionDefinition({ layers: [{
    name: 'base',
    states: [{ name: 'wave', clip: 'wave' }, { name: 'idle', clip: 'idle' }],
    transitions: [{ from: 'wave', to: 'idle', exitPhase: 1, duration: 0.1 }],
  }] }));
  run(graph, 10, 0.05);
  assert.equal(graph.layerState('base').state, 'wave');
  run(graph, 11, 0.05);
  assert.equal(graph.layerState('base').state, 'idle');
});

test('a clip that does not loop holds its last frame', () => {
  const graph = createAnimationGraph(locomotionDefinition({ layers: [{ name: 'base', states: [{ name: 'wave', clip: 'wave' }] }] }));
  run(graph, 30, 0.1);
  assert.equal(graph.layerState('base').clips[0].time, 1);
});

test('speedParameter scales how fast a state plays', () => {
  const graph = createAnimationGraph({
    clips: CLIPS,
    parameters: { pace: { type: 'number', initial: 2 } },
    layers: [{ name: 'base', states: [{ name: 'walk', clip: 'walk', speedParameter: 'pace' }] }],
  });
  graph.advance(0.1);
  assert.ok(Math.abs(graph.layerState('base').clips[0].time - 0.2) < 1e-9);
});

test('layers run independent graphs and carry a bone mask resolved from a group', () => {
  const graph = createAnimationGraph(locomotionDefinition({
    boneGroups: { arms: { joints: ['arm'], exclude: ['hand'] } },
    layers: [
      { name: 'base', states: [{ name: 'walk', clip: 'walk' }] },
      { name: 'upper', mask: 'arms', weight: 0.5, states: [{ name: 'none', clip: 'idle' }, { name: 'wave', clip: 'wave' }], transitions: [{ from: 'none', to: 'wave', when: [{ parameter: 'armed', is: true }], duration: 0.1 }] },
    ],
  }));
  graph.set('armed', true);
  run(graph, 4, 0.05);
  assert.equal(graph.layerState('base').state, 'walk');
  assert.equal(graph.layerState('upper').state, 'wave');
  assert.equal(graph.layerState('upper').weight, 0.5);
  const layers = graph.poseLayers();
  assert.equal(layers.length, 3);
  assert.equal(layers[0].mask, undefined);
  assert.deepEqual(layers[1].mask, { joints: ['arm'], exclude: ['hand'] });
  assert.equal(layers[1].weight(), 0);
  assert.ok(Math.abs(layers[2].weight() - 0.5) < 1e-9);
  graph.setLayerWeight('upper', 1);
  assert.ok(Math.abs(layers[2].weight() - 1) < 1e-9);
});

test('poseLayers drive createSkeletonPose: a layer mask keeps the other bones on the base pose', () => {
  const graph = createAnimationGraph({
    clips: { still: poseClip('spine', 0), bend: poseClip('spine', 60), raise: poseClip('arm', 90) },
    parameters: { raised: { type: 'boolean' } },
    boneGroups: { arm: { joints: ['arm'] } },
    layers: [
      { name: 'base', states: [{ name: 'still', clip: 'still' }] },
      { name: 'upper', mask: 'arm', states: [{ name: 'down', clip: 'still' }, { name: 'raise', clip: 'raise' }], transitions: [{ from: 'down', to: 'raise', when: [{ parameter: 'raised' }] }] },
    ],
  });
  const rig = { joints: [
    { name: 'hips', parent: -1, translation: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    { name: 'spine', parent: 0, translation: [0, 0.3, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    { name: 'arm', parent: 1, translation: [0.2, 0.4, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  ] };
  const pose = createSkeletonPose({ rig, layers: graph.poseLayers() });
  graph.set('raised', true).advance(0.1);
  pose.apply(graph.time);
  const angleOf = rotation => 2 * Math.acos(Math.min(1, Math.abs(rotation[3]))) * 180 / Math.PI;
  assert.ok(Math.abs(angleOf(pose.localRotation(2)) - 90) < 1e-4);
  assert.ok(angleOf(pose.localRotation(1)) < 1e-4);
});

test('pose weights chain so blended clips match a direct weighted mix', () => {
  const graph = createAnimationGraph(locomotionDefinition({ layers: [{
    name: 'base',
    states: [{ name: 'move', blend: { parameter: 'speed', motions: [{ clip: 'idle', threshold: 0 }, { clip: 'walk', threshold: 2 }, { clip: 'run', threshold: 4 }] } }],
  }] }));
  graph.set('speed', 3).advance(0.01);
  const weights = graph.poseLayers().map(layer => Number(layer.weight().toFixed(6)));
  assert.deepEqual(weights, [0, 0.5, 1]);
});

test('the same parameter sequence gives identical weights and times', () => {
  const sequence = [0, 0.5, 2, 6, 6, 1, 0, 0, 3, 5, 0.05, 0, 0, 0, 2];
  const play = () => {
    const graph = createAnimationGraph(locomotionDefinition());
    return sequence.map(speed => {
      graph.set('speed', speed).advance(1 / 60);
      return JSON.stringify(graph.layerState('base'));
    });
  };
  assert.deepEqual(play(), play());
});

test('reset returns to the initial state, parameters and time', () => {
  const graph = createAnimationGraph(locomotionDefinition());
  graph.set('speed', 6).trigger('jump');
  run(graph, 10);
  graph.reset();
  assert.equal(graph.time, 0);
  assert.equal(graph.get('speed'), 0);
  assert.equal(graph.get('jump'), false);
  assert.equal(graph.layerState('base').state, 'idle');
});

test('the runtime system advances the graph on fixed steps and calls apply each frame', () => {
  const graph = createAnimationGraph(locomotionDefinition());
  const applied = [];
  const runtime = createRuntime({ render() {} }, {
    mode: 'both',
    fixedRate: 20,
    scheduler: { request: () => 1, cancel() {} },
    systems: [graph.system({ apply: (target, context) => applied.push(context.elapsedSeconds) })],
  });
  graph.set('speed', 2);
  runtime.step(100);
  assert.ok(Math.abs(graph.time - 0.1) < 1e-9);
  assert.equal(graph.layerState('base').state, 'move');
  assert.equal(applied.length, 1);
  runtime.dispose();
});

test('mistakes throw errors that name the field and the fix', () => {
  const failing = (mutate, pattern) => assert.throws(() => createAnimationGraph(mutate(locomotionDefinition())), pattern);
  failing(definition => ({ ...definition, layers: [] }), /layers must be an array of 1 to 8/);
  failing(definition => { definition.layers[0].states[0].clip = 'missing'; return definition; }, /states\[0\]\.clip names "missing".*Declared: idle, walk, run, wave/);
  failing(definition => { definition.layers[0].transitions[0].to = 'nowhere'; return definition; }, /transitions\[0\]\.to names "nowhere"/);
  failing(definition => { definition.layers[0].transitions[0].when = [{ parameter: 'speed' }]; return definition; }, /needs exactly one of greater, atLeast/);
  failing(definition => { definition.layers[0].transitions[0].when = [{ parameter: 'ghost', is: true }]; return definition; }, /parameter "ghost", which is not declared/);
  failing(definition => { definition.layers[0].states[1].blend.motions[1].threshold = 0; return definition; }, /two motions at threshold 0/);
  failing(definition => { definition.layers[0].states[0].blend = {}; return definition; }, /exactly one of clip/);
  failing(definition => { definition.layers[0].mask = 'head'; return definition; }, /bone group "head"/);
  failing(definition => { definition.layers[0].transitions[0].from = 'move'; definition.layers[0].transitions[0].to = 'move'; return definition; }, /to itself/);
  const graph = createAnimationGraph(locomotionDefinition());
  assert.throws(() => graph.set('jump', true), /Call graph\.trigger\("jump"\)/);
  assert.throws(() => graph.set('speed', Number.NaN), /Parameter "speed" must be a finite number/);
  assert.throws(() => graph.set('armed', 1), /pass true or false/);
  assert.throws(() => graph.trigger('speed'), /not a trigger/);
  assert.throws(() => graph.layerState('top'), /No layer named "top"\. Layers: base/);
  assert.throws(() => graph.advance(-1), /graph\.advance deltaSeconds/);
});

test('counts stay bounded', () => {
  const states = Array.from({ length: ANIMATION_GRAPH_LIMITS.maximumStates + 1 }, (_, index) => ({ name: `s${index}`, clip: 'idle' }));
  assert.throws(() => createAnimationGraph({ clips: CLIPS, layers: [{ name: 'base', states }] }), /states must be an array of 1 to 64/);
});
