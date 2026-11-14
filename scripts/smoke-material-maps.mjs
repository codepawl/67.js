import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1700, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${process.argv[2] ?? 'http://127.0.0.1:5173'}/motion.html`);
  await page.waitForFunction(() => window.__scene?.renderer);
  const report = await page.evaluate(async () => {
    window.__scene.renderer.dispose();
    const { CrucibleRenderer, sphere } = await import('/src/index.js');
    document.body.replaceChildren();
    document.body.style.cssText = 'margin:0;padding:24px;background:#141a1c;color:white;display:flex;flex-wrap:wrap;font:16px sans-serif;gap:20px';
    const geometry = sphere(64, 32);
    const channels = {
      baseline: null, normalMap: [235, 128, 200], normalMapSmallUV: [235, 128, 200],
      metallicRoughnessMap: [255, 32, 0], occlusionMap: [0, 255, 255], emissiveMap: [255, 0, 0],
    };
    const results = {};
    let normalPixels;
    for (const [channel, color] of Object.entries(channels)) {
      const container = document.createElement('div');
      const label = document.createElement('p');
      label.textContent = channel;
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:250px;height:300px;display:block';
      container.append(label, canvas);
      document.body.append(container);
      const material = { tag: 'gltf', color: [0.3, 0.5, 0.65], metallic: 0.8, roughness: 0.55, emission: 0.3, emissiveColor: [0.2, 0.3, 0.4] };
      if (color) {
        const image = document.createElement('canvas');
        image.width = image.height = 16;
        const context = image.getContext('2d');
        context.fillStyle = `rgb(${color.join(',')})`;
        context.fillRect(0, 0, 16, 16);
        material[channel === 'normalMapSmallUV' ? 'normalMap' : channel] = { image, colorSpace: channel === 'emissiveMap' ? 'srgb' : 'linear' };
      }
      const mesh = channel === 'normalMapSmallUV' ? { ...geometry, uvs: geometry.uvs.map(value => value * 0.001) } : geometry;
      const part = { name: channel, geometry: mesh, material, matrix: new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]) };
      const renderer = new CrucibleRenderer(canvas, [part], { ground: false, shadows: false, samples: 4, pixelRatio: 1, memoryBudgetMiB: 32 });
      renderer.render({ eye: [0, 0, 5], target: [0, 0, 0] });
      const gl = renderer.context;
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let checksum = 2166136261;
      for (const value of pixels) checksum = Math.imul(checksum ^ value, 16777619) >>> 0;
      results[channel] = { checksum, error: gl.getError(), textureBytes: renderer.textureBytes };
      if (channel === 'normalMap') normalPixels = pixels;
      if (channel === 'normalMapSmallUV') {
        let difference = 0;
        for (let index = 0; index < pixels.length; index++) difference += Math.abs(pixels[index] - normalPixels[index]);
        results[channel].meanDifferenceFromNormal = difference / pixels.length;
      }
      // Keep a bitmap for the screenshot, then release the GPU context and cached maps.
      const bitmap = await createImageBitmap(canvas);
      renderer.dispose();
      const saved = document.createElement('canvas');
      saved.width = canvas.width;
      saved.height = canvas.height;
      saved.style.cssText = canvas.style.cssText;
      saved.getContext('2d').drawImage(bitmap, 0, 0);
      bitmap.close();
      canvas.replaceWith(saved);
    }
    return results;
  });
  for (const [channel, result] of Object.entries(report)) {
    assert.equal(result.error, 0, `${channel} produced a WebGL error`);
    if (channel !== 'baseline') {
      assert.notEqual(result.checksum, report.baseline.checksum, `${channel} did not change the rendered image`);
      assert.ok(result.textureBytes > report.baseline.textureBytes);
    }
  }
  assert.deepEqual(errors, []);
  assert.ok(report.normalMapSmallUV.meanDifferenceFromNormal < 0.1, 'UV scale changed tangent-space normal lighting');
  await page.screenshot({ path: 'artifacts/material-maps-reference.png' });
  await writeFile('artifacts/material-maps-reference.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
