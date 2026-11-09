// Motion tracks for lights, the sun, sky and fog, exposure and focus distance (issue 605).
import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createAgentScene } from '../src/agent-scene.js';
import { freePort } from './helpers/free-port.js';

function sceneRecipe(tracks, extra = {}) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'finish', color: [0.6, 0.6, 0.6], emission: 0 }],
    nodes: [{ id: 'block', geometry: 'box', material: 'finish' }],
    camera: { eye: [4, 3, 5], target: [0, 0, 0] },
    environment: {
      pointLights: [{ position: [0, 3, 0], color: [1, 0.9, 0.7], intensity: 2 }],
      spotLights: [{ position: [2, 3, 0], direction: [0, -1, 0] }],
      areaLights: [{ position: [0, 4, 0], direction: [0, -1, 0], width: 1, height: 1 }],
    },
    effects: { depthOfField: { blur: 0.4, focusDistance: 4 } },
    motion: { duration: 2, tracks },
    ...extra,
  };
}
const keys = (start, end) => [{ time: 0, value: start }, { time: 2, value: end }];

test('light tracks set color, intensity and position of one light and leave the rest authored', () => {
  const scene = createAgentScene(sceneRecipe([
    { kind: 'light', id: 'point:0', property: 'intensity', keyframes: keys(2, 0) },
    { kind: 'light', id: 'point:0', property: 'position', keyframes: keys([0, 3, 0], [4, 3, 0]) },
    { kind: 'light', id: 'spot:0', property: 'direction', keyframes: keys([0, -1, 0], [-1, -1, 0]) },
    { kind: 'light', id: 'area:0', property: 'color', keyframes: keys([1, 1, 1], [1, 0, 0]) },
  ]));
  scene.sampleMotion(1);
  const environment = scene.environment;
  assert.equal(environment.pointLights[0].intensity, 1);
  assert.deepEqual(environment.pointLights[0].position, [2, 3, 0]);
  assert.deepEqual(environment.pointLights[0].color, [1, 0.9, 0.7]);
  assert.deepEqual(environment.spotLights[0].direction, [-0.5, -1, 0]);
  assert.deepEqual(environment.areaLights[0].color, [1, 0.5, 0.5]);
  scene.sampleMotion(null);
  assert.equal(scene.environment.pointLights[0].intensity, 2);
  assert.equal(scene.exportRecipe().environment.pointLights[0].intensity, 2);
});

test('sun and environment tracks set the key light, sky, fog and volume fog', () => {
  const scene = createAgentScene(sceneRecipe([
    { kind: 'sun', property: 'direction', keyframes: keys([-1, 4, 0], [-1, 0.2, 0]) },
    { kind: 'sun', property: 'intensity', keyframes: keys(1, 0.2) },
    { kind: 'environment', property: 'skyTop', keyframes: keys([0.2, 0.4, 0.9], [0.9, 0.3, 0.1]) },
    { kind: 'environment', property: 'fogDensity', keyframes: keys(0, 0.4) },
    { kind: 'environment', property: 'volumeFogDensity', keyframes: keys(0, 0.2) },
  ]));
  scene.sampleMotion(2);
  const environment = scene.environment;
  assert.deepEqual(environment.lightDirection, [-1, 0.2, 0]);
  assert.equal(environment.keyIntensity, 0.2);
  assert.deepEqual(environment.skyTop, [0.9, 0.3, 0.1]);
  assert.equal(environment.fogDensity, 0.4);
  assert.equal(environment.volumeFog.density, 0.2);
  assert.notDeepEqual(scene.exportRecipe().environment.skyTop, environment.skyTop);
});

test('effects tracks set exposure and the focus distance of the depth of field', () => {
  const scene = createAgentScene(sceneRecipe([
    { kind: 'effects', property: 'exposure', keyframes: keys(1, 2) },
    { kind: 'effects', property: 'focusDistance', interpolation: 'SMOOTH', keyframes: keys(2, 8) },
  ]));
  scene.sampleMotion(1);
  assert.equal(scene.effects.exposure, 1.5);
  assert.equal(scene.effects.depthOfField.focusDistance, 5);
  assert.equal(scene.effects.depthOfField.blur, 0.4);
});

test('a scene with no look tracks reads the authored environment and effects', () => {
  const scene = createAgentScene(sceneRecipe([{ kind: 'material', id: 'finish', property: 'emission', keyframes: keys(0, 1) }]));
  const authored = JSON.stringify([scene.environment, scene.effects]);
  scene.sampleMotion(1);
  assert.equal(JSON.stringify([scene.environment, scene.effects]), authored);
});

test('unknown lights, properties and ill-fitting targets name the valid ones', () => {
  const failure = (track, pattern) => assert.throws(() => createAgentScene(sceneRecipe([track])), pattern);
  failure({ kind: 'light', id: 'point:3', property: 'color', keyframes: keys([1, 1, 1], [0, 0, 0]) }, /point:3.*point:0, spot:0, area:0/);
  failure({ kind: 'light', id: 'point:0', property: 'direction', keyframes: keys([0, -1, 0], [0, 1, 0]) }, /point light has no direction|point:0 has no direction/);
  failure({ kind: 'light', id: 'point:0', property: 'radius', keyframes: keys(1, 2) }, /light properties: position, direction, color, intensity/);
  failure({ kind: 'sun', property: 'angle', keyframes: keys(1, 2) }, /sun properties: direction, color, intensity/);
  failure({ kind: 'sun', id: 'x', property: 'intensity', keyframes: keys(1, 2) }, /Sun tracks cannot have an ID/);
  failure({ kind: 'environment', property: 'skyTop', keyframes: keys([0, 0, 0], [2, 0, 0]) }, /environment skyTop values from 0 to 1/);
  failure({ kind: 'sun', property: 'direction', keyframes: keys([0, 0, 0], [0, 1, 0]) }, /keyframes\[0\]\.value: got \[0,0,0\]; expected a direction that is not all zero/);
  failure({ kind: 'effects', property: 'exposure', keyframes: keys(1, 99) }, /effects exposure values from 0.01 to 16/);
  assert.throws(() => createAgentScene(sceneRecipe([{ kind: 'effects', property: 'focusDistance', keyframes: keys(1, 2) }],
    { effects: {} })), /focusDistance needs effects.depthOfField.blur above 0/);
});

test('a sunset changes the sun and sky between two frames of a render', async (context) => {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    context.skip('playwright is not installed');
    return;
  }
  const port = await freePort();
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The dev server did not start.')), 30000);
    server.stdout.on('data', data => { if (/ready in/.test(data.toString())) { clearTimeout(timeout); resolve(); } });
    server.on('exit', code => { clearTimeout(timeout); reject(new Error(`The dev server exited ${code}.`)); });
  });
  let browser;
  try {
    try {
      browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
    } catch (error) {
      context.skip(`Chrome did not start: ${error.message.split('\n')[0]}`);
      return;
    }
    const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    const recipe = sceneRecipe([
      { kind: 'sun', property: 'direction', keyframes: keys([-1, 4, 1], [-4, 0.3, 1]) },
      { kind: 'environment', property: 'environmentRotation', keyframes: keys(0, 2) },
      { kind: 'environment', property: 'environmentIntensity', keyframes: keys(1, 0.4) },
    ], { environment: { world: true } });
    const frames = await page.evaluate(async (input) => {
      const { createAgentScene } = await import('/src/agent-scene.js');
      const { loadAllAgentSceneModules } = await import('/src/agent-scene.js');
      await loadAllAgentSceneModules?.();
      const { Renderer67 } = await import('/src/renderer.js');
      const { agentEnvironmentMap } = await import('/src/agent-look.js');
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      document.body.append(canvas);
      const copy = document.createElement('canvas');
      copy.width = 64;
      copy.height = 64;
      const copyContext = copy.getContext('2d', { willReadFrequently: true });
      const scene = createAgentScene(input);
      const renderer = new Renderer67(canvas, scene.parts, { ground: false, world: true, samples: 1, pixelRatio: 1, environment: scene.environment });
      const results = [];
      for (const time of [0, 2]) {
        scene.sampleMotion(time);
        const environment = scene.environment;
        renderer.render({ ...scene.camera, environment: { ...environment, map: agentEnvironmentMap(environment) } });
        copyContext.clearRect(0, 0, 64, 64);
        copyContext.drawImage(canvas, 0, 0, 64, 64);
        results.push(Array.from(copyContext.getImageData(0, 0, 64, 64).data));
      }
      return results;
    }, recipe);
    let differing = 0;
    for (let index = 0; index < frames[0].length; index += 4) {
      const change = Math.abs(frames[0][index] - frames[1][index]) + Math.abs(frames[0][index + 1] - frames[1][index + 1]) + Math.abs(frames[0][index + 2] - frames[1][index + 2]);
      if (change > 12) differing++;
    }
    assert.ok(differing > 1500, `the sunset changed ${differing} of 4096 pixels`);
  } finally {
    await browser?.close();
    server.kill();
  }
});
