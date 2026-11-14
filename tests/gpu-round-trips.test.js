// The frame and texture paths do not ask the GPU process questions whose answers cannot change (issue 779).
// Each read is a round trip that waits for all queued GPU work, 30 to 70 ms on a busy card.
// It runs in headless Chrome from the Vite dev server; it skips locally when Chrome cannot start and fails on CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withDevServerPage } from './helpers/dev-server-browser.js';

async function countRoundTrips(page) {
  const task = async () => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const material = { tag: 'surface', color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5, emission: 0 };
    const part = { name: 'box', geometry: box(0, 1), matrix: identity, material };
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    document.body.append(canvas);
    const renderer = new CrucibleRenderer(canvas, [part], { samples: 1, pixelRatio: 1 });
    const context = renderer.context;
    const counts = { framebufferChecks: 0, anisotropyReads: 0 };
    const checkFramebufferStatus = context.checkFramebufferStatus.bind(context);
    context.checkFramebufferStatus = (target) => {
      counts.framebufferChecks++;
      return checkFramebufferStatus(target);
    };
    const getParameter = context.getParameter.bind(context);
    context.getParameter = (name) => {
      if (name === 0x84ff) counts.anisotropyReads++;
      return getParameter(name);
    };
    for (let refresh = 0; refresh < 5; refresh++) renderer.createShadowMap();
    const imageCanvas = () => {
      const image = document.createElement('canvas');
      image.width = 8;
      image.height = 8;
      return image;
    };
    for (let texture = 0; texture < 4; texture++) renderer.createTexture({ image: imageCanvas() });
    return counts;
  };
  return page.evaluate(task);
}

test('shadow map refreshes check the framebuffer once per size and textures read the anisotropy limit once', async (context) => {
  await withDevServerPage(context, async (page) => {
    const counts = await countRoundTrips(page);
    assert.equal(counts.framebufferChecks, 0, 'the constructor already checked the shadow framebuffer at this size');
    assert.ok(counts.anisotropyReads <= 1, `the anisotropy limit was read ${counts.anisotropyReads} times`);
  });
});
