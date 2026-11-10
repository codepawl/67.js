// A large texture goes up in bounded row bands, and the pixels equal a single upload (issue 779).
// The pixel check runs in headless Chrome (SwiftShader) from the Vite dev server and skips when Chrome cannot start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.js';
import { MAX_UPLOAD_PIXELS, uploadImage } from '../src/renderer.js';

function recordingContext() {
  const calls = [];
  const context = {
    TEXTURE_2D: 3553, RGBA: 6408, UNSIGNED_BYTE: 5121, RGBA8: 32856, UNPACK_SKIP_ROWS: 3314,
    texImage2D: (...args) => calls.push(['texImage2D', ...args]),
    texSubImage2D: (...args) => calls.push(['texSubImage2D', ...args]),
    pixelStorei: (name, value) => calls.push(['pixelStorei', name, value]),
  };
  return { context, calls };
}

test('an image within the limit goes up in one call', () => {
  const { context, calls } = recordingContext();
  uploadImage(context, {}, 1024, 1024, context.RGBA8, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'texImage2D');
});

test('a larger image goes up in bands that each stay within the limit and cover every row once', () => {
  const { context, calls } = recordingContext();
  const width = 3000;
  const height = 1500;
  uploadImage(context, {}, width, height, context.RGBA8, false);
  const bands = calls.filter(call => call[0] === 'texSubImage2D');
  assert.ok(bands.length > 1);
  let nextRow = 0;
  for (const [, , , , destinationRow, bandWidth, rows] of bands) {
    assert.equal(destinationRow, nextRow);
    assert.equal(bandWidth, width);
    assert.ok(bandWidth * rows <= MAX_UPLOAD_PIXELS);
    nextRow += rows;
  }
  assert.equal(nextRow, height);
  assert.equal(calls.at(-1)[2], 0, 'the skip-rows state is restored');
});

test('a flipped image stays one upload', () => {
  const { context, calls } = recordingContext();
  uploadImage(context, {}, 2000, 1000, context.RGBA8, true);
  assert.deepEqual(calls.map(call => call[0]), ['texImage2D']);
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

async function differingBytes(page) {
  const task = async () => {
    const { box } = await import('/src/geometry.js');
    const { Renderer67, MAX_UPLOAD_PIXELS: limit } = await import('/src/renderer.js');
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    document.body.append(canvas);
    const part = { name: 'p', geometry: box(0, 1), matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material: { tag: 'surface', color: [1, 1, 1], metallic: 0, roughness: 0.5, emission: 0 } };
    const renderer = new Renderer67(canvas, [part], { ground: false, samples: 1, pixelRatio: 1 });
    const gl = renderer.context;
    const width = 1280;
    const height = Math.ceil(limit / width) * 2 + 7;
    const source = document.createElement('canvas');
    source.width = width;
    source.height = height;
    const sourceContext = source.getContext('2d');
    const imageData = sourceContext.createImageData(width, height);
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const offset = (row * width + column) * 4;
        imageData.data.set([column % 251, row % 241, (column + row) % 239, 255], offset);
      }
    }
    sourceContext.putImageData(imageData, 0, 0);
    const read = (texture) => {
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(framebuffer);
      return pixels;
    };
    const results = {};
    for (const flipY of [false, true]) {
      const banded = renderer.createTexture({ image: source, colorSpace: 'linear', flipY, minFilter: 9729 });
      const whole = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, whole);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      const bandedPixels = read(banded);
      const wholePixels = read(whole);
      let differing = 0;
      for (let index = 0; index < bandedPixels.length; index++) if (bandedPixels[index] !== wholePixels[index]) differing++;
      results[flipY ? 'flipped' : 'upright'] = { differing, bytes: bandedPixels.length, error: gl.getError() };
    }
    return results;
  };
  return page.evaluate(task);
}

test('banded upload gives the same pixels as one upload, upright, and flipped stays whole', async (context) => {
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
    const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    const results = await differingBytes(page);
    for (const [name, result] of Object.entries(results)) {
      assert.equal(result.error, 0, `${name} upload raised a GL error`);
      assert.equal(result.differing, 0, `${name}: ${result.differing} of ${result.bytes} bytes differ`);
    }
  } finally {
    await browser?.close();
    server.kill();
  }
});
