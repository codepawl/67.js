// Local volumes (issue 710): the tracers that cannot draw them refuse them through one shared check, and the renderer rejects a bad
// environment.localVolumes before it binds a post program. The browser test uses headless Chrome on SwiftShader and skips when
// Chrome cannot start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.js';
import { buildTraceScene, refuseLocalVolumes } from '../src/path-tracer-scene.js';

const GROUND = [{
  name: 'ground',
  geometry: {
    positions: new Float32Array([-5, 0, 5, 5, 0, 5, 5, 0, -5, -5, 0, -5]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  },
  material: { tag: 'surface', metallic: 0, roughness: 1, color: [0, 0, 0], ior: 1, emission: 1, emissiveColor: [1, 1, 1] },
}];

test('every tracer entry point refuses local volumes through one shared check', () => {
  const withVolumes = buildTraceScene(GROUND, { localVolumes: [{ shape: 'sphere', center: [0, 1, 0], radius: 1 }] });
  assert.throws(() => refuseLocalVolumes(withVolumes, 'the progressive path tracer'), /CPU path tracer only; the progressive path tracer cannot draw them/);
  assert.doesNotThrow(() => refuseLocalVolumes(buildTraceScene(GROUND, {}), 'the progressive path tracer'));
  assert.doesNotThrow(() => refuseLocalVolumes(buildTraceScene(GROUND, { localVolumes: [] }), 'the progressive path tracer'));
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

async function probeInPage(page) {
  const { box } = await import('/src/geometry.js');
  const { Renderer67 } = await import('/src/renderer.js');
  const { createProgressiveTracer } = await import('/src/path-tracer-progressive.js');
  const { createRealtimeTracer } = await import('/src/path-tracer-realtime.js');
  await import('/src/fog-shader.js');
  const wall = { geometry: box(0, 1), matrix: new Float32Array([4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0.2, 0, 0, 0, -0.1, 1]), material: { tag: 'unlit', color: [0.4, 0.4, 0.4], metallic: 0, roughness: 1, emission: 0 } };
  const volume = [{ shape: 'sphere', center: [0, 0, 1], radius: 1 }];

  const drawWith = (rendererOptions, localVolumes) => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const renderer = new Renderer67(canvas, [wall], { samples: 1, pixelRatio: 1, ground: false, ...rendererOptions });
    let choseProgram = false;
    const originalSelect = renderer.selectPostProgram.bind(renderer);
    renderer.selectPostProgram = (steps) => {
      choseProgram = true;
      return originalSelect(steps);
    };
    try {
      renderer.render({ eye: [0, 0, 5], target: [0, 0, 0], fov: 40, time: 0, environment: { localVolumes } });
      return { message: null, choseProgram };
    } catch (failure) {
      return { message: failure.message, choseProgram };
    }
  };

  const result = {
    objectWithoutLength: drawWith({ hdr: true, depth: true }, {}),
    noHdr: drawWith({ hdr: false, depth: true }, volume),
    noDepth: drawWith({ hdr: true, depth: false }, volume),
    valid: drawWith({ hdr: true, depth: true }, volume),
  };
  try {
    await createProgressiveTracer({ parts: [wall], environment: { localVolumes: volume } }, { width: 16, height: 16, maxSeconds: 60 });
    result.progressive = null;
  } catch (failure) {
    result.progressive = failure.message;
  }
  try {
    const tracer = await createRealtimeTracer({ parts: [wall], environment: { localVolumes: volume }, camera: { eye: [0, 0, 5], target: [0, 0, 0], fov: 40 } }, { backend: 'gpu', width: 64, height: 64 });
    tracer.dispose();
    result.realtime = null;
  } catch (failure) {
    result.realtime = failure.message;
  }
  return result;
}

test('the renderer rejects a bad localVolumes value before it binds a post program, and the progressive and WebGL real-time tracers refuse volumes', async (context) => {
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
    const page = await browser.newPage({ viewport: { width: 32, height: 32 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    const outcome = await page.evaluate(probeInPage);
    assert.match(outcome.objectWithoutLength.message, /environment\.localVolumes must be an array of volumes/);
    assert.equal(outcome.objectWithoutLength.choseProgram, false, 'the throw comes before the post program is chosen');
    assert.match(outcome.noHdr.message, /Local volumes require depth:true, active HDR/);
    assert.match(outcome.noDepth.message, /Local volumes require depth:true, active HDR/);
    assert.equal(outcome.noHdr.choseProgram, false);
    assert.equal(outcome.noDepth.choseProgram, false);
    assert.equal(outcome.valid.message, null);
    assert.match(outcome.progressive, /CPU path tracer only; the progressive path tracer cannot draw them/);
    assert.match(outcome.realtime, /environment.localVolumes is traced by the CPU path tracer only; the WebGL realtime path tracer cannot draw them/);
  } finally {
    await browser?.close();
    server.kill();
  }
});
