// The two light bake backends against each other (issue #412): on a room whose surfaces are diffuse only, the CPU gatherer and the
// GPU kernel must bring the same light to the texels. A surface with a specular lobe is where they differ on purpose (the GPU
// kernel follows the lobe, the CPU gatherer treats every part as Lambertian), and the second test pins the size of that gap.
// It runs the GPU kernel in headless Chrome (SwiftShader, no GPU) from the Vite dev server, and skips when Chrome cannot start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.js';
import { launchChrome, skipOrThrow } from './helpers/dev-server-browser.js';

// Measured 2026-11-04 on an RTX 3060, a closed 8 m room with one lamp, 512 samples, 3 bounces: diffuse-only surfaces (ior 1)
// gave a GPU to CPU light ratio of 1.0034 on the floor, 1.0014 on the ceiling and 1.008 to 1.011 on the walls (0.6 percent over
// the room). The same room with the default ior 1.5 gave 1.029, and 1.048 with a glossy floor.
// This test's smaller room on SwiftShader (256 samples) gave 1.0046 for diffuse surfaces and 1.0766 for a glossy dielectric.
const DIFFUSE_AGREEMENT = 0.01;
const SPECULAR_GAP_AT_LEAST = 0.015;
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

// Bakes a closed room on both backends and returns GPU light divided by CPU light, summed over every texel of every part.
async function bakeRoomOnBothBackends(material) {
  const { box } = await import('/src/geometry.js');
  const { bakeLightmapsAsync } = await import('/src/light-bake-gpu.js');
  const cube = box(0, 1);
  const placed = (name, translation, scale, color) => ({
    name,
    geometry: cube,
    matrix: new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]),
    material: { tag: 'surface', metallic: 0, emission: 0, color, ...material },
  });
  const parts = [
    placed('floor', [0, -0.05, 0], [4, 0.1, 4], [0.45, 0.32, 0.22]),
    placed('ceiling', [0, 2.55, 0], [4, 0.1, 4], [0.7, 0.68, 0.62]),
    placed('back', [0, 1.25, -2.05], [4, 2.7, 0.1], [0.7, 0.68, 0.62]),
    placed('front', [0, 1.25, 2.05], [4, 2.7, 0.1], [0.7, 0.68, 0.62]),
    placed('left', [-2.05, 1.25, 0], [0.1, 2.7, 4], [0.55, 0.25, 0.2]),
    placed('right', [2.05, 1.25, 0], [0.1, 2.7, 4], [0.2, 0.35, 0.5]),
  ];
  const lighting = { pointLights: [{ position: [0, 2, -0.3], color: [1, 0.9, 0.75], intensity: 8, radius: 0.05, castShadow: true }], keyColor: [0, 0, 0], lightDirection: [0, 1, 0] };
  const options = { samples: 256, bounces: 3, texelsPerUnit: 6 };
  const radianceOf = (part) => {
    const texture = part.material.lightMap ?? part.material.emissiveMap;
    const peak = part.material.lightMap ? part.material.lightMapScale : part.material.emission;
    const bytes = texture.image.data;
    let sum = 0;
    for (let texel = 0; texel < bytes.length / 4; texel++) {
      for (let channel = 0; channel < 3; channel++) {
        const encoded = bytes[texel * 4 + channel] / 255;
        sum += (encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4) * peak;
      }
    }
    return sum;
  };
  const total = (baked) => baked.parts.reduce((sum, part) => sum + radianceOf(part), 0);
  const cpu = await bakeLightmapsAsync(parts, lighting, { ...options, backend: 'cpu' });
  const gpu = await bakeLightmapsAsync(parts, lighting, { ...options, backend: 'gpu' });
  return total(gpu) / total(cpu);
}

async function withPage(context, run) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    skipOrThrow(context, 'playwright is not installed');
    return;
  }
  const port = await freePort();
  const server = await startServer(port);
  let browser;
  try {
    try {
      browser = await launchChrome(chromium);
    } catch (error) {
      skipOrThrow(context, `Chrome did not start: ${error.message.split('\n')[0]}`);
      return;
    }
    const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
    page.setDefaultTimeout(0);
    await page.goto(`http://127.0.0.1:${port}/`);
    await run(material => page.evaluate(bakeRoomOnBothBackends, material));
  } finally {
    await browser?.close();
    server.kill();
  }
}

test('on a room of diffuse surfaces the CPU and GPU bakes bring the same light', { timeout: 600000 }, async (context) => {
  await withPage(context, async (ratioFor) => {
    const ratio = await ratioFor({ roughness: 1, ior: 1 });
    console.log(JSON.stringify({ diffuseGpuToCpu: ratio }));
    assert.ok(Math.abs(ratio - 1) < DIFFUSE_AGREEMENT, `GPU light is ${ratio} times the CPU light`);
  });
});

test('a specular lobe makes the GPU bake brighter than the CPU one, which has none', { timeout: 600000 }, async (context) => {
  await withPage(context, async (ratioFor) => {
    const ratio = await ratioFor({ roughness: 0.25, ior: 1.5 });
    console.log(JSON.stringify({ glossyGpuToCpu: ratio }));
    assert.ok(ratio - 1 > SPECULAR_GAP_AT_LEAST, `GPU light is ${ratio} times the CPU light`);
  });
});
