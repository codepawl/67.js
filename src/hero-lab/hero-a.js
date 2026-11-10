// Direction A: one hero object. The camera follows the pointer with damping, so the robot seems to turn toward it.
import './lab.css';
import { vec3 } from 'gl-matrix';
import { Renderer67 } from '../renderer.js';
import { loadGltf } from '../gltf.js';
import { damp, prefersReducedMotion, showStageError, startLoop } from './stage.js';

const stage = document.querySelector('#stage');
const canvas = document.querySelector('#viewport');

const REST_YAW = 0.62;
const REST_PITCH = 0.2;
const YAW_RANGE = 0.55;
const PITCH_RANGE = 0.14;
const FOLLOW_RATE = prefersReducedMotion ? 14 : 5;
const SWAY_SPEED = 0.45;
const SWAY_AMOUNT = 0.07;

function measureBounds(parts) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const corner = vec3.create();
  for (const part of parts) {
    const positions = part.geometry.positions;
    const stride = Math.max(3, Math.floor(positions.length / 3 / 2000) * 3);
    for (let index = 0; index < positions.length; index += stride) {
      vec3.transformMat4(corner, positions.subarray(index, index + 3), part.matrix);
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis], corner[axis]);
        maximum[axis] = Math.max(maximum[axis], corner[axis]);
      }
    }
  }
  return { minimum, maximum };
}

async function start() {
  const asset = await loadGltf('/wall-e.glb');
  const bounds = measureBounds(asset.parts);
  const center = bounds.minimum.map((value, axis) => (value + bounds.maximum[axis]) / 2);
  const extent = Math.max(...bounds.maximum.map((value, axis) => value - bounds.minimum[axis]));
  const target = [center[0], center[1] - extent * 0.02, center[2]];
  const distance = extent * 2.35;
  const renderer = new Renderer67(canvas, asset.parts, {
    hdr: true,
    transparent: true,
    ground: false,
    samples: 4,
    pixelRatio: Math.min(devicePixelRatio, 1.5),
    memoryBudgetMiB: 256,
    shadowBounds: { target: center, eye: [center[0] - extent, center[1] + extent * 2, center[2] + extent], extent: extent * 1.5, near: extent * 0.01, far: extent * 8 },
  });

  const view = { yaw: REST_YAW, pitch: REST_PITCH, aim: { yaw: REST_YAW, pitch: REST_PITCH } };
  let pointerActive = false;

  window.addEventListener('pointermove', event => {
    pointerActive = true;
    const horizontal = event.clientX / innerWidth * 2 - 1;
    const vertical = event.clientY / innerHeight * 2 - 1;
    view.aim.yaw = REST_YAW + horizontal * YAW_RANGE;
    view.aim.pitch = REST_PITCH - vertical * PITCH_RANGE;
    loop.wake();
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => {
    pointerActive = false;
    view.aim.yaw = REST_YAW;
    view.aim.pitch = REST_PITCH;
    loop.wake();
  });

  const loop = startLoop(stage, (seconds, timestamp) => {
    const sway = pointerActive || prefersReducedMotion ? 0 : Math.sin(timestamp / 1000 * SWAY_SPEED * Math.PI * 2) * SWAY_AMOUNT;
    view.yaw = damp(view.yaw, view.aim.yaw + sway, FOLLOW_RATE, seconds);
    view.pitch = damp(view.pitch, view.aim.pitch, FOLLOW_RATE, seconds);
    const mobile = canvas.clientWidth <= 700;
    renderer.projection[8] = mobile ? 0 : -0.24;
    const horizontalReach = Math.cos(view.pitch) * distance * (mobile ? 1.25 : 1);
    renderer.render({
      target,
      eye: [
        target[0] + Math.sin(view.yaw) * horizontalReach,
        target[1] + Math.sin(view.pitch) * distance,
        target[2] + Math.cos(view.yaw) * horizontalReach,
      ],
      exposure: 1,
      effects: { vignette: 0.08, bloom: { strength: 0.12, threshold: 1.15, radius: 1 } },
    });
    // The robot rests once the camera has settled and the page has no motion left to show.
    return !(prefersReducedMotion && Math.abs(view.yaw - view.aim.yaw) < 0.0005 && Math.abs(view.pitch - view.aim.pitch) < 0.0005);
  });
  window.__heroState = { view, renderer };
}

start().catch(error => showStageError(stage, `Live view unavailable: ${error.message}`));
