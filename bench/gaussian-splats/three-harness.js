// Page of the Gaussian splat benchmark for three.js: the GaussianSplat object (installed three version, WebGPURenderer on its
// WebGL 2 backend) draws the same splats, as the same PLY bytes, from the same camera as harness.js. No recipe part: three.js has
// no Crucible scene, so the comparison is splats alone against splats alone (the "millipede-alone" case of harness.js).
import * as THREE from 'three/webgpu';
import { GaussianSplatPLYLoader } from 'three/addons/loaders/GaussianSplatPLYLoader.js';
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
import { millipedeMatrix, splatsToPly, syntheticRoom } from './scene-data.js';
import { parseGaussianSplatPly } from '/src/gaussian-splat-ply.js';

function median(values) {
  return values.slice().sort((first, second) => first - second)[Math.floor(values.length / 2)];
}

const synchronizationPixel = new Uint8Array(4);
const ORBIT_STEP = 0.04;

function cameraAt(angle, source) {
  const radius = source === 'synthetic' ? 3 : 4.2;
  const target = source === 'synthetic' ? [0, 1.5, 0] : [0, 1.3, -1];
  return { eye: [Math.sin(angle) * radius, 1.7, Math.cos(angle) * radius], target };
}

function pointCamera(camera, angle, source) {
  const { eye, target } = cameraAt(angle, source);
  camera.position.set(...eye);
  camera.lookAt(...target);
  camera.updateMatrixWorld(true);
}

async function plyBytesFor(source, count) {
  if (source === 'synthetic') return splatsToPly(syntheticRoom(count));
  const response = await fetch('/bench/gaussian-splats/data/millipede.ply');
  if (!response.ok) throw new Error('Run node bench/gaussian-splats/fetch-sample.mjs first');
  return response.arrayBuffer();
}

async function runCase({ source = 'synthetic', count = 100000, frames = 60, width = 960, height = 540, screenshot = true }) {
  const heapBefore = performance.memory?.usedJSHeapSize ?? 0;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  document.body.append(canvas);
  const renderer = new THREE.WebGPURenderer({ canvas, forceWebGL: true, antialias: true });
  await renderer.init();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.62, 0.7, 0.67);
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 200);
  const loadStart = performance.now();
  const bytes = await plyBytesFor(source, count);
  const geometry = new GaussianSplatPLYLoader().parse(bytes);
  const splats = new GaussianSplat(geometry, { autoSort: true });
  if (source === 'millipede') {
    const bounds = parseGaussianSplatPly(bytes).bounds;
    splats.matrixAutoUpdate = false;
    splats.matrix.fromArray(millipedeMatrix(bounds));
    splats.matrixWorldNeedsUpdate = true;
  }
  scene.add(splats);
  const prepareMilliseconds = performance.now() - loadStart;
  const gl = renderer.backend.gl;
  const frame = angle => {
    pointCamera(camera, angle, source);
    const start = performance.now();
    renderer.render(scene, camera);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, synchronizationPixel);
    return performance.now() - start;
  };
  for (let index = 0; index < 10; index++) frame(index * ORBIT_STEP);
  const orbitTimes = Array.from({ length: frames }, (_, index) => frame(index * ORBIT_STEP));
  const stillTimes = Array.from({ length: frames }, () => frame(0));
  const image = screenshot ? (frame(0.25), canvas.toDataURL('image/png').split(',')[1]) : null;
  const geometryBytes = Object.values(geometry.attributes).reduce((total, attribute) => total + attribute.array.byteLength, 0);
  const result = {
    engine: 'three', source, count: geometry.attributes.position ? geometry.attributes.position.count : 0, width, height,
    orbitMedianMilliseconds: Number(median(orbitTimes).toFixed(2)),
    stillMedianMilliseconds: Number(median(stillTimes).toFixed(2)),
    attributeMebibytes: Number((geometryBytes / 1048576).toFixed(1)),
    jsHeapDeltaMebibytes: Number((((performance.memory?.usedJSHeapSize ?? 0) - heapBefore) / 1048576).toFixed(1)),
    prepareMilliseconds: Number(prepareMilliseconds.toFixed(0)),
    glError: gl.getError(),
    threeRevision: THREE.REVISION,
    image,
  };
  renderer.dispose();
  canvas.remove();
  return result;
}

window.runCase = runCase;
window.harnessReady = true;
