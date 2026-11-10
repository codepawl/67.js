# Animation graph: states, blend spaces and layers

`67js/addons/animation-graph` plays clips from live game state. Game logic sets parameters such as `speed` or `grounded`; the graph moves between states, blends clips and says which clip plays at which time and weight. It loads only when imported, adds no dependency and does not touch the film path, where `createAnimationMixer` still plays clips at absolute times.

The graph knows no rig. It reads only `duration` and `loop` from a clip, so a clip from `clipFromGltfAnimation`, `retargetClip` or `createAnimationClip` all work, and one graph can drive any rig whose clips are mapped to it. `graph.poseLayers()` hands the result to `createSkeletonPose` or `createAssetPose` (see [skeleton pose](skeleton-pose.md)), which writes the skin or the node transforms.

```js
import { createAnimationGraph } from '67js/addons/animation-graph';
import { createAssetPose } from '67js/addons/skeleton-pose';
import { createRuntime } from '67js/addons/runtime';

const graph = createAnimationGraph({
  clips: { Idle, Walking, Running, Wave },          // name -> clip
  parameters: { speed: { type: 'number' }, wave: { type: 'trigger' } },
  boneGroups: { upperBody: { joints: ['spine'], exclude: ['head'] } },
  layers: [
    {
      name: 'locomotion',
      states: [{
        name: 'move',
        blend: { parameter: 'speed', motions: [
          { clip: 'Idle', threshold: 0 }, { clip: 'Walking', threshold: 2.2 }, { clip: 'Running', threshold: 5.5 },
        ] },
      }],
    },
    {
      name: 'gesture',
      mask: 'upperBody',
      states: [{ name: 'none', clip: 'Idle' }, { name: 'wave', clip: 'Wave' }],
      transitions: [
        { from: 'none', to: 'wave', when: [{ parameter: 'wave' }], duration: 0.15 },
        { from: 'wave', to: 'none', exitPhase: 1, duration: 0.15 },
      ],
    },
  ],
});

const pose = createAssetPose(character, { layers: graph.poseLayers() });
const runtime = createRuntime(renderer, {
  fixedRate: 60,
  frame: () => { pose.apply(graph.time); renderer.updateParts(character.parts); return camera; },
  systems: [gameSystem, graph.system()],
});

graph.set('speed', 3.1);   // from game logic, any time
graph.trigger('wave');
```

A runnable sample is `bench/animation-graph/index.html` (`npm run dev`, then open `/bench/animation-graph/`): the CC0 RobotExpressive blends Idle, Walking and Running by speed. W walks, Shift runs, `?speed=3.5` pins the speed.

With the [player](player.md), copy its state into parameters in a system placed between the controller and the graph:

```js
const parameterSystem = {
  name: 'animation-parameters',
  fixedUpdate() {
    graph.set('speed', controller.state.speed);
    graph.set('airborne', controller.state.airborne);
  },
};
// systems: [input, controller, parameterSystem, graph.system()]
```

## Parameters

`parameters` maps a name to `{ type, initial }`.

| `type` | Set with | Notes |
| --- | --- | --- |
| `'number'` | `graph.set(name, number)` | Finite. Default 0. |
| `'boolean'` | `graph.set(name, true or false)` | Default false. |
| `'trigger'` | `graph.trigger(name)` | Stays raised until a transition that lists it fires. `graph.resetParameter(name)` clears it. |

`graph.get(name)` reads one. Parameters are read at the next `advance`.

## States and blend spaces

A state is `{ name, clip }` or `{ name, blend }`, plus optional `speed` (play rate, default 1), `speedParameter` (a number parameter that multiplies it, for example to match walking pace to ground speed) and `loop` (default: the clip's `loop`, true for a blend space). A clip that does not loop holds its last frame.

- 1D: `blend: { parameter, motions: [{ clip, threshold }] }`. Weights interpolate linearly between the two nearest thresholds and clamp outside them.
- 2D: `blend: { parameters: [x, y], motions: [{ clip, position: [x, y] }] }`. Weights use gradient band interpolation: each motion is 1 at its own position, falls to 0 at every other motion, and stays local. Positions must differ.

Weights always sum to 1. All clips of a blend space share one normalized phase, and the phase advances at the blended duration, so walk and run steps stay in sync and the feet do not pop while the speed changes.

## Transitions

`{ from, to, when, exitPhase, duration }`, checked in order, first match wins. `from: '*'` (the default) matches any state.

- `when` is a list of conditions that must all hold. A number condition has exactly one of `greater`, `atLeast`, `less`, `atMost`, `equals`, `notEquals`. A boolean or trigger condition is `{ parameter, is: true }` (`is` defaults to true).
- `exitPhase` holds the transition until the source state has played that many cycles (1 is one full play of the clip). A transition needs `when`, `exitPhase` or both.
- `duration` is the crossfade in seconds (0 to 10, default 0 for a cut). Weights fade linearly over fixed steps. The outgoing state keeps the blend weights it had when the fade started, so a parameter change does not bend the fade.
- A new transition starts only when the current crossfade has ended. The longest wait is the fade time.

## Layers and masks

Each layer is its own graph with its own states and transitions, over a `mask`: a bone group name from `boneGroups`, or an inline `{ joints, descendants, exclude }` (same shape as the skeleton pose mask; joints are resolved by the pose, by joint or humanoid bone name). `weight` (0 to 1, `graph.setLayerWeight(name, w)`) fades the whole layer in and out. `additive: true` with `reference` (a clip time) adds the layer's change from that pose instead of blending. Layers run in order, later ones over earlier ones.

A clip has one time per layer. When both ends of a crossfade use the same clip, it plays at the incoming state's time.

## Runtime system and determinism

`graph.system({ name, apply })` is a [runtime system](runtime.md): fixed steps call `graph.advance(step)`, and in `'variable'` mode the frame time does. `apply(graph, context)` runs every frame in `'both'` and `'variable'` mode; in `'fixed'` mode do the pose in the runtime `frame` option as above. Put it after the systems that set parameters.

`advance(deltaSeconds)` checks transitions, then moves time, crossfades and weights. The graph reads no clock and no random source, so the same parameter sequence and step sizes always give the same weights and times. `graph.reset()` restores the initial states, parameters and time. Pose layers read the graph's live state, so call `pose.apply` after `advance`; unlike a bare skeleton pose, seeking backward means resetting and replaying.

## Reading the state

`graph.layerState(name)` returns `{ state, previousState, fade, phase, weight, clips: [{ clip, time, weight }] }`; `fade` is 0 to 1 during a crossfade and null otherwise. `graph.time` is the advanced time and `graph.layers` the layer names.

## Limits and errors

At most 64 parameters, 8 layers, 64 states and 256 transitions per layer, 8 conditions per transition and 16 motions per blend space. Errors name the field and the fix, for example `createAnimationGraph layers[0].transitions[1].to names "run", which is not a state of this layer. States: idle, move.`

Not part of this addon yet: root motion, IK hooks (use the `ik` option of the skeleton pose), and path-driven NPC speed. An NPC sets `speed` from its path follower, such as the navmesh, through the same `graph.set`.
