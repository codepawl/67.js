// Runs in the page: a night street with a blast at the far end, drawn at any time with the air distortion and flash steps off or on.
import { Renderer67 } from '/src/renderer.js';
import { box } from '/src/geometry.js';
import { installCameraEffects } from '/src/camera-effects.js';
import { installPostSteps } from '/src/post-steps.js';

const BLAST_CENTRE = [0, 2.2, -16];

function placed(center, size) {
  return new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1]);
}

function streetParts() {
  const asphalt = { color: [0.1, 0.1, 0.11], metallic: 0, roughness: 0.85 };
  const kerb = { color: [0.45, 0.45, 0.47], metallic: 0, roughness: 0.8 };
  const paint = { color: [0.9, 0.9, 0.85], metallic: 0, roughness: 0.6 };
  const walls = [
    { color: [0.55, 0.42, 0.36], metallic: 0, roughness: 0.8 },
    { color: [0.4, 0.45, 0.5], metallic: 0, roughness: 0.8 },
    { color: [0.62, 0.58, 0.5], metallic: 0, roughness: 0.8 },
  ];
  const window = { color: [1, 0.85, 0.55], emissiveColor: [1, 0.85, 0.55], metallic: 0, roughness: 1, emission: 3 };
  const fire = { color: [1, 0.45, 0.1], emissiveColor: [1, 0.45, 0.1], metallic: 0, roughness: 1, emission: 16 };
  const parts = [
    { geometry: box(), matrix: placed([0, -0.05, -20], [9, 0.1, 80]), material: asphalt },
    { geometry: box(), matrix: placed([-6, 0.08, -20], [3, 0.3, 80]), material: kerb },
    { geometry: box(), matrix: placed([6, 0.08, -20], [3, 0.3, 80]), material: kerb },
  ];
  for (let index = 0; index < 16; index++) {
    parts.push({ geometry: box(), matrix: placed([0, 0.01, 8 - index * 4.5], [0.18, 0.02, 2]), material: paint });
  }
  for (let index = 0; index < 9; index++) {
    for (const side of [-1, 1]) {
      const height = 9 + ((index * 5 + (side > 0 ? 3 : 0)) % 7) * 2;
      const z = 6 - index * 8;
      parts.push({ geometry: box(), matrix: placed([side * 11, height / 2, z], [8, height, 7]), material: walls[(index + (side > 0 ? 1 : 0)) % 3] });
      for (let floor = 0; floor < 4; floor++) {
        for (let bay = 0; bay < 2; bay++) {
          parts.push({ geometry: box(), matrix: placed([side * 6.95, 3 + floor * 2.6, z - 1.7 + bay * 3.4], [0.08, 1.1, 1.6]), material: window });
        }
      }
    }
  }
  parts.push({ geometry: box(), matrix: placed([2.2, 0.8, -5], [1.8, 1.4, 4]), material: { color: [0.6, 0.1, 0.1], metallic: 0.4, roughness: 0.4 } });
  parts.push({ geometry: box(), matrix: placed([-2.4, 0.9, -10], [2, 1.6, 5]), material: { color: [0.15, 0.3, 0.55], metallic: 0.4, roughness: 0.4 } });
  parts.push({ geometry: box(), matrix: placed([BLAST_CENTRE[0], 1.2, BLAST_CENTRE[2]], [2.4, 2.4, 2.4]), material: fire });
  return parts;
}

const environment = { keyIntensity: 0.5, fillIntensity: 0.25, ambientIntensity: 0.25, lightDirection: [-3, 6, 4] };
const camera = { eye: [0, 2.4, 14], target: [0, 2.6, -16], fov: 50 };

function ramp(time, start, end) {
  return Math.min(1, Math.max(0, (time - start) / (end - start)));
}

// The steps at one instant: the flash and ring start at once, the heat haze builds up after them.
function airAt(time) {
  return {
    flash: { centre: BLAST_CENTRE, time, startTime: 0, attack: 0, decay: 0.15, intensity: 2.5, color: [1, 0.8, 0.5], radius: 30 },
    distortion: [
      { shape: 'ring', centre: BLAST_CENTRE, time, startTime: 0, speed: 45, thickness: 2.2, strength: 1, falloff: 0.6, maxRadius: 70, edge: 0.5 },
      { shape: 'haze', centre: [0, 3, -16], region: 'sphere', size: [5, 4, 5], noiseScale: 1.1, scroll: 3, time, strength: 0.9 * ramp(time, 0.3, 0.9) },
    ],
  };
}

let renderer = null;

function drawAt(time, withAir) {
  const canvas = document.querySelector('canvas');
  if (!renderer) {
    renderer = installCameraEffects(new Renderer67(canvas, streetParts(), { ground: false, hdr: true, depth: true, samples: 4, pixelRatio: 1, memoryBudgetMiB: 1024, environment }));
    installPostSteps(renderer);
    renderer.resize();
  }
  const effects = { ambientOcclusion: 0, bloom: { strength: 0.3, threshold: 1, radius: 1 }, ...(withAir ? airAt(time) : {}) };
  renderer.render({ ...camera, environment, time, exposure: 1, effects });
  const glError = renderer.context.getError();
  return { glError, image: canvas.toDataURL('image/png').split(',')[1] };
}

window.drawAt = drawAt;
