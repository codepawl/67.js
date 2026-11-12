import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import * as core from '../src/index.js';
import { loadGltf } from '../src/gltf.js';
import { createThreeCompat, unsupportedNames } from '../packages/three-compat/index.mjs';
import { snippets } from './fixtures/three-compat/snippets.mjs';

const THREE = createThreeCompat({ ...core, loadGltf });
const fakeCanvas = { style: {}, addEventListener() {} };
const fakeServices = { canvas: fakeCanvas, checkerboard: () => ({ width: 64, height: 64 }) };

function litScene(light) {
  const scene = new THREE.Scene();
  scene.add(light);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 50);
  camera.position.set(0, 1, 5);
  return { scene, camera };
}

test('the addon does not import three or the core by name', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../packages/three-compat/index.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m, 'the addon has no import statement');
  assert.throws(() => createThreeCompat({}), /needs the 67js export Renderer67/);
});

test('every snippet that needs no browser builds parts, an environment and a frame', async () => {
  const runnable = snippets.filter(snippet => !snippet.browserOnly);
  assert.ok(runnable.length >= 10);
  for (const snippet of runnable) {
    const { scene, camera } = await snippet.build(THREE, fakeServices);
    const { parts, environment, frame } = THREE.collectScene(scene, camera);
    assert.ok(parts.length >= 2, `${snippet.name} has parts`);
    assert.equal(new Set(parts.map(part => part.name)).size, parts.length, `${snippet.name} has unique part names`);
    for (const part of parts) {
      assert.equal(part.matrix.length, 16, `${snippet.name} ${part.name} has a 4 x 4 matrix`);
      assert.ok(part.matrix.every(Number.isFinite), `${snippet.name} ${part.name} matrix is finite`);
      assert.ok(part.geometry.positions.length > 0, `${snippet.name} ${part.name} has a geometry`);
      assert.ok(part.material.color.every(Number.isFinite));
    }
    assert.equal(frame.eye.length, 3);
    assert.equal(frame.target.length, 3);
    assert.ok(environment);
  }
});

test('a mesh matrix places and scales the unit geometry, in the order of three.js', () => {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  group.position.set(10, 0, 0);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6), new THREE.MeshStandardMaterial());
  mesh.position.set(1, 2, 3);
  group.add(mesh);
  scene.add(group);
  const { parts } = THREE.collectScene(scene, new THREE.PerspectiveCamera());
  const matrix = parts[0].matrix;
  assert.deepEqual([...matrix.slice(12, 15)], [11, 2, 3]);
  assert.deepEqual([matrix[0], matrix[5], matrix[10]], [2, 4, 6]);
});

test('Euler rotation XYZ turns a mesh like three.js does', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.rotation.z = Math.PI / 2;
  scene.add(mesh);
  const { parts } = THREE.collectScene(scene, new THREE.PerspectiveCamera());
  // A quarter turn about Z sends the X axis to Y.
  assert.ok(Math.abs(parts[0].matrix[1] - 1) < 1e-6);
  assert.ok(Math.abs(parts[0].matrix[4] + 1) < 1e-6);
});

test('MeshStandardMaterial and MeshPhysicalMaterial become 67js materials in linear colour', () => {
  const standard = new THREE.MeshStandardMaterial({ color: 0xff8000, metalness: 0.7, roughness: 0.2, emissive: 0x00ff00, emissiveIntensity: 2, side: THREE.DoubleSide }).toMaterial();
  assert.ok(Math.abs(standard.color[0] - 1) < 1e-6);
  assert.ok(Math.abs(standard.color[1] - 0.2158605) < 1e-5, 'sRGB 0x80 is linear 0.2159');
  assert.equal(standard.metallic, 0.7);
  assert.equal(standard.roughness, 0.2);
  assert.equal(standard.emission, 2);
  assert.deepEqual(standard.emissiveColor, [0, 1, 0]);
  assert.equal(standard.doubleSided, true);
  const physical = new THREE.MeshPhysicalMaterial({ clearcoat: 1, transmission: 0.5, ior: 1.4, specularIntensity: 0.8 }).toMaterial();
  assert.deepEqual([physical.clearcoat, physical.transmission, physical.ior, physical.specular], [1, 0.5, 1.4, 0.8]);
  const blended = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.3 }).toMaterial();
  assert.deepEqual([blended.alphaMode, blended.opacity], ['blend', 0.3]);
  const cutout = new THREE.MeshStandardMaterial({ alphaTest: 0.4 }).toMaterial();
  assert.deepEqual([cutout.alphaMode, cutout.alphaCutoff], ['mask', 0.4]);
});

test('lights fill the environment of the frame', () => {
  const directional = new THREE.DirectionalLight(0xffffff, 3);
  directional.position.set(2, 4, 6);
  const { scene, camera } = litScene(directional);
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const lit = THREE.collectScene(scene, camera).environment;
  assert.deepEqual(lit.lightDirection, [2, 4, 6]);
  assert.equal(lit.keyIntensity, 3);
  assert.equal(lit.ambientIntensity, 0.5);
  assert.equal(lit.fillIntensity, 0, 'a scene with its own lights switches the studio fill off');

  const point = new THREE.PointLight(0xffffff, 12, 9);
  point.position.set(1, 2, 3);
  const pointEnvironment = THREE.collectScene(litScene(point).scene, camera).environment;
  assert.deepEqual(pointEnvironment.pointLights, [{ position: [1, 2, 3], color: [1, 1, 1], intensity: 12, range: 9 }]);
  assert.equal(pointEnvironment.keyIntensity, 0);

  const spot = new THREE.SpotLight(0xffffff, 50, 0, 0.5, 0.3);
  spot.position.set(0, 5, 0);
  const spotLight = THREE.collectScene(litScene(spot).scene, camera).environment.spotLights[0];
  assert.deepEqual(spotLight.direction, [0, -5, 0]);
  assert.deepEqual([spotLight.angle, spotLight.penumbra, spotLight.range], [0.5, 0.3, undefined]);

  const panel = new THREE.RectAreaLight(0xffffff, 5, 3, 2);
  panel.position.set(0, 3, 0);
  panel.lookAt(0, 0, 0);
  const area = THREE.collectScene(litScene(panel).scene, camera).environment.areaLights[0];
  assert.deepEqual([area.width, area.height, ...area.direction], [3, 2, 0, -3, 0]);

  const dark = THREE.collectScene(new THREE.Scene(), camera).environment;
  assert.equal(dark.keyIntensity, undefined, 'a scene with no light keeps the studio rig');
});

test('cameras become frames', () => {
  const perspective = new THREE.PerspectiveCamera(35, 2, 0.2, 80);
  perspective.position.set(1, 2, 3);
  perspective.lookAt(0, 0, 0);
  const frame = THREE.collectScene(new THREE.Scene(), perspective).frame;
  assert.deepEqual([frame.eye, frame.target, frame.fov, frame.near, frame.far], [[1, 2, 3], [0, 0, 0], 35, 0.2, 80]);

  const orthographic = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 50);
  orthographic.position.set(0, 0, 5);
  const orthographicFrame = THREE.collectScene(new THREE.Scene(), orthographic).frame;
  assert.equal(orthographicFrame.projection, 'orthographic');
  assert.equal(orthographicFrame.orthographicHeight, 6);
  assert.deepEqual(orthographicFrame.target, [0, 0, 4], 'a camera without lookAt looks down its -Z axis');
});

test('OrbitControls moves the camera around its target', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 4);
  const controls = new THREE.OrbitControls(camera, fakeCanvas);
  controls.target.set(0, 0, 0);
  controls.rotate(Math.PI / 2, 0);
  assert.ok(Math.abs(camera.position.x - 4) < 1e-6);
  assert.ok(Math.abs(camera.position.z) < 1e-6);
});

test('unsupported three.js names throw an error that names the 67js replacement', () => {
  const cases = [
    ['MeshBasicMaterial', /MeshStandardMaterial.*emission/],
    ['ShaderMaterial', /no custom shaders/],
    ['ConeGeometry', /createModel/],
    ['WebGLRenderTarget', /toBlob/],
    ['Fog', /fogDensity/],
    ['EffectComposer', /resolveEffects/],
    ['AnimationMixer', /createAnimationMixer/],
    ['TextureLoader', /material\.map/],
    ['SomethingElse', /not part of the common subset/],
  ];
  for (const [name, replacement] of cases) {
    assert.throws(() => THREE[name], error => error.message.includes(`THREE.${name}`) && replacement.test(error.message) && error.message.includes('if-you-know-three-js.md'), name);
  }
  assert.throws(() => new THREE.MeshStandardMaterial({ aoMap: {} }), /occlusionMap/);
  assert.throws(() => new THREE.CylinderGeometry(0, 1, 2), /createModel/);
  assert.throws(() => new THREE.MeshStandardMaterial({ side: THREE.BackSide }).toMaterial(), /doubleSided/);
  assert.throws(() => new THREE.Color('red'), /hex/);
  assert.throws(() => new THREE.Mesh({}, new THREE.MeshStandardMaterial()), /box\(\)/);
  assert.equal(THREE.then, undefined, 'lowercase names are plain properties');
});

test('every 67js call named by an error exists', () => {
  const known = new Set([...Object.keys(core), ...Object.getOwnPropertyNames(core.Renderer67.prototype), 'loadGltf', 'createModel', 'box', 'sphere', 'cylinder', 'torus', 'canvas.toBlob', 'Texture']);
  assert.ok(unsupportedNames.length >= 20);
  for (const name of unsupportedNames) {
    let message = '';
    try {
      THREE[name];
    } catch (error) {
      message = error.message;
    }
    assert.ok(message, `${name} throws`);
    for (const [, call] of message.matchAll(/([A-Za-z_.]+)\(/g)) {
      assert.ok(known.has(call) || known.has(call.split('.').at(-1)), `${name}: the error names ${call}, which is not a 67js export`);
    }
  }
});

// Draws every snippet in Chrome so each gets a real frame. It runs only when asked, because it needs a browser and a GPU:
//   RENDER_TESTS=1 node --test tests/three-compat.test.js
// CHROME_PATH names the browser. THREE_COMPAT_ANGLE picks the graphics backend (default d3d11 on Windows, vulkan elsewhere).
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const renderEnabled = process.env.RENDER_TESTS === '1' && existsSync(chromePath);

const snippetTimeoutMilliseconds = 20000;

// A snippet that never reports a frame fails by name instead of holding the whole test until its own timeout.
async function drawWithin(page, name, milliseconds) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`snippet "${name}" reported no frame within ${milliseconds} ms`)), milliseconds);
  });
  try {
    return await Promise.race([page.evaluate(snippetName => window.drawSnippet(snippetName), name), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test('each three.js-style snippet draws a frame through the addon', { skip: !renderEnabled, timeout: 300000 }, async () => {
  setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
  const { chromium } = await import('playwright');
  const { createServer } = await import('vite');
  const angle = process.env.THREE_COMPAT_ANGLE ?? (process.platform === 'win32' ? 'd3d11' : 'vulkan');
  const flags = ['--enable-webgl', '--ignore-gpu-blocklist', `--use-angle=${angle}`, '--enable-gpu', '--no-sandbox'];
  if (angle === 'vulkan') flags.push('--enable-features=Vulkan');
  const server = await createServer({ root: new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), server: { host: '127.0.0.1', port: 0, fs: { strict: false } }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: flags });
  try {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/three-compat/page.html`, { timeout: 60000 });
    await page.waitForFunction(() => window.drawSnippet, null, { timeout: 60000 });
    const hashes = new Set();
    for (const snippet of snippets) {
      const result = await drawWithin(page, snippet.name, snippetTimeoutMilliseconds);
      assert.ok(result.frames >= 1, `${snippet.name} drew a frame`);
      assert.ok(result.distinctColors >= 12, `${snippet.name} is not a blank frame (${result.distinctColors} colours)`);
      assert.ok(!hashes.has(result.hash), `${snippet.name} differs from every other snippet`);
      hashes.add(result.hash);
    }
    assert.deepEqual(failures, []);
    assert.ok(hashes.size >= 10);
  } finally {
    await browser.close();
    await server.close();
  }
});
