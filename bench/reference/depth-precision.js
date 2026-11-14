// Runs in the page: draws pairs of flush and near-flush planes and counts the pixels where the far plane wins (issue #310).
// The near plane is red and the far plane is blue; each pair is a pair of identical boxes whose near face sits `gap` closer to the camera.
import { CrucibleRenderer } from '/src/renderer.js';
import { box } from '/src/geometry.js';
import { installReversedDepth } from '/src/reversed-depth.js';

const DISTANCES = [1, 50, 500];
const GAPS_IN_METRES = [0, 0.0001, 0.001];
const CAMERA_JITTERS = 8;

function plane(name, color, distance, size) {
  const matrix = new Float32Array([size, 0, 0, 0, 0, size, 0, 0, 0, 0, 0.05, 0, distance * 0.85, 0, -distance, 1]);
  return { name, geometry: box(0, 32), matrix, material: { tag: 'surface', metallic: 0, roughness: 0.5, emission: 0, color } };
}

// The far plane is drawn second, which is the order that lets a tie go to the wrong surface under a LESS test.
function pairOfPlanes(distance, gap) {
  const size = distance * 2.2;
  return [plane('near', [1, 0, 0], distance - gap, size), plane('far', [0, 0, 1], distance, size)];
}

function countFarWins(context, width, height) {
  const pixels = new Uint8Array(width * height * 4);
  context.bindFramebuffer(context.FRAMEBUFFER, null);
  context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);
  let farPixels = 0;
  let nearPixels = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset];
    const blue = pixels[offset + 2];
    // The sky is neither, and a shadowed pixel is dark but keeps its hue: only a clearly red or clearly blue pixel counts.
    if (blue > 12 && blue > red * 2) farPixels++;
    if (red > 12 && red > blue * 2) nearPixels++;
  }
  return { farPixels, nearPixels };
}

// The camera looks across the planes at about 60 degrees from their normal, where the depth changes quickly from pixel to pixel.
function jitteredFrame(distance, jitter) {
  const offset = jitter * 0.013 * Math.min(distance, 10);
  return { eye: [offset, offset * 0.5, 0], target: [distance * 0.5 + offset, 0, -distance], up: [0, 1, 0], time: 0, wind: 0, exposure: 1 };
}

function measure(reversedDepth) {
  const results = [];
  for (const distance of DISTANCES) {
    for (const gap of GAPS_IN_METRES) {
      const canvas = document.querySelector('canvas');
      const renderer = new CrucibleRenderer(canvas, pairOfPlanes(distance, gap), { ground: false, hdr: false, depth: false, samples: 1, pixelRatio: 1, world: true, environment: { fogDensity: 0 } });
      if (reversedDepth) installReversedDepth(renderer, true);
      renderer.resize();
      const fractions = [];
      const covered = [];
      for (let jitter = 0; jitter < CAMERA_JITTERS; jitter++) {
        renderer.render(jitteredFrame(distance, jitter));
        renderer.render(jitteredFrame(distance, jitter));
        const { farPixels, nearPixels } = countFarWins(renderer.context, canvas.width, canvas.height);
        fractions.push(farPixels / Math.max(1, farPixels + nearPixels));
        covered.push((farPixels + nearPixels) / (canvas.width * canvas.height));
      }
      const mean = fractions.reduce((total, value) => total + value, 0) / fractions.length;
      results.push({ distance, gapMillimetres: gap * 1000, farWinsMean: mean, perJitter: fractions.map(value => Number(value.toFixed(3))), farWinsMinimum: Math.min(...fractions), farWinsMaximum: Math.max(...fractions), coveredMinimum: Math.min(...covered), glError: renderer.context.getError(), reversedDepth: renderer.reversedDepth });
      renderer.dispose();
    }
  }
  return results;
}

// One frame as a PNG data URL, to look at where the far plane wins.
window.drawDepthCase = (distance, gapMillimetres, jitter, reversedDepth) => {
  const canvas = document.querySelector('canvas');
  const renderer = new CrucibleRenderer(canvas, pairOfPlanes(distance, gapMillimetres / 1000), { ground: false, hdr: false, depth: false, samples: 1, pixelRatio: 1, world: true, environment: { fogDensity: 0 } });
  if (reversedDepth) installReversedDepth(renderer, true);
  renderer.resize();
  renderer.render(jitteredFrame(distance, jitter));
  renderer.render(jitteredFrame(distance, jitter));
  const image = canvas.toDataURL('image/png');
  renderer.dispose();
  return image;
};

window.measureDepthPrecision = () => {
  const probe = document.createElement('canvas').getContext('webgl2');
  return { extension: Boolean(probe.getExtension('EXT_clip_control')), before: measure(false), after: measure(true) };
};
