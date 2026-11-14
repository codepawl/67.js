# Vehicle kit

`crucible/addons/vehicle` is available from version `0.10.0`.
It animates a wheeled vehicle along a path without physics.
Sampling the same time always returns the same pose, so frames can be rendered in any order.

```js
import { createVehicleRig, driveAlongPath, applyVehiclePoseToParts } from 'crucible/addons/vehicle';

const rig = createVehicleRig({ parts: vehicleParts });          // wheels found by name and geometry
const drive = driveAlongPath(rig, [[0, 0, -20], [5, 0, 0], [0, 0, 20]], {
  cruiseSpeed: 9,
  acceleration: 3,
  braking: 4,
  maxLateralAcceleration: 5,
  groundHeight: (x, z) => terrainHeight(x, z),
});

const pose = drive.sample(seconds);
applyVehiclePoseToParts(rig, pose);
renderer.updateParts(allParts);
```

## Conventions

- Metres, +Y up, right-handed. Angles are radians.
- The model's forward axis is `+z` unless `forwardAxis` is `'+x'`, `'-x'` or `'-z'`.
  Left is `up x forward`, so left is `+x` when forward is `+z`.
- The rig builds a local frame on the ground under the centroid of the wheel centers, then moves the whole model with it.
  The model can sit anywhere in its own space; poses are relative to its authored rest position.
- `pose.heading` is yaw about +Y, zero when facing +z. `pitch` is positive nose up. `roll` is positive when the left side rises (leaning right), which is what a left turn produces.
- Steering is positive toward the left.

A boat is not a wheeled vehicle: it floats on the ocean and is steered by forces at the stern, as a `boat` controller live and as keyframed controls in a bake. See [Boats and wakes](physics.md#boats-and-wakes) and the [boat controller](player.md#boat-controller).

## Describing the vehicle

`createVehicleRig({ parts | graph | asset, body, wheels, forwardAxis, wheelbase, maxSteerAngle })` takes exactly one source.

| Source | Moved through | Wheel and body references |
| --- | --- | --- |
| `parts` | `part.matrix` | part objects, names or indices |
| `graph` | `node.localMatrix` of a scene graph | node names |
| `asset` | node overrides of a `loadGltf` asset | node labels or ids such as `node-3` |

| Option | Default | Meaning |
| --- | --- | --- |
| `wheels` | `'auto'` | `'auto'` or an array of `{ id, part \| node \| targets, side, axle, radius, center, steerable, spinSign }` |
| `body` | everything that is not a wheel (roots for graphs and assets) | Array of parts or nodes that move rigidly |
| `forwardAxis` | `'+z'` | Model forward direction |
| `wheelbase` | measured front axle to rear axle | Metres, needed when the axles cannot be measured |
| `maxSteerAngle` | 35 degrees | Clamp for the steering angle |
| `lights` | none | Headlights and tail lights, see Lights |

Per wheel: `side` is `left`, `right` or `center`, `axle` is `front` or `rear`; both are inferred from position when omitted.
`steerable` defaults to the front axle.
`radius` and `center` are measured from the geometry bounds when omitted.
`spinSign: -1` fixes a wheel whose model axis is mirrored.
A wheel can list several parts (tire, hub, bolts); they all spin and steer together.

### Automatic wheels

`'auto'` matches wheel, tire/tyre, rim and hub names (`Wheel.001`, `FrontLeftWheel`, `tire_FR`, `RL_tyre`).
It reads corners from `FL FR RL RR`, `front/rear/back` and `left/right`, groups pieces of one corner, and attaches unnamed pieces that sit inside a wheel.
Names with steering, spare, fender, arch, brake, caliper, cover or similar words are rejected.
Check what was decided before trusting it:

```js
findWheelCandidates(names);        // { wheels: [{ name, kind, axle, side, corner }], rejected: [{ name, reason }] }
rig.wheels;                        // id, side, axle, radius, steerable, entries
rig.rejectedNames;                 // wheel-like names that were not treated as wheels
```

## Driving

`driveAlongPath(rig, path, options)` returns `{ sample(seconds), duration, length, rig }`.

The path is an array of `[x, y, z]` points (smoothed with a centripetal spline) or a camera path object, whose eye track is followed.
Speed is arc-length based. Give exactly one of:

| Option | Meaning |
| --- | --- |
| `speed` | Constant metres per second, no ramp |
| `cruiseSpeed` | Profile with `acceleration` (3), `braking` (4), `startSpeed` (0), `endSpeed` (0) and `maxLateralAcceleration` (unlimited) |

Other options: `startTime`, `groundHeight(x, z)`, `maxSteerAngle`, `rollGain` (0.012 rad per m/s2), `pitchGain` (0.012), `bounceFrequency` (1.6 Hz), `dampingRatio` (0.45), `suspensionTravel` (0.2 m), `pathSamples` (400, for camera paths).

`sample(seconds)` returns `{ time, distance, speed, direction, position, heading, pitch, roll, steerAngle, wheels: [{ id, spinAngle, steerAngle, suspensionOffset }], lights }`.

- Wheel spin is `distance / radius`; inside wheels in a corner turn slower by their lateral offset times the heading change.
- Steering uses a bicycle model: `pose.steerAngle` is `atan(wheelbase * curvature)`, clamped. By default each steerable wheel gets its own Ackermann angle `atan2(ahead * tan, wheelbase - sideways * tan)` about the same turning centre, from its measured offsets (`rig.wheelbase`, `rig.trackWidth`): at full lock the inner front wheel turns `atan(wheelbase / (R - track / 2))` and the outer `atan(wheelbase / (R + track / 2))`, with `R = wheelbase / tan(maxSteerAngle)`. Pass `steering: 'shared'` for one angle on every steerable wheel.
- Roll follows lateral acceleration and pitch follows longitudinal acceleration through a spring and damper. The response is integrated at a fixed step when the drive is created, so sampling order does not matter.
- With `groundHeight`, the body height and its slope pitch and roll are fitted to the ground under the four wheels, and each wheel gets a `suspensionOffset` so it touches the ground. Without it, height and slope come from the path.
- The vehicle holds the end of the path with zero speed. Use `cruiseSpeed` for a natural stop; a constant `speed` stops instantly and the body pitches accordingly.

## Reversing

`driveAlongLegs(rig, legs, options)` drives `[{ path, direction: 'forward' | 'reverse', pause }]` in order and takes the same options as `driveAlongPath`, which is the one-leg case.
The car stops at the end of every leg (only the first start and last end keep `startSpeed` and `endSpeed`), waits `pause` seconds (default 0), then starts the next leg.
A reverse leg's path is the way the car travels, so list its points in travel order from where the previous leg ended.
The car keeps facing the other way: heading is the path tangent plus a half turn, continuous at the stop, and steering and body roll flip so the same bend asks for the opposite lock.
`pose.distance` and `pose.speed` are signed along the car's forward axis and `pose.direction` is `1` or `-1`, so wheel spin runs backwards while reversing and spin times radius still equals `pose.distance`.

```js
const drive = driveAlongLegs(rig, [
  { path: [[0, 0, 0], [0, 0, 10]] },
  { path: [[0, 0, 10], [0, 0, 4]], direction: 'reverse', pause: 0.5 },
], { cruiseSpeed: 4, acceleration: 2, braking: 2 });
```

## Lights

Describe lamps once in `createVehicleRig({ lights })`:

| Field | Meaning |
| --- | --- |
| `headlights` | `[{ id, position, direction }]` in model space; `direction` defaults to the model forward axis |
| `tailLights` | `[{ id, part \| node \| targets, signal: 'brake' \| 'reverse', off, on }]`, the lamp material's emission strength at signal 0 and 1 (defaults 0 and 4) |

`pose.lights` is `{ brake, reverse, headlights: [{ id, position, direction }] }`.
Headlight positions and unit directions are in world space and follow the body, including pitch and roll.
`brake` is 0 to 1: the deceleration of the speed profile divided by `fullBrakeDeceleration` (default `braking`), so it is above 0 exactly while the car slows down, forwards or backwards.
A constant `speed` never decelerates, so its brake signal stays 0.
`reverse` is 1 while the car moves backwards.

`computeVehicleLightEmissions(rig, pose)` returns `[{ id, emission, entries }]` for any source.
`applyVehicleLightsToParts(rig, pose)` writes it to `part.material.emission` for a rig built from `parts` (give each lamp its own material, since parts sharing one material share the glow) and returns the parts; call `renderer.updateParts` after it.
Use the headlight poses to place spot lights; the pose carries no renderer state.

## Applying a pose

| Function | Effect |
| --- | --- |
| `applyVehiclePoseToParts(rig, pose)` | Writes `part.matrix`; then call `renderer.updateParts` |
| `applyVehiclePoseToSceneGraph(rig, pose, graph)` | Writes node `localMatrix`, calls `graph.update()` and returns `graph.parts` |
| `createVehicleNodeOverrides(rig, pose)` | Returns `nodeOverrides` (translation, rotation, scale) for `asset.stagePose` |
| `applyVehiclePoseToAsset(rig, pose, asset)` | Stages the overrides and commits them |

For imported GLBs, wheel and body nodes must be editable (positive translation, rotation, scale), and children of a moved node follow it.
Skinned vehicles are not driven by this addon.

## Driving through MCP

An agent drives a car GLB without code. The same entry works in two places.

- An asset recipe (`scene_create_asset`) takes `motion.drive`. `motion.duration` may be left out and becomes the drive time; the car holds the end of its path afterwards.
- A placed asset in a recipe scene takes `asset: { id, drive }`, with the path in the placement's own frame and scene time as drive time. The placement gets its own decoded copy, like one that plays a clip. Tail-light glow is not available there.

```json
{
  "motion": {
    "drive": {
      "legs": [
        { "path": [[0, 0, 0], [0, 0, 10], [4, 0, 16]] },
        { "path": [[4, 0, 16], [4, 0, 12]], "direction": "reverse", "pause": 0.5 }
      ],
      "cruiseSpeed": 6, "acceleration": 3, "braking": 4,
      "wheels": "auto",
      "lights": {
        "headlights": [{ "id": "left", "position": [0.5, 0.7, 2] }],
        "tailLights": [{ "material": "material-1", "signal": "brake", "off": 0.2, "on": 6 }]
      }
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `path` or `legs` | Exactly one. A path is `[x, y, z]` points or a camera path `{ duration, eye: { keyframes } }`. A leg is `{ path, direction: 'forward' \| 'reverse', pause }` |
| `speed` or `cruiseSpeed` | As in `driveAlongPath`, with `acceleration`, `braking`, `startSpeed`, `endSpeed`, `maxLateralAcceleration`, `startTime`, `fullBrakeDeceleration` |
| `wheels` | `'auto'` (default) or `[{ id, node \| nodes, side, axle, radius, center, steerable, spinSign }]`, where nodes are labels or `node-N` ids |
| `body`, `forwardAxis`, `wheelbase`, `maxSteerAngle`, `steering`, `rollGain`, `pitchGain` | As in `createVehicleRig` and `driveAlongPath` (angles in radians) |
| `lights.headlights` | `[{ id, position, direction }]` in model space; poses are reported, place a spot light from them |
| `lights.tailLights` | `[{ material, signal: 'brake' \| 'reverse', off, on }]`: the material id (the lamp needs an `emissiveColor`) gets `emission` from `off` to `on` with the signal |

Nodes that the drive moves (the body roots and the wheels) must not also be keyed by `tracks`.
Sampling is a pure function of time, so `scene_review`, renders and seeks in any order show the same pose.

`scene_inspect kind: "hierarchy"` on an asset recipe returns `motionDrive`; on a recipe scene each entry of `assets` has `drive`:

```json
{ "wheels": [{ "id": "front-left", "side": "left", "axle": "front", "radius": 0.35, "steerable": true, "nodes": ["Wheel_FL"] }],
  "rejectedNames": [{ "index": 7, "name": "Steering_Wheel_Cover", "reason": "contains \"steering\", which does not roll with the wheel" }],
  "wheelbase": 2.4, "trackWidth": 1.4, "duration": 6.67, "length": 34.7,
  "lights": { "brake": 0, "reverse": 0, "headlights": [{ "id": "left", "position": [0.5, 0.7, 2], "direction": [0, 0, 1] }] },
  "speed": 0, "direction": 1 }
```

`wheels`, `rejectedNames`, `wheelbase`, `trackWidth`, `duration` and `length` describe the rig; `lights`, `speed` and `direction` are read at the current motion time.
Check `wheels` and `rejectedNames` before trusting `'auto'` on an unfamiliar model.

## Limits

- Kinematic only: no collisions, tire slip or jumps. Heading follows the path tangent (plus a half turn while reversing).
- Ground is sampled under the wheels as a plane fit, so sharp bumps narrower than the wheelbase show as suspension offsets, clamped to `suspensionTravel`.
- Rear-steered wheels get no Ackermann angle: the split is measured from the rear axle.
- Through MCP the tail lights drive materials of an asset recipe only (placed assets share their materials), and `groundHeight` is not available: the car follows the path heights.
- Nodes with a nonzero scene-graph `pivot` are rejected.
- Wheel radius from geometry assumes the wheel is round in the plane across its axle.
