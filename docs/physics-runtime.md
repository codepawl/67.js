# Live physics

`67js/addons/physics-runtime` steps a physics world inside the [game loop](runtime.md). The recorded bake in [physics.md](physics.md) renders a film; this is for a browser game, where code pushes bodies, reads contacts and casts rays every frame. Both paths build the world with the same function, so a scene behaves the same on either.

```js
import { Renderer67 } from '67js';
import { createRuntime } from '67js/addons/runtime';
import { createPhysicsSystem } from '67js/addons/physics-runtime';

const physics = await createPhysicsSystem({
  bodies: [
    { name: 'floor', type: 'fixed', translation: [0, -0.5, 0] },
    { name: 'crate', translation: [0, 3, 0] },
  ],
  colliders: [
    { name: 'ground', body: 'floor', shape: 'cuboid', halfExtents: [10, 0.5, 10] },
    { name: 'crate', body: 'crate', shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5], mass: 1 },
  ],
});
physics.bind('crate', cratePart);
physics.on('contact', event => event.started && playThud(event.bodyA, event.bodyB));

const runtime = createRuntime(renderer, { fixedStepSeconds: physics.timestep, systems: [physics] });
runtime.start();
```

The definition is the one `createPhysicsScene` takes, without `events` (a live game has no tick script; call the methods below instead). Joints, force fields, sensors, collision groups and masks work as in [physics.md](physics.md).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `adapter` | `rapierAdapter` | The engine, see below |
| `timestep` | `1/60` | Seconds per step. The runtime's `fixedStepSeconds` must equal it; a mismatch throws and says which value to pass. |
| `bindings` | `[]` | `[{ body, part }]`, same as `physics.bind` |
| `name` | `'physics'` | The runtime system name |
| `solverIterations`, `maxBodies`, `maxColliders`, `maxJoints` | as in physics.md | Bounds and solver quality |

Put the system after input and before animation and game code in `systems`.

## Control

- `setKinematicPose(body, { translation, rotation })` moves a `kinematic` body; the world sees the move in the next step, and dynamic bodies resting on it are carried.
- `applyImpulse(body, impulse, point?)` and `setLinearVelocity(body, velocity)` act on a `dynamic` body.
- `getPose(body)` returns `{ translation, rotation }` as of the last step.
- `bind(body, part)` writes the body's pose to `part.matrix` (a retained `Float32Array(16)`, scale is kept). In `'both'` mode the pose is interpolated with `context.alpha`, so a 30 Hz simulation looks smooth on a 144 Hz screen.

## Events

`physics.on('contact', listener)` and `physics.on('sensor', listener)` return an unsubscribe function. After each step the listeners get, per pair:

```js
{ step, kind: 'contact' | 'sensor', started, colliderA, colliderB, bodyA, bodyB }
```

`started` is `true` when two colliders begin touching and `false` when they stop. A pair with a sensor collider is `'sensor'`. Within a pair `colliderA` is the lower collider index, and a step's events are sorted by `(colliderA, colliderB, started first)`, so every adapter fires the same sequence. `physics.events` holds the last step's events; `physics.eventsTruncated` is set if more than `maxContactEvents` (4096) arrived in one step.

## Queries

They read the world as the last step left it. Every query takes optional `{ mask, excludeBody, includeSensors }`: `mask` is a collision-group mask (0 to 65535), `excludeBody` skips one body (for example the player), and sensors are skipped unless `includeSensors` is `true`.

- `raycast(origin, direction, { maxDistance = 1000 })` returns the first hit or `null`: `{ body, collider, distance, point, normal }`. The direction need not be a unit vector.
- `shapeCast(shape, translation, direction, { maxDistance, rotation })` sweeps a shape and returns the first hit in the same form; `distance` is how far the shape's centre travelled.
- `overlap(shape, translation, { rotation })` returns the sorted names of the bodies that touch the shape.

A shape is `{ type: 'ball', radius }`, `{ type: 'cuboid', halfExtents }` or `{ type: 'capsule', halfHeight, radius }`.

## Engines

An adapter is `{ name, load?(), createWorld(prepared) }`. `prepared` is the validated scene (bodies, colliders, joints, fields, gravity). `createWorld` returns:

```js
{
  step(stepSeconds, elapsedSeconds), readPose(bodyIndex, out7), free(),
  setKinematicPose(bodyIndex, translation, rotation), setLinearVelocity(bodyIndex, velocity), applyImpulse(bodyIndex, impulse, point),
  drainEvents(callback(colliderIndexA, colliderIndexB, started)),
  raycast(origin, unitDirection, maxDistance, filter), shapeCast(shape, translation, rotation, unitDirection, maxDistance, filter),
  overlap(shape, translation, rotation, filter),
}
```

Bodies and colliders are addressed by their index in the definition; the system maps indices to names, validates every argument and orders events. `rapierAdapter` (Rapier, the default) and `joltAdapter` (Jolt) ship. The tests also run the system over a scripted adapter to prove it reads nothing else.

### Jolt

```js
import { createPhysicsSystem } from '67js/addons/physics-runtime';
import { joltAdapter } from '67js/addons/physics-jolt';

const physics = await createPhysicsSystem(definition, { adapter: joltAdapter });
```

`jolt-physics` (JoltPhysics built to wasm, MIT, install it with `npm install jolt-physics`) is an optional peer dependency of the `physics-jolt` addon; the core and the other addons never import it. The adapter covers bodies, sensors, collision groups and masks, kinematic control, force fields, ray, shape-cast and overlap queries, and contact and sensor events. What it does not cover yet throws an error that names the fix: joints, `cone` and `trimesh` colliders, and more than one collider per body. It also limits a scene to 256 distinct group and mask pairs. Engines differ in friction and restitution combining and in solver details, so a settled pose can differ between engines: a box that falls straight down settles within a few centimetres, but an offset cuboid rested at y 0.5 on one engine and 0.48 on the other, and a cylinder came to rest in different poses (Rapier tips and rolls it). Events are shown to match only for a dynamic box falling through a fixed sensor. For a kinematic body moving through a fixed sensor, Rapier gave no sensor events and Jolt did, so do not rely on kinematic-versus-fixed sensor events being the same on both engines. Jolt reports a contact as ended when a body falls asleep; the adapter hides that, so a sleeping box keeps its contact.

## Limits

At most 64 listeners per kind, 4096 bound parts, 1024 overlap results and a query distance up to 1,000,000. Counts of bodies, colliders and joints follow physics.md. `dispose()` (the runtime calls it) frees the world.

After every step the system checks each pose like the bake does: a non-finite position or a quaternion that is not unit length throws a `RangeError` naming the body and the step, so a bad pose never reaches a bound part. If setup throws (an unknown body in `bindings`, say), the engine world is freed before the error propagates.

Steps for 500 dynamic boxes settling on a floor, 120 steps after 10 warm-up steps, on one machine under load from other jobs (Node 24, wasm builds of both engines). The two engines are about equal on this scene: one loaded run gave Rapier 1.872 ms and Jolt 1.846 ms per step, and other runs swapped the order, so these figures show no winner. `tests/physics-jolt.test.js` prints the figures and asserts only that they are finite. The same file replays one scene on both engines (a box falls on a floor, is pushed through a sensor zone and leaves it) and asserts the same contact and sensor events in the same order, each within 3 steps of the other engine's step, and the final box position within 0.2 m. In the recorded run the events fired on identical steps: contact start at step 34, sensor start at 83, sensor stop at 121 on both, and the box stopped at x 6.499 on Rapier and 6.457 on Jolt.
