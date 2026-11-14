# Camera paths

Available from version `0.4.0`.

`createCameraPath` samples camera position, target, vertical field of view and roll at an absolute time.
The trailer uses this API for every shot. Its atom and gadget shots use curved camera moves.

```js
import { createCameraPath, fovFromFocalLength } from 'crucible';

const path = createCameraPath({
  duration: 6,
  eye: {
    interpolation: 'CUBICSPLINE',
    keyframes: [
      { time: 0, value: [0, 2, 5], inTangent: [0, 0, 0], outTangent: [0, 0, 0] },
      { time: 3, value: [3, 2, 4], inTangent: [1, 0, -1], outTangent: [1, 0, -1] },
      { time: 6, value: [5, 2, 0], inTangent: [0, 0, 0], outTangent: [0, 0, 0] },
    ],
  },
  target: [0, 1, 0],
  fov: fovFromFocalLength(50, { sensorHeight: 24 }),
  near: 0.1,
  far: 100,
});

renderer.render(path.sample(3));
```

## Channels and time

`eye` and `target` accept a three-component vector or a keyframe channel.
`fov` and `roll` accept a number or a keyframe channel.
Channels support `LINEAR`, `STEP`, `SMOOTH` and `CUBICSPLINE`, using the existing animation sampler.
A keyframe on a `LINEAR` or `SMOOTH` channel can add `easing`, such as `easeInOutCubic` or `cubic-bezier(0.2, 0, 0, 1)`; see [animation curves](animation-curves.md#easing).

Cubic tangents use units per second. `fov` uses degrees, and `roll` uses radians around the viewing direction.
`up` is a constant vector. `near` and `far` are constant positive clipping distances.

The duration must be positive. Samples clamp to the duration unless `loop` is true.
Looping wraps negative times too. Matching end poses and tangents are the author's responsibility.

The path copies input vectors and keyframes. The returned `clip` is immutable. `JSON.stringify` can serialize it.

## Tracking and retained frames

The optional `targetMatrix` transforms the sampled target from local coordinates into world coordinates.
The optional `overrides` (`{ eye, target, fov, roll }`, where `eye` and `target` hold a number or `undefined` per axis) replace sampled values before the up vector is built; motion drivers use it, see [agent motion](agent-motion.md#drivers).
The eye remains in world coordinates. The caller supplies the current matrix explicitly, so seeking has no hidden playback state.

```js
const frame = {
  eye: new Float64Array(3),
  target: new Float64Array(3),
  up: new Float64Array(3),
};

path.sample(time, frame, { targetMatrix: graph.getNode('Actor').worldMatrix });
renderer.render(frame);
```

The output object and its vectors retain their identities. Samples still perform validation and allocate small temporary bookkeeping objects.
Without an output argument, each sample returns an independent frame.
Output vectors accept plain arrays, `Float32Array` or `Float64Array`. They must be writable and must not overlap.

Invalid poses and cubic lens overshoot throw before the frame changes.
Float32 outputs also reject positions that collapse into an identical eye and target after rounding.
A parallel up vector fails explicitly. This API does not choose a replacement orientation at camera poles.

## Framing a perspective camera

`fitPerspectiveDistance(bounds, view, aspect, padding = 1.15)` returns an eye-to-target distance that contains all eight corners of a world-space axis-aligned box. It preserves the camera direction, up vector and vertical field of view. The caller chooses the target. The bounds center provides a target for framing a subject.

```js
import { fitPerspectiveDistance } from 'crucible';

const bounds = { minimum: [-0.4, 0, -0.2], maximum: [0.4, 2, 0.25] };
const view = { eye: [0, 1, 4], target: [0, 1, 0], fov: 30, near: 0.1, far: 100 };
const aspect = canvas.clientWidth / canvas.clientHeight;
const distance = fitPerspectiveDistance(bounds, view, aspect);
const direction = view.eye.map((component, axis) => component - view.target[axis]);
const length = Math.hypot(...direction);
view.eye = view.target.map((component, axis) => component + direction[axis] / length * distance);
renderer.render(view);
```

Padding applies to horizontal and vertical projected extents. The helper uses `fov = 45`, `near = 0.1` and `far = 100` when omitted, matching ordinary renderer projection defaults. World scenes using a different far plane must supply it explicitly. Invalid bounds, degenerate orientation, impossible clipping and fitted eyes that collapse after Float32 rounding throw. Large world coordinates need a local origin. The helper cannot restore precision lost by GPU matrices.

The film addon accepts `sampleFilm(time, { aspect })`, defaulting to the authored 16:9 ratio. Narrow portrait shots keep their lens and blend toward centered subject framing as the aspect approaches square. Other narrow shots widen vertical field of view to retain authored horizontal coverage. Wide layouts retain the original camera. This is shot-specific framing, not automatic detection of subjects, animated bounds or occlusion.

## Lens conventions

`fovFromFocalLength` computes vertical field of view from focal length and sensor height.
Both arguments use the same unit, normally millimeters. The default sensor height is 24 mm.
The helper matches Three.js focal-length projection when its effective sensor height is the same.
It does not add depth of field, focus pulls or lens distortion.

## Design

| Alternative | Tradeoff |
| --- | --- |
| Mutable controller advanced by delta time | Convenient playback, but hidden target state makes arbitrary seeks harder. |
| Immutable channels sampled at absolute time | Reuses clip interpolation and gives identical results for the same inputs. |

The implementation uses immutable channels. Tracking matrices are separate sample inputs, rather than callbacks stored in the path.
This API provides camera authoring primitives. It does not provide a visual timeline editor or automatic collision avoidance.

Primary reference: [Three.js PerspectiveCamera](https://threejs.org/docs/pages/PerspectiveCamera.html).
