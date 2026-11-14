# Player: controllers and camera rigs

`crucible/addons/player` gives a live game something to control and a camera that follows it. A controller is a [runtime](runtime.md) system that reads named [input](input.md) actions and axes and moves a body. A camera rig is a runtime system that places the camera. Both are swappable while the game runs, and a game can write its own with the same shape. The addon loads only when imported and adds no dependency.

```js
import { createRuntime } from 'crucible/addons/runtime';
import { createInput, keyboardSource } from 'crucible/addons/input';
import { createCharacterController, createFollowCamera } from 'crucible/addons/player';

const input = createInput({
  sources: [keyboardSource()],
  actions: { jump: ['keyboard/Space'], run: ['keyboard/ShiftLeft'] },
  axes: {
    moveX: ['keyboard/KeyD', { control: 'keyboard/KeyA', scale: -1 }],
    moveForward: ['keyboard/KeyW', { control: 'keyboard/KeyS', scale: -1 }],
    lookX: ['keyboard/ArrowRight', { control: 'keyboard/ArrowLeft', scale: -1 }],
    lookY: ['keyboard/ArrowUp', { control: 'keyboard/ArrowDown', scale: -1 }],
  },
});
const player = createCharacterController({ input, position: [0, 0, 3], ground: (x, z) => terrainHeight(x, z) });
const camera = createFollowCamera({ subject: player.state, input });
const runtime = createRuntime(renderer, {
  systems: [input, player, camera], // input, then controller, then rig
  frame: context => ({ ...camera.pose(context), time: context.elapsedSeconds }),
});
runtime.start();
```

Order the systems input, controller, rig. The controller reads this step's input, and the rig follows where the controller ended up.

## Character controller

`createCharacterController(options)` walks, runs and jumps. It accelerates toward the wanted velocity (less control in the air), turns the body toward where it moves, and applies gravity. Movement is relative to a view yaw: pass `cameraYaw` as a number or a function such as `() => runtime.getSystem('camera').yaw`, so the same keys work under every rig.

| Option | Default | Meaning |
| --- | --- | --- |
| `input` | required | The `createInput` object |
| `moveX`, `moveForward`, `jump`, `run` | same names | Names of the axes and actions it reads |
| `walkSpeed`, `runSpeed`, `jumpSpeed` | 3, 6, 7 | Units per second |
| `gravity`, `acceleration`, `airControl` | 20, 40, 0.3 | Air control scales acceleration while airborne |
| `radius`, `height`, `stepHeight` | 0.4, 1.8, 0.4 | Body size and the tallest step it climbs |
| `ground`, `obstacles` | 0, none | Passed to the built-in kinematic mover |
| `position`, `yaw` | origin, 0 | Start pose. Yaw 0 faces -Z, positive turns toward +X |
| `faceCamera`, `turnSpeed` | false, 12 | Face the view yaw (first person) or turn toward the move direction |
| `node` | none | An object with `position` (and `rotationY`) that is written every step |
| `rootMotion` | none | A function `() => [x, z]` with the travel of the last animation step, such as `() => graph.rootMotion.delta` ([animation graph](animation-graph.md#root-motion)). On the ground the body moves by it instead of by its speed; x is to its right, negative z forward |
| `mover` | kinematic | The seam for physics, see below |
| `name` | `player` | System name, for `replaceSystem` |

`controller.state` is updated in place for animation and audio: `position`, `previousPosition`, `velocity`, `yaw`, `grounded`, `airborne`, `speed` (horizontal), `intentSpeed` (the speed the input asks for) and `running`. `controller.positionAt(alpha)` returns the position drawn between the last two fixed steps, and `teleport(position, yaw)` places it again.

### Collide and slide

`createKinematicMover({ ground, obstacles })` is the default world. `ground` is a height or a heightfield function `(x, z) => height`. `obstacles` is up to 256 boxes `{ min: [x, y, z], max: [x, y, z] }`. The body is a vertical cylinder: x and z are resolved one after the other, so it slides along a wall; anything up to `stepHeight` above the feet is climbed, and a short drop snaps down. A move is split into pieces no longer than the radius, so a fast body does not tunnel through a thin wall. A box whose underside is out of reach does not block, so there is no ceiling. Every value is bounded and the result depends only on the inputs.

### Where physics plugs in

A mover is `{ move(body, displacement, stepSeconds) => { position, grounded } }`. `body` holds `position`, `velocity`, `radius`, `height`, `stepHeight` and `grounded`; `displacement` is the move the controller wants this step, gravity included. A physics engine implements `move` with its own character query and returns where the body ended up. The controller derives its velocity from the result and needs nothing else from it.

## Camera rigs

A rig follows a `subject`: a controller's `state` or any `{ position: [x, y, z], yaw }`. Each fixed step it reads the look axes and eases a focus point toward the subject (`followSeconds`, 0 for rigid). `rig.pose(context)` gives `{ eye, target, up }` for the frame, interpolated between fixed steps with `context.alpha`. `rig.yaw` and `rig.pitch` are readable and writable; positive pitch looks up for a first-person rig and puts the camera higher for the others.

- `createFollowCamera`: behind the subject at `distance` (5), `pitch` (0.35), aimed at `lookHeight` (1.5) above its feet. `clipEye(target, eye) => eye` is the seam for pulling the camera in against a world.
- `createFirstPersonCamera`: at `eyeHeight` (1.6) looking along yaw and pitch. Pair it with `faceCamera: true` on the controller and hide the body.
- `createTopDownCamera`: `distance` (12) above at a steep `pitch` (1.2). It does not turn unless you name `lookX`.

All three take `lookX` and `lookY` axis names (set one to `null` to turn it off), `lookSpeed` in radians per second, and `minimumPitch` and `maximumPitch`.

## Vehicle and flight controllers

Both read the same input names as the character controller, use the same `mover` seam, `node`, `position`, `yaw`, `teleport` and `positionAt`, and expose `state` for animation and audio.

`createVehicleController(options)`: an arcade car. `moveForward` is the throttle (negative reverses), `moveX` steers and the `jump` action brakes (rename them with `throttle`, `steer`, `brake`). Steering is a bicycle model: yaw rate is `speed / wheelbase * tan(steer)`. A wall removes the speed it blocks. Options: `maximumSpeed` (20), `reverseSpeed` (6), `acceleration` (12), `brakeDeceleration` (25), `coastDeceleration` (4), `wheelbase` (2.5), `maximumSteer` (0.6 rad), `steerSeconds` (0.15), `gravity`, `radius` (1), `height`, `stepHeight` (0.4). State: `forwardSpeed` (signed), `speed`, `steer` (-1 to 1, for wheel animation with [createVehicleRig](vehicle.md)), `yaw`, `grounded`, `airborne`, `braking`.

`createFlightController(options)`: free flight along the nose. `moveX` yaws, `moveForward` pitches (positive climbs), `run` boosts and `jump` brakes (`yawAxis`, `pitchAxis`, `boost`, `brake`). Speed eases between `brakeSpeed` (6), `cruiseSpeed` (14) and `boostSpeed` (24); pitch levels out after `levelSeconds` (0.6) with no input and is limited to `maximumPitch` (1.2). A wall stops it, the ground is skimmed, and a box that starts above its height is flown under. State: `pitch`, `roll` (bank, for animation), `speed`, `velocity`, `boosting`, `grounded`.

### Boat controller

`createBoatController({ input, physics, body, node })` drives a boat on the ocean. `moveForward` is the throttle (negative reverses) and `moveX` is the rudder (positive turns right); rename them with `throttle` and `rudder`. It pushes nothing itself: each fixed step it calls `physics.setBoatControls(body, { throttle, rudder })` on a [live physics system](physics-runtime.md) whose `body` floats with `float.boat` ([Boats and wakes](physics.md#boats-and-wakes)), then reads the hull pose back, so the hull bobs and rolls on the waves. List the physics system after the controller in the runtime. State: `position`, `yaw` (0 faces -Z), `pitch`, `roll`, `forwardSpeed` (signed), `speed`, `throttle`, `steer`. The hull cannot be teleported through the controller; set its pose in the physics system. Pair it with the `chase` camera. `startGame` does not build a boat yet, because its live physics (Jolt) has no buoyancy; build the system with `createPhysicsSystem` as above.

## More camera rigs

- `createOrbitCamera`: free look around the subject at `distance` (6). Name a `zoom` axis to change the distance between `minimumDistance` (1) and `maximumDistance` (50) at `zoomSpeed` (8) units per second.
- `createChaseCamera`: behind the subject like the follow rig, but the yaw swings round to `subject.yaw` over `yawFollowSeconds` (0.3). Use it for cars and flyers. It does not take look input unless you name `lookX`.
- `createSideScrollerCamera`: `distance` (10) away on +Z looking along -Z, at the subject's height plus `lookHeight` (1), leading the subject by up to `lookAhead` (2) units along its horizontal `velocity`.

### Camera collision

`createCameraClip({ obstacles, ground, padding })` returns a `clipEye(target, eye)` for any orbiting rig. It pulls the eye along the line to the target until it is `padding` (0.25) outside every obstacle box and above the ground, so the camera never ends up inside a wall or under the floor. A body pressed within `padding` of a wall leaves the camera at the target. When the target itself is inside a padded box, the eye collapses onto the target. A ground function that returns a non-finite height counts as height 0.

```js
const clip = createCameraClip({ obstacles, ground });
const camera = createChaseCamera({ subject: car.state, clipEye: clip });
```

## Custom kinds and swapping

`registerController(kind, factory)` and `registerCameraRig(kind, factory)` add a kind (up to 64 names, built-ins cannot be replaced). A controller factory returns a runtime system with `state.position` and a `fixedUpdate` or `update` function; a rig factory returns a system with `subject` and `pose(context) => { eye, target, up }`. `createController(kind, options)` and `createCameraRigOfKind(kind, options)` build one by name; `listControllerKinds()` and `listCameraRigKinds()` list them (`character`, `vehicle`, `flight`, `boat`; `follow`, `firstPerson`, `topDown`, `orbit`, `chase`, `sideScroller`).

`replaceController(runtime, name, kind, options)` swaps the controller system for another kind at the same position and yaw. `replaceCameraRig(runtime, name, kind, options)` swaps the rig and keeps its subject and yaw but not its input: pass `input` again in `options` if the new rig reads it. After a controller swap, point the rig at the new `state`:

```js
const car = replaceController(runtime, 'player', 'vehicle', { input });
replaceCameraRig(runtime, 'camera', 'chase', { subject: car.state, input });
```

## Swapping

Both swap with `runtime.replaceSystem(name, system)`. A new rig starts at the subject's yaw. A new controller starts where you put it, so pass the old `state.position`:

```js
runtime.replaceSystem('camera', createFirstPersonCamera({ subject: player.state, input }));
runtime.replaceSystem('player', createCharacterController({ input, position: [...player.state.position], runSpeed: 9 }));
```

## Limits and errors

Speeds up to 100, acceleration up to 1000, gravity up to 200, 256 obstacles, 64 sub-steps per move (`PLAYER_LIMITS`). Errors name the option and say what to pass, for example `createCharacterController walkSpeed must be a number from 0 to 100, got -1.`

A runnable sample is `bench/runtime-loop/index.html`: WASD walks a box over a wall and steps, Shift runs, Space jumps, and the buttons switch between a fixed view, follow, first-person and top-down cameras.
