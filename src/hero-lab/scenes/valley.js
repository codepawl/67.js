// Scene 1: the Silverwater valley at golden hour. Procedural, nothing to download.
// The camera starts high above the southern ridge line, looking along the valley at the snowfields, and glides north down the river to the footbridge.
import { mat4, quat } from 'gl-matrix';
import { Renderer67 } from '../../renderer.js';
import { createNatureWorld } from '../../nature.js';
import { box } from '../../geometry.js';
import { createCameraSpline } from '../camera-spline.js';

const GOLDEN = {
  daylight: 0.62,
  fogColor: [0.55, 0.36, 0.26],
  fogDensity: 0.0032,
  skyTop: [0.22, 0.32, 0.55],
  skyBottom: [1.0, 0.62, 0.36],
  lightDirection: [-0.78, 0.22, 0.42],
};

const cameraAt = createCameraSpline([
  { at: 0, eye: [16, 58, 52], target: [-4, 9, -80], fov: 36 },
  { at: 0.42, eye: [16, 17, 30], target: [-3, 5, -22], fov: 40 },
  { at: 0.78, eye: [5, 6.5, 16], target: [-3, 2.4, -6], fov: 40 },
  { at: 1, eye: [6.5, 3.4, 12], target: [-4.5, 1.8, -2], fov: 38 },
]);

export async function createScene(canvas) {
  const world = createNatureWorld();
  // The valley floor ends at a fixed edge; this meadow apron under it runs out to the haze so no view ends in an empty strip below the sky.
  const valleyFloor = world.parts.find(part => part.name === 'Wildflower valley');
  const apronMatrix = mat4.fromRotationTranslationScale(mat4.create(), quat.create(), [0, -1.25, -20], [1400, 1, 1200]);
  const apron = { name: 'Meadow apron', geometry: box(0.045, 2), matrix: apronMatrix, material: valleyFloor.material };
  const parts = [...world.parts, apron];
  const renderer = new Renderer67(canvas, parts, {
    world: true,
    ground: false,
    hdr: true,
    environment: { ...world.environment, ...GOLDEN },
    pixelRatio: Math.min(devicePixelRatio, 1.25),
    memoryBudgetMiB: 256,
    samples: 4,
  });
  return {
    label: 'Silverwater valley at golden hour',
    openHref: '/nature.html',
    ambient: true,
    staticProgress: 0.3,
    render(progress, seconds, override) {
      renderer.render({
        ...(override ?? cameraAt(progress)),
        time: seconds,
        wind: 0.35,
        waterRipple: [10000, 0, 10000],
        rippleTime: -1000,
        environment: { ...world.environment, ...GOLDEN },
        effects: { saturation: 1.1, contrast: 1.06, temperature: 0.06, vignette: 0.12, bloom: { strength: 0.16, threshold: 1.1, radius: 1.3 } },
      });
    },
    resize: () => renderer.resize(),
    dispose: () => renderer.dispose(),
  };
}
