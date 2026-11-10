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

A runnable sample is `bench/animation-graph/index.html` (`npm run dev`, then open `/bench/animation-graph/`): the CC0 RobotExpressive blends Idle, Walking and Running by speed. W walks, Shift runs, `?speed=3.5` pins the speed. The in-place clips get a root travel track at the stride pace, the graph extracts it and a character controller moves by it; the readout shows the root speed and the distance travelled.

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

To let the clips move the body instead, see [Root motion](#root-motion).

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
- A new transition starts only when the current crossfade has ended, unless it sets `interrupt: true` (see below).

## Layers and masks

Each layer is its own graph with its own states and transitions, over a `mask`: a bone group name from `boneGroups`, or an inline `{ joints, descendants, exclude }` (same shape as the skeleton pose mask; joints are resolved by the pose, by joint or humanoid bone name). `weight` (0 to 1, `graph.setLayerWeight(name, w)`) fades the whole layer in and out. `additive: true` with `reference` (a clip time) adds the layer's change from that pose instead of blending. Layers run in order, later ones over earlier ones.

A clip has one time per layer. When both ends of a crossfade use the same clip, it plays at the incoming state's time.

## Runtime system and determinism

`graph.system({ name, apply })` is a [runtime system](runtime.md): fixed steps call `graph.advance(step)`, and in `'variable'` mode the frame time does. `apply(graph, context)` runs every frame in `'both'` and `'variable'` mode; in `'fixed'` mode do the pose in the runtime `frame` option as above. Put it after the systems that set parameters.

`advance(deltaSeconds)` checks transitions, then moves time, crossfades and weights. The graph reads no clock and no random source, so the same parameter sequence and step sizes always give the same weights and times. `graph.reset()` restores the initial states, parameters and time. Pose layers read the graph's live state, so call `pose.apply` after `advance`; unlike a bare skeleton pose, seeking backward means resetting and replaying.

## Reading the state

`graph.layerState(name)` returns `{ state, previousState, fade, phase, weight, clips: [{ clip, time, weight }] }`; `fade` is 0 to 1 during a crossfade and null otherwise. `graph.time` is the advanced time and `graph.layers` the layer names.

## Interrupting a crossfade

A transition with `interrupt: true` may start while a crossfade is running, for example a jump or a hit that must not wait for a slow blend. The state that was fading in starts fading out from the weight it had reached, together with the shares of the states still fading out, so the pose does not pop; the new state fades in over its own `duration`. Weights keep summing to 1. At most 4 states fade out at once (`maximumFadingStates`); a longer chain drops the oldest and renormalizes the rest. A transition without `interrupt` still waits.

## Root motion

`rootMotion: { bone, layer, facing, scale }` takes the horizontal travel of the root bone out of the clips. The bone is the target of a `translation` track, such as the armature or hips. The graph reads those clips in place (the bone keeps its height but stays at its first-frame x and z, so `graph.poseLayers()` no longer slides the model) and `graph.rootMotion` says how far the root travelled in the last `advance`:

```js
graph.rootMotion; // { delta: [x, z], distance, speed } in metres; x is to the right, negative z is forward
```

The travel follows the blend: each clip's travel over the phase step it played, weighted like its pose, so a blend space walks at the speed its clips blend to. `layer` is the layer whose clips carry it (default: the first); its weight scales the result. `facing` is the way the rig faces at rest, `'+z'` (default, glTF) or `'-z'`, and `scale` converts clip units to metres (`0.01` for centimetres). Without the option `graph.rootMotion` throws. `extractRootMotion(clip, { bone, facing, scale })` does the same for one clip: it returns `{ clip, hasMotion, displacement(cycles, loops) }`.

Hand it to the [player](player.md) controller, which then moves by it on the ground instead of by its own speed, and put the graph after the controller so the controller reads the travel of the previous step:

```js
const controller = createCharacterController({ input, yaw: Math.PI, rootMotion: () => graph.rootMotion.delta });
const parameterSystem = {
  name: 'animation-parameters',
  fixedUpdate() { graph.set('speed', controller.state.intentSpeed); }, // what the player asks for, not the speed it has
};
// systems: [input, controller, parameterSystem, graph.system()]
```

The controller turns the travel by its yaw. It faces -Z at yaw 0 while a glTF model faces +Z, so start it at `yaw: Math.PI` or turn the model's node. In the air the controller falls back to its own velocity, and vertical motion always stays with the controller.

## IK hooks

`createFootPlacement` and `createLookAt` build entries for the `ik` list of `createSkeletonPose` and `createAssetPose`. They read the game through a function, ease toward it with the pose time, and are deterministic.

```js
const pose = createAssetPose(character, {
  layers: graph.poseLayers(),
  ik: [
    createFootPlacement({ root: 'UpperLegL', middle: 'LowerLegL', end: 'FootL', groundOffset: foot => heightAt(foot) - baseHeight }),
    createLookAt({ joints: ['Neck', 'Head'], target: () => targetPosition, maxAngle: 60, weight: () => graph.get('alert') }),
  ],
});
```

- `createFootPlacement({ root, middle, end, groundOffset, ankleHeight, liftHeight, maxAdjust, smoothSeconds, weight, pole, bendToward, groundNormal })`: `groundOffset(footPosition)` returns how far the ground under the animated foot is above (positive) or below the ground the clip was made for. A planted foot (near `ankleHeight`, within `liftHeight`, default 0.15) follows it by at most `maxAdjust` (default 0.4); a swinging foot is left alone. `smoothSeconds` (default 0.06) eases the correction.
- `createLookAt({ joints, target, forward, worldForward, maxAngle, smoothSeconds, weight })`: turns the chain from its base to the aiming joint toward a point or a function `(time, current) => [x, y, z]`, by at most `maxAngle` degrees (default 70) from the animated direction.

`weight` is a number or a function of the pose time from 0 to 1, so a graph parameter can fade a hook in and out. The positions are in the pose's space: the skeleton pose's model space, or the world space of the asset for `createAssetPose`.

## Other rigs

The graph knows no rig, so a creature or a machine runs the same way. The tests drive a quadruped (root, body, neck, head and four legs) and the car from the repo's test assets (wheels spinning while the body travels) through the same graph, root motion and IK hooks.

## NPC path follower

`createPathFollower({ graph, navmesh, position, yaw, cruiseSpeed })` walks an NPC along a path through the same graph. It writes its speed to the `speed` parameter, so idle, walk and run blend, and it moves by `graph.rootMotion`, so the feet do not slide. The graph needs the `rootMotion` option.

```js
const follower = createPathFollower({ graph, navmesh, position: [-16, 0, 0], yaw: Math.PI / 2, cruiseSpeed: 2.2 });
follower.goTo([16, 0]); // a navmesh route; follower.follow(points) takes any list of [x, z] or [x, y, z]
// systems: [follower.system(), graph.system()]; follower.state has position, yaw, speed and status
```

Each step it moves by the root motion of the last graph step, turned by its yaw as the [player](player.md) does, then steers to the next waypoint at `turnRate` and picks the speed for the next step: `cruiseSpeed` on a straight, lower toward a sharp corner (`cornerSlowDistance`), and in proportion to the distance inside `slowRadius` of the goal, never below `minimumSpeed`. A large heading error cuts the speed, so a sharp turn happens nearly in place. A corner counts as reached within `cornerRadius` or once passed, so the NPC rounds it on the outside. With a `navmesh`, a step into unwalkable ground slides along its edge (counted in `state.blockedSteps`). `status` becomes `"arrived"` within `arrivalRadius` of the last point and the parameter drops to 0; `stop()` returns to idle. `state.yaw` follows the player convention (0 faces -Z), so a glTF model needs `yaw + PI` about Y.

At most 256 waypoints and speeds up to 100. Errors name the option or point and what to pass. `bench/animation-graph/npc.html` shows the RobotExpressive walking a route around a wall.

## Limits and errors

At most 64 parameters, 8 layers, 64 states and 256 transitions per layer, 8 conditions per transition, 16 motions per blend space and 4 states fading out at once. Errors name the field and the fix, for example `createAnimationGraph layers[0].transitions[1].to names "run", which is not a state of this layer. States: idle, move.`


