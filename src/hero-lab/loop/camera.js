// Turns authored keyframes into a timed flight. The keys describe the route (eye, target, field of view at 0..1 along the
// flight); a Catmull-Rom curve through them is sampled into dense linear keyframes, and src/camera-path.js plays those back
// against time, so the flight has no corners and the same sampler is used everywhere else in the library.
import { createCameraPath } from '../../camera-path.js';
import { createCameraSpline } from '../camera-spline.js';

const SAMPLES_PER_FLIGHT = 48;

export function createFlight({ keys, duration, near = 0.1, far = 1000 }) {
  const route = createCameraSpline(keys);
  const eye = [];
  const target = [];
  const fov = [];
  for (let index = 0; index <= SAMPLES_PER_FLIGHT; index++) {
    const along = index / SAMPLES_PER_FLIGHT;
    const pose = route(along);
    const time = along * duration;
    eye.push({ time, value: pose.eye });
    target.push({ time, value: pose.target });
    fov.push({ time, value: pose.fov });
  }
  const path = createCameraPath({
    duration,
    eye: { interpolation: 'LINEAR', keyframes: eye },
    target: { interpolation: 'LINEAR', keyframes: target },
    fov: { interpolation: 'LINEAR', keyframes: fov },
    near,
    far,
  });
  const pose = { eye: [0, 0, 0], target: [0, 0, 0], up: [0, 0, 0] };
  return {
    duration,
    // The returned object is reused on every call; read it before sampling again.
    at(seconds) {
      return path.sample(Math.max(0, Math.min(duration, seconds)), pose);
    },
  };
}
