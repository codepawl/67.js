# Animation curves

`createAnimationClip` accepts `LINEAR`, `STEP`, `SMOOTH` and `CUBICSPLINE` tracks.
Clips own immutable copies of their keyframes, values and tangents.
`sampleAnimationClip` returns independent scalar values or arrays.

```js
const clip = createAnimationClip({
  duration: 2,
  tracks: [{
    target: 'part',
    property: 'translation',
    interpolation: 'CUBICSPLINE',
    keyframes: [
      { time: 0, value: [0, 0, 0], inTangent: [0, 0, 0], outTangent: [4, 0, 0] },
      { time: 2, value: [2, 0, 0], inTangent: [0, 0, 0], outTangent: [0, 0, 0] },
    ],
  }],
});
```

## Tangent contract

Spline tracks need at least two keyframes.
Each keyframe must contain finite `inTangent` and `outTangent` values with the same shape as its value.
Scalar properties use numbers. Translation and scale use three components. Rotation uses four components in `[x, y, z, w]` order.

Tangents express component changes per second. Quaternion tangents are component derivatives, not angular velocities.

The spline uses the starting keyframe's outgoing tangent and the ending keyframe's incoming tangent.
The Hermite equation multiplies those derivatives by the segment duration.
Quaternion curves interpolate their components, then normalize the result, without changing endpoint signs.
These interpolation rules follow [glTF Appendix C](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#appendix-c-animation-sampler-interpolation-modes).

Keyframe rotation values retain the existing normalization behavior. Tangents retain their supplied magnitude.
`LINEAR` and `SMOOTH` rotations retain shortest-arc spherical interpolation.
`STEP` holds the preceding keyframe. Endpoints clamp, and looping wraps negative times and exact clip boundaries.

## Easing

A keyframe on a `LINEAR` or `SMOOTH` track can carry `easing`, which shapes the segment that starts at that keyframe.
Without it, `LINEAR` is a straight ramp and `SMOOTH` is smoothstep. With it, the easing replaces both.
The value is `linear`, `cubic-bezier(x1, y1, x2, y2)`, or `ease<In|Out|InOut><Family>`, where Family is `Sine`, `Quad`, `Cubic`, `Quart`, `Quint`, `Expo`, `Circ`, `Back`, `Bounce` or `Elastic`: `easeOutBack`, `easeInOutCubic`, `easeOutBounce`.
These are Blender's easing types (Sine, Quadratic, Cubic, Quartic, Quintic, Exponential, Circular, Back, Bounce, Elastic) with the CSS names. Every name matches Blender 5.2 within 1e-4 at 20 sample times (`tests/easing.test.js`, `scripts/blender-easing-golden.py`).
An unknown name throws a `RangeError` that lists the valid forms and suggests the right case.

`cubic-bezier` follows CSS: `x1` and `x2` stay in 0 to 1, `y1` and `y2` may leave 0 to 1 (from -4 to 5) to overshoot.
`easeInBack`, `easeOutBack` and `easeInOutBack` take an overshoot as `easeOutBack(3)` (0 to 10, default 1.70158). The Elastic easings take an amplitude and a period as `easeOutElastic(1.5, 0.4)`: the amplitude is a multiple of the change (1 to 10, default 1) and the period a fraction of the segment (0.05 to 2, default 0.3, or 0.45 for in-out). Blender stores both in absolute units, which are these numbers over a one-unit change in one frame. Arguments on any other easing throw.
Easing on `STEP` or `CUBICSPLINE` tracks throws. Rotations ease the slerp angle. Easing on the last keyframe is accepted and has no effect.
Camera channels and material tracks take the same fields. glTF has no easing, so GLB export writes an eased track as 32 linear samples per segment.

## Output constraints

Spline overshoot clamps emission to zero or greater and metallic to `[0, 1]`.
It clamps roughness to `[1e-8, 1]` and scale components to `1e-8` or greater.
These constraints protect Crucible material and positive-scale domains. They can flatten a curve near its limits.
Translation and generic `value` tracks keep their finite overshoot.

Nonfinite spline output and zero interpolated quaternions throw `RangeError`.
The player also rejects matrices that exceed the finite Float32 range.
A failed `apply()` leaves bound matrices and material properties unchanged.

## Playback buffers

`createAnimationPlayer` compiles target bindings and sampling buffers once.
Each `apply(time)` reuses transform arrays and composed matrix buffers.
It performs binary searches independently, so arbitrary seek order produces the same result.
Matrix identities and initial untracked transform components remain stable.

The player creates one shallow material copy for each target with material tracks during binding.
Additional players bound to the same target reuse that isolated material.
Animated targets therefore retain independent material properties even when their original material was shared or frozen.
Material identities remain stable during playback. Nested texture references stay shared.
Transform-only targets retain their original material objects.

## API design choice

| Shape | Example | Consequence |
| --- | --- | --- |
| Tangents in keyframes | `{ time, value, inTangent, outTangent }` | Supports JSON round trips, input validation and glTF derivative data. |
| Separate curve callback | `curve(time, output)` | Supports procedural curves but requires executable code and caller-managed state. |

Explicit tangent data keeps the existing track model and permits deterministic sampling without external callback state.
This unit does not add a mixer, skeletal animation, morph targets or glTF importer changes.

## Extrapolation and modifiers

A track in a recipe `motion` takes `extrapolation` and `modifiers`, after Blender's F-curve modifiers. Every sampler reads them the same way: `sampleMotion`, camera paths and render jobs. Each result depends only on the track and the time, so a seek backwards and a render give the same values. A clip that does not loop passes times past its duration to the tracks, so extrapolation and cycles work there; a looping clip wraps the time first.

- `extrapolation`: `constant` (default) holds the first and last value. `linear` continues the slope of the first or last segment. Not for rotation.
- Time modifiers run first, in listed order. `cycles` takes `before` and `after` (`repeat`, `offset`, `mirror` or `none`, default `repeat`) and `beforeCount` and `afterCount` (0 is forever; after the count the curve holds). `offset` adds the change from the first to the last key each cycle. `stepped` takes `step` seconds and `offset` and holds the curve for each step.
- Value modifiers run next, in listed order, on every component. `noise` adds smooth seeded noise: `scale` seconds per wobble, `strength`, `phase`, `seed`; each component gets its own noise. `generator` takes `coefficients` of a polynomial of time, lowest power first, and replaces the value, or adds with `additive: true`. `limits` clamps to `min` and `max`. `envelope` maps `referenceMin` to `referenceMax` (default -1 to 1) onto a `min` and `max` that change over `points: [{time, min, max}]`.
- Rotation tracks take only `cycles` (not `offset`) and `stepped`. At most 8 modifiers a track. Bad fields name the accepted ones.
- Library use: `createAnimationClip` accepts the same fields once `animation-modifiers.js` is imported; GLB export writes the keyframes only.

Camera shake: hold a camera still and add noise to its eye, with a faster, weaker noise on the target.

```json
{
  "duration": 4,
  "tracks": [
    { "kind": "camera", "property": "eye",
      "keyframes": [{ "time": 0, "value": [0, 1.6, 5] }],
      "modifiers": [{ "type": "noise", "scale": 0.12, "strength": 0.03, "seed": 11 }] },
    { "kind": "camera", "property": "target",
      "keyframes": [{ "time": 0, "value": [0, 1.5, 0] }],
      "modifiers": [{ "type": "noise", "scale": 0.07, "strength": 0.015, "seed": 12 }] }
  ]
}
```

A walk that travels: two keys on `translation` with `{ "type": "cycles", "before": "offset", "after": "offset" }` carry on forward past the last key by one stride per cycle. Stop motion: `{ "type": "stepped", "step": 0.0833 }` samples at 12 frames a second.
