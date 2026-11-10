// Fit "mesh" volumes in the rasterizer (issue 807): the mesh pass finds how long each pixel's ray spends inside a closed part, and
// the post shader integrates the volume over that length. Checked against the CPU path tracer on an L-shaped room and against the
// analytic length through two shells. Draws in headless Chrome (SwiftShader) from the Vite dev server; skips when Chrome cannot start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { applyViewTransform } from '../src/view-transform.js';

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

// An L-shaped prism: three unit squares in x and z (the notch is x in 1..2, z in 1..2), extruded in y from 0 to 1.
function lPrism(reverseWinding = false) {
  const outline = [[0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 1]];
  const positions = [];
  for (const height of [0, 1]) for (const [x, z] of outline) positions.push(x, height, z);
  const indices = [];
  const top = outline.length;
  for (const [a, b, c, d] of [[0, 1, 4, 7], [1, 2, 3, 4], [7, 4, 5, 6]]) {
    indices.push(a, b, c, a, c, d, top + a, top + c, top + b, top + a, top + d, top + c);
  }
  for (let corner = 0; corner < outline.length; corner++) {
    const next = (corner + 1) % outline.length;
    indices.push(corner, top + next, next, corner, top + corner, top + next);
  }
  if (reverseWinding) {
    for (let corner = 0; corner < indices.length; corner += 3) [indices[corner + 1], indices[corner + 2]] = [indices[corner + 2], indices[corner + 1]];
  }
  return { positions, indices };
}

// Two unit boxes two units apart along x, one closed mesh in two shells.
function dumbbell() {
  const corners = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  const positions = [...corners];
  for (let index = 0; index < corners.length; index += 3) positions.push(corners[index] + 3, corners[index + 1], corners[index + 2]);
  return { positions, indices: [...faces, ...faces.map(index => index + 8)] };
}

const OPEN_BOX = { positions: dumbbell().positions.slice(0, 24), indices: dumbbell().indices.slice(0, 33) };
const LOOKING_DOWN = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };
// The L covers x and z from -0.4 to 0.4 with its notch where both are positive, from y 0.2 to 1.2.
const L_ROOM_MATRIX = [0.4, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.4, 0, -0.4, 0.2, -0.4, 1];
const MIXED_WINDING = { positions: dumbbell().positions.slice(0, 24), indices: [0, 1, 2, ...dumbbell().indices.slice(3, 36)] };
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const SIZE = 64;

// Draws each scenario to a float target and returns the frame with the volume and the frame without it, as the display shows them.
// A white ground and a white wall at x = 8 give every ray something to dim.
async function drawInChrome(page, scenarios) {
  const task = async (list) => {
    const { box } = await import('/src/geometry.js');
    const { Renderer67 } = await import('/src/renderer.js');
    const { createFloatOutput, readFloatPixels } = await import('/src/float-output.js');
    await import('/src/fog-shader.js');
    const canvas = document.createElement('canvas');
    canvas.width = list.size;
    canvas.height = list.size;
    canvas.style.width = list.size + 'px';
    canvas.style.height = list.size + 'px';
    document.body.append(canvas);
    const material = { tag: 'unlit', color: [1, 1, 1], metallic: 0, roughness: 1, emission: 0 };
    const ground = { name: 'ground', geometry: box(0, 1), matrix: new Float32Array([40, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 40, 0, 0, -0.1, 0, 1]), material };
    const wall = { name: 'wall', geometry: box(0, 1), matrix: new Float32Array([0.2, 0, 0, 0, 0, 40, 0, 0, 0, 0, 40, 0, 8, 0, 0, 1]), material };
    const results = [];
    for (const scenario of list.scenarios) {
      const geometry = { positions: new Float32Array(scenario.mesh.positions), normals: new Float32Array(scenario.mesh.positions.length), indices: new Uint32Array(scenario.mesh.indices) };
      const room = { name: 'room', visible: false, geometry, matrix: new Float32Array(scenario.matrix), material };
      const renderer = new Renderer67(canvas, [ground, wall, room], { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
      const output = createFloatOutput(renderer.context, renderer.canvas.width, renderer.canvas.height);
      const draw = (localVolumes) => {
        const environment = { keyIntensity: 0, fillIntensity: 0, ambientIntensity: 0, localVolumes };
        renderer.render({ ...scenario.camera, time: 0, environment, outputFramebuffer: output.framebuffer });
        return readFloatPixels(renderer.context, output.framebuffer, renderer.canvas.width, renderer.canvas.height);
      };
      let message = null;
      let transmittance = null;
      try {
        const plain = draw([]);
        const filled = draw(scenario.localVolumes);
        transmittance = { plain: Array.from(plain), filled: Array.from(filled) };
      } catch (error) {
        message = error.message;
      }
      results.push({ message, transmittance, glError: renderer.context.getError() });
      output.dispose();
      renderer.dispose?.();
    }
    return results;
  };
  const frames = await page.evaluate(task, { scenarios, size: SIZE });
  return frames.map(frame => (frame.transmittance ? { ...frame, transmittance: transmittanceOf(frame.transmittance) } : frame));
}

// The display shows aces(light) ^ (1 / 2.2); this undoes both for a channel, so the ratio of two frames is the light that got through.
function lightOf(displayed) {
  let low = 0;
  let high = 64;
  for (let round = 0; round < 40; round++) {
    const middle = (low + high) / 2;
    if (applyViewTransform('aces', [middle, middle, middle])[0] ** (1 / 2.2) < displayed) low = middle;
    else high = middle;
  }
  return low;
}

function transmittanceOf({ plain, filled }) {
  return Array.from(filled, (value, index) => (index % 4 === 3 || plain[index] <= 0 ? 1 : lightOf(value) / lightOf(plain[index])));
}

async function openPage(context) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    context.skip('playwright is not installed');
    return null;
  }
  const port = await freePort();
  const server = await startServer(port);
  try {
    const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
    await page.goto(`http://127.0.0.1:${port}/`);
    return {
      page,
      async close() {
        await browser.close();
        server.kill();
      },
    };
  } catch (error) {
    server.kill();
    context.skip(`Chrome did not start: ${error.message.split('\n')[0]}`);
    return null;
  }
}

function groundGeometry() {
  const half = 20;
  return {
    positions: new Float32Array([-half, 0, half, half, 0, half, half, 0, -half, -half, 0, -half]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

async function cpuTransmittance(fit) {
  const material = { tag: 'surface', metallic: 0, roughness: 1, color: [0, 0, 0], ior: 1, emission: 1, emissiveColor: [1, 1, 1] };
  const mesh = lPrism();
  const geometry = { positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices), normals: new Float32Array(mesh.positions.length) };
  const room = { name: 'room', visible: false, material, matrix: L_ROOM_MATRIX, geometry };
  const environment = { localVolumes: [{ shape: 'mesh', part: 'room', fit, density: 1, falloff: 0, steps: 32 }] };
  const { linear } = await renderPathTracedImage({ parts: [{ name: 'ground', geometry: groundGeometry(), material }, room], environment, camera: LOOKING_DOWN }, { width: 16, height: 16, denoise: false, threads: 1, bounces: 1, samples: 1 });
  return (column, row) => linear[(row * 16 + column) * 3];
}

// WebGL stores rows bottom to top, so the row is counted from the other end. The mean of the inner 2 by 2 pixels of the 4 by 4 block of the 64 by 64 frame that one pixel of the 16 by 16 CPU image covers.
function blockMean(transmittance, column, row) {
  let total = 0;
  for (let y = row * 4 + 1; y < row * 4 + 3; y++) for (let x = column * 4 + 1; x < column * 4 + 3; x++) total += transmittance[((SIZE - 1 - y) * SIZE + x) * 4];
  return total / 4;
}

test('the rasterizer fills an L-shaped closed mesh like the CPU path tracer: arms dimmed, notch clear', async (context) => {
  const opened = await openPage(context);
  if (!opened) return;
  try {
    const smoke = { shape: 'mesh', part: 'room', density: 1, falloff: 0, steps: 16 };
    const [meshFit, boundsFit, reversed] = await drawInChrome(opened.page, [
      { mesh: lPrism(), matrix: L_ROOM_MATRIX, camera: LOOKING_DOWN, localVolumes: [{ ...smoke, fit: 'mesh' }] },
      { mesh: lPrism(), matrix: L_ROOM_MATRIX, camera: LOOKING_DOWN, localVolumes: [{ ...smoke, fit: 'bounds' }] },
      { mesh: lPrism(true), matrix: L_ROOM_MATRIX, camera: LOOKING_DOWN, localVolumes: [{ ...smoke, fit: 'mesh' }] },
    ]);
    for (const result of [meshFit, boundsFit, reversed]) {
      assert.equal(result.message, null);
      assert.equal(result.glError, 0);
    }
    const cpu = await cpuTransmittance('mesh');
    const regions = { arm: [5, 5], notch: [10, 10], outside: [1, 1] };
    for (const [name, [column, row]] of Object.entries(regions)) {
      const raster = blockMean(meshFit.transmittance, column, row);
      assert.ok(Math.abs(raster - cpu(column, row)) < 0.03, `${name}: raster ${raster} against CPU ${cpu(column, row)}`);
      assert.equal(blockMean(reversed.transmittance, column, row), raster, `${name}: a mesh wound the other way fills the same`);
    }
    assert.equal(blockMean(meshFit.transmittance, 10, 10), 1, 'the notch is clear');
    assert.ok(blockMean(boundsFit.transmittance, 10, 10) < 0.5, 'bounds fill the notch');
  } finally {
    await opened.close();
  }
});

test('the rasterizer sums every shell a ray crosses, from outside and from inside, and refuses an open or inconsistently wound mesh', async (context) => {
  const opened = await openPage(context);
  if (!opened) return;
  try {
    // A ray along +x at height 0.5 crosses 1 unit of each box of the dumbbell and a 2 unit gap.
    const side = { eye: [-6, 0.5, 0.5], target: [0, 0.5, 0.5], up: [0, 1, 0], fov: 20 };
    const smoke = { shape: 'mesh', part: 'room', fit: 'mesh', density: 0.7, falloff: 0, steps: 16 };
    const [shells, inside, open, mixed] = await drawInChrome(opened.page, [
      { mesh: dumbbell(), matrix: IDENTITY, camera: side, localVolumes: [smoke] },
      // The camera sits in the middle of the first box, so the ray leaves it after half a unit and crosses the second box.
      { mesh: dumbbell(), matrix: IDENTITY, camera: { eye: [0.5, 0.5, 0.5], target: [6, 0.5, 0.5], up: [0, 1, 0], fov: 20 }, localVolumes: [smoke] },
      { mesh: OPEN_BOX, matrix: IDENTITY, camera: side, localVolumes: [smoke] },
      { mesh: MIXED_WINDING, matrix: IDENTITY, camera: side, localVolumes: [smoke] },
    ]);
    const middle = (SIZE / 2) * SIZE + SIZE / 2;
    assert.equal(shells.message, null);
    assert.ok(Math.abs(shells.transmittance[middle * 4] - Math.exp(-0.7 * 2)) < 0.01, `two shells: ${shells.transmittance[middle * 4]}`);
    assert.equal(inside.message, null);
    assert.ok(Math.abs(inside.transmittance[middle * 4] - Math.exp(-0.7 * 1.5)) < 0.01, `from inside: ${inside.transmittance[middle * 4]}`);
    assert.match(open.message, /environment\.localVolumes\[0\]\.part "room" is not a closed mesh \(\d+ open edges\)/);
    assert.match(mixed.message, /environment\.localVolumes\[0\]\.part "room" has faces wound against each other/);
  } finally {
    await opened.close();
  }
});
