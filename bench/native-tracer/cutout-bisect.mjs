// Bisects a native cutout difference: one disc-masked card facing the camera, lit only by its own emission (no lights, no
// bounces), so the image is the alpha silhouette. With --ground the card also hangs over a ground plane lit by a sun, which
// adds the shadow rays. Prints how many pixels native and the CPU tracer disagree on (a pixel is "on" above half brightness).
//   node bench/native-tracer/cutout-bisect.mjs <output directory> [--ground] [--size 256]
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildNativeInput, traceNative } from '../../packages/render-native/index.mjs';
import { encodePng } from '../../src/export-png.js';
import * as pack from '../../src/path-tracer-gpu-pack.js';
import { createCamera, renderPathTracedImage, toneMapToRgba8 } from '../../src/path-tracer.js';
import { buildTraceScene } from '../../src/path-tracer-scene.js';

const argumentsGiven = process.argv.slice(2);
const outputDirectory = resolve(argumentsGiven[0]);
const withGround = argumentsGiven.includes('--ground');
const sizeIndex = argumentsGiven.indexOf('--size');
const size = sizeIndex >= 0 ? Number(argumentsGiven[sizeIndex + 1]) : 256;
const options = { width: size, height: size, samples: 32, bounces: 1, seed: 0, fireflyClamp: 20 };

const TEXTURE_SIZE = 64;
const data = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
for (let row = 0; row < TEXTURE_SIZE; row++) {
  for (let column = 0; column < TEXTURE_SIZE; column++) {
    const inside = Math.hypot((column + 0.5) / TEXTURE_SIZE - 0.5, (row + 0.5) / TEXTURE_SIZE - 0.35) < 0.4;
    data.set([255, 255, 255, inside ? 255 : 0], (row * TEXTURE_SIZE + column) * 4);
  }
}
const texture = { image: { data, width: TEXTURE_SIZE, height: TEXTURE_SIZE }, colorSpace: 'srgb', wrapS: 33071 };

function quad(corners) {
  return {
    positions: new Float32Array(corners.flat()),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

const cardMaterial = { color: [1, 1, 1], emissiveColor: [1, 1, 1], emission: withGround ? 0 : 1, roughness: 1, map: texture, alphaMode: 'mask', alphaCutoff: 0.5 };
const parts = [{ name: 'card', geometry: quad([[-1, 0.2, 0], [1, 0.2, 0], [1, 2.2, 0], [-1, 0.2 + 2, 0]].map((corner, index) => (index === 3 ? [-1, 2.2, 0] : corner))), material: cardMaterial }];
if (withGround) {
  const ground = quad([[-4, 0, 4], [4, 0, 4], [4, 0, -4], [-4, 0, -4]]);
  ground.normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
  parts.push({ name: 'ground', geometry: ground, material: { color: [0.8, 0.8, 0.8], roughness: 1 } });
}
const environment = { keyColor: withGround ? [3, 3, 3] : [0, 0, 0], lightDirection: [0.3, 0.9, 0.3], pointLights: [], areaLights: [] };
const cameraDescription = withGround ? { eye: [0, 3, 5], target: [0, 0.8, 0], fov: 50 } : { eye: [0, 1.2, 4], target: [0, 1.2, 0], fov: 40 };

await mkdir(outputDirectory, { recursive: true });
const scene = buildTraceScene(parts, environment);
const camera = createCamera(cameraDescription, size, size);
const traced = traceNative(buildNativeInput(scene, camera, options, pack), options);
const linear = new Float32Array(size * size * 3);
for (let pixel = 0; pixel < size * size; pixel++) linear.set(traced.rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
const native = toneMapToRgba8(linear, size, size, { viewTransform: 'aces', look: null });
const reference = (await renderPathTracedImage({ parts, environment, camera: cameraDescription }, { ...options, backend: 'cpu', denoise: false, threads: 8 })).rgba;
await writeFile(`${outputDirectory}/bisect-native${withGround ? '-ground' : ''}.png`, encodePng(native, size, size));
await writeFile(`${outputDirectory}/bisect-cpu${withGround ? '-ground' : ''}.png`, encodePng(reference, size, size));

let nativeOn = 0;
let referenceOn = 0;
let disagree = 0;
let meanDifference = 0;
for (let pixel = 0; pixel < size * size; pixel++) {
  const nativeValue = native[pixel * 4 + 1];
  const referenceValue = reference[pixel * 4 + 1];
  meanDifference += Math.abs(nativeValue - referenceValue) / 255;
  const nativeIsOn = nativeValue > 127;
  const referenceIsOn = referenceValue > 127;
  nativeOn += nativeIsOn ? 1 : 0;
  referenceOn += referenceIsOn ? 1 : 0;
  disagree += nativeIsOn === referenceIsOn ? 0 : 1;
}
console.log(JSON.stringify({ withGround, size, nativeOn, referenceOn, disagree, meanDifference: meanDifference / (size * size) }));
