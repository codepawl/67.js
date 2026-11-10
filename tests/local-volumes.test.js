// Local volumes (issue 710): boxes and spheres that absorb and emit light, beside the one scattering volumeFog.
// The first tests check the fields and the packing in Node. The last draws in headless Chrome (SwiftShader, no GPU) from the
// Vite dev server and skips when Chrome cannot start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.js';
import { resolveLocalVolumes, createLocalVolumeBuffers, packLocalVolumes, localVolumeProfile, MAX_LOCAL_VOLUMES } from '../src/local-volumes.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { createPostFragment, POST_STEPS } from '../src/post.js';
import { normalizeAgentLook } from '../src/agent-look.js';
import { agentSceneModulesNeeded } from '../src/agent-scene-modules.js';

test('a volume resolves with its defaults and rejects what it cannot draw, naming the field', () => {
  const [sphere, box] = resolveLocalVolumes([{ shape: 'sphere', center: [0, 1, 0], radius: 2 }, { center: [1, 2, 3], size: [1, 2, 3], density: 4, emission: [1, 0.5, 0], emissionStrength: 3 }]);
  assert.equal(sphere.density, 1);
  assert.equal(sphere.falloff, 0.5);
  assert.deepEqual(sphere.absorption, [1, 1, 1]);
  assert.equal(box.shape, 'box');
  assert.equal(box.steps, 16);
  assert.throws(() => resolveLocalVolumes('smoke'), /localVolumes must be an array/);
  assert.throws(() => resolveLocalVolumes(new Array(MAX_LOCAL_VOLUMES + 1).fill({ center: [0, 0, 0], size: [1, 1, 1] })), /at most 8 volumes/);
  assert.throws(() => resolveLocalVolumes([{ center: [0, 0, 0] }]), /localVolumes\[0\]\.size must be an array of three numbers/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'sphere', center: [0, 0, 0] }]), /localVolumes\[0\]\.radius/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'sphere', center: [0, 0, 0], radius: 1, size: [1, 1, 1] }]), /size belongs to a box/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'cone', center: [0, 0, 0] }]), /shape must be one of box, sphere/);
  assert.throws(() => resolveLocalVolumes([{ center: [0, 0, 0], size: [1, 1, 1], density: -1 }]), /density must be between 0 and 100/);
  assert.throws(() => resolveLocalVolumes([{ center: [0, 0, 0], size: [1, 1, 1], steps: 8.5 }]), /steps must be an integer/);
  assert.throws(() => resolveLocalVolumes([{ center: [0, 0, 0], size: [1, 1, 1], glow: 1 }]), /no field "glow"/);
});

test('packing scales absorption by density and emission by strength, and the profile fades over the falloff share', () => {
  const volumes = resolveLocalVolumes([{ shape: 'sphere', center: [1, 2, 3], radius: 2, density: 3, absorption: [1, 0.5, 0], emission: [1, 0, 0], emissionStrength: 4, falloff: 0.5, noiseAmount: 0.25, noiseScale: 2, steps: 10 }]);
  const buffers = packLocalVolumes(volumes, createLocalVolumeBuffers());
  assert.equal(buffers.count, 1);
  assert.deepEqual(Array.from(buffers.centers.slice(0, 4)), [1, 2, 3, 1]);
  assert.deepEqual(Array.from(buffers.extents.slice(0, 4)), [2, 2, 2, 0.5]);
  assert.deepEqual(Array.from(buffers.absorption.slice(0, 4)), [3, 1.5, 0, 0.25]);
  assert.deepEqual(Array.from(buffers.emission.slice(0, 4)), [4, 0, 0, 2]);
  assert.equal(buffers.steps[0], 10);
  const [volume] = volumes;
  assert.equal(localVolumeProfile(volume, 1, 2, 3), 1);
  assert.equal(localVolumeProfile(volume, 3, 2, 3), 0);
  assert.equal(localVolumeProfile(volume, 1 + 1.5, 2, 3), 0.5);
  assert.equal(localVolumeProfile({ ...volume, falloff: 0 }, 1 + 1.99, 2, 3), 1);
});

test('the post program carries the local step only when asked, and a recipe names the volumes through its look', async () => {
  assert.equal(POST_STEPS.includes('local'), false);
  assert.match(createPostFragment(), /#define POST_LOCAL false/);
  assert.match(createPostFragment(), /vec3 localVolumes\(vec3 background\) \{ return background; \}/);
  assert.doesNotMatch(createPostFragment(), /localVolumeCount/);
  await import('../src/fog-shader.js');
  const source = createPostFragment([...POST_STEPS, 'local']);
  assert.match(source, /#define POST_LOCAL \(localVolumeCount > 0\)/);
  assert.match(source, /uniform vec4 localVolumeCenters\[8\]/);
  const environment = { localVolumes: [{ center: [0, 1, 0], radius: 1, shape: 'sphere' }] };
  assert.equal(normalizeAgentLook({ environment }).environment.localVolumes[0].steps, 16);
  assert.equal('localVolumes' in normalizeAgentLook({}).environment, false);
  assert.throws(() => normalizeAgentLook({ environment: { localVolumes: [{ center: [0, 0, 0], size: [1, 1, -1] }] } }), /environment\.localVolumes\[0\]\.size/);
  assert.ok(agentSceneModulesNeeded({ environment }).includes('fogShader'));
});

async function startServer(port) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The dev server did not start.')), 30000);
    server.stdout.on('data', (data) => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`The dev server exited ${code}.`));
    });
  });
  return server;
}

// A grey wall at z = 0 seen from z = 5; each scenario adds local volumes between the camera and the wall (or behind it).
async function drawScenarios(page, scenarios) {
  const task = async (list) => {
    const { box } = await import('/src/geometry.js');
    const { Renderer67 } = await import('/src/renderer.js');
    await import('/src/fog-shader.js');
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    document.body.append(canvas);
    const copy = document.createElement('canvas');
    copy.width = 64;
    copy.height = 64;
    const copyContext = copy.getContext('2d', { willReadFrequently: true });
    const wall = { geometry: box(0, 1), matrix: new Float32Array([12, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0.2, 0, 0, 0, -0.1, 1]), material: { tag: 'unlit', color: [0.4, 0.4, 0.4], metallic: 0, roughness: 1, emission: 0 } };
    const results = [];
    for (const localVolumes of list) {
      const renderer = new Renderer67(canvas, [wall], { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
      const environment = { keyIntensity: 0, fillIntensity: 0, ambientIntensity: 0 };
      if (localVolumes) environment.localVolumes = localVolumes;
      renderer.render({ eye: [0, 0, 5], target: [0, 0, 0], fov: 40, time: 0, environment });
      copyContext.drawImage(canvas, 0, 0, 64, 64);
      const center = Array.from(copyContext.getImageData(32, 32, 1, 1).data);
      const corner = Array.from(copyContext.getImageData(2, 2, 1, 1).data);
      results.push({ center, corner, glError: renderer.context.getError() });
      renderer.dispose?.();
    }
    return results;
  };
  return page.evaluate(task, scenarios);
}

test('absorption darkens, emission glows, and a scene without volumes draws the same', async (context) => {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    context.skip('playwright is not installed');
    return;
  }
  const port = await freePort();
  const server = await startServer(port);
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
    const sphere = { shape: 'sphere', center: [0, 0, 1.5], radius: 1, falloff: 0.3, steps: 24 };
    const [plain, empty, smoke, glow, tinted, behindWall] = await drawScenarios(page, [
      undefined,
      [],
      [{ ...sphere, density: 1.5 }],
      [{ ...sphere, density: 0, emission: [1, 0.4, 0.1], emissionStrength: 1.5 }],
      [{ ...sphere, density: 1.5, absorption: [0.1, 0.6, 1] }],
      [{ shape: 'sphere', center: [0, 0, -3], radius: 1.5, density: 5, emission: [1, 1, 1], emissionStrength: 5 }],
    ]);
    for (const result of [plain, empty, smoke, glow, tinted, behindWall]) assert.equal(result.glError, 0);
    assert.deepEqual(empty, plain, 'an empty list changes nothing');
    assert.deepEqual(behindWall, plain, 'a volume behind the wall is hidden by it');
    assert.ok(smoke.center[0] < plain.center[0] - 20, 'absorption darkens the wall behind the volume');
    assert.deepEqual(smoke.corner, plain.corner, 'pixels outside the volume are untouched');
    assert.ok(glow.center[0] > plain.center[0] + 20, 'emission with no density still glows');
    assert.ok(glow.center[0] > glow.center[2] + 20, 'the emission colour tints the glow');
    assert.ok(tinted.center[0] > tinted.center[2] + 10, 'a channel with a larger absorption is dimmed more: blue goes first and leaves a red cast');
  } finally {
    await browser?.close();
    server.kill();
  }
});

const LOOKING_DOWN = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };
const IMAGE = { width: 16, height: 16, denoise: false, threads: 1, bounces: 1, samples: 1 };
const CENTER_PIXEL = (8 * 16 + 8) * 3;

function ground(emission) {
  const half = 20;
  const geometry = {
    positions: new Float32Array([-half, 0, half, half, 0, half, half, 0, -half, -half, 0, -half]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  return [{ name: 'ground', geometry, material: { tag: 'surface', metallic: 0, roughness: 1, color: [0, 0, 0], ior: 1, emission, emissiveColor: [1, 1, 1] } }];
}

async function centerRadiance(parts, environment) {
  const { linear } = await renderPathTracedImage({ parts, environment, camera: LOOKING_DOWN }, IMAGE);
  return Array.from(linear.slice(CENTER_PIXEL, CENTER_PIXEL + 3));
}

test('the path tracer attenuates by exp(-density * thickness) and adds emission times thickness', async () => {
  const slab = { shape: 'box', center: [0, 1.5, 0], size: [20, 1, 20], falloff: 0, steps: 8 };
  const [clear] = await centerRadiance(ground(1), {});
  const [dimmed] = await centerRadiance(ground(1), { localVolumes: [{ ...slab, density: 1 }] });
  assert.equal(clear, 1);
  assert.ok(Math.abs(dimmed - Math.exp(-1)) < 2e-3, `transmitted ${dimmed}`);
  const [glowRed, glowGreen] = await centerRadiance(ground(0), { localVolumes: [{ ...slab, density: 0, emission: [0.5, 0.25, 0], emissionStrength: 2 }] });
  assert.ok(Math.abs(glowRed - 1) < 2e-3, `red ${glowRed}`);
  assert.ok(Math.abs(glowGreen - 0.5) < 2e-3, `green ${glowGreen}`);
  const [nothing] = await centerRadiance(ground(1), { localVolumes: [] });
  assert.equal(nothing, clear);
});

test('the path tracer refuses local volumes on a GPU backend instead of dropping them', async () => {
  await assert.rejects(
    renderPathTracedImage({ parts: ground(1), environment: { localVolumes: [{ shape: 'sphere', center: [0, 1, 0], radius: 1 }] }, camera: LOOKING_DOWN }, { ...IMAGE, backend: 'gpu' }),
    /localVolumes is traced by the CPU path tracer only/,
  );
});
