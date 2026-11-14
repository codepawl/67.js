import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir('artifacts', { recursive: true });
const width = Number(process.argv[2] ?? 960);
const height = Number(process.argv[3] ?? 540);
const label = process.argv[4] ?? 'current';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/glb-fidelity-smoke.html', route => route.fulfill({
    contentType: 'text/html', body: `<canvas style="width:${width}px;height:${height}px;display:block"></canvas>`,
  }));
  await page.goto('http://127.0.0.1:5173/glb-fidelity-smoke.html');
  const results = await page.evaluate(async () => {
    const { CrucibleRenderer, exportGlb, box, sphere } = await import('/build/67.module.js');
    const { createFilmScenes } = await import('/build/film.js');
    const { parseGltf } = await import('/build/gltf.js');
    const canvas = document.querySelector('canvas');
    const portrait = createFilmScenes().portrait;
    const headJoint = portrait.parts.find(part => part.name === 'Continuous sculpted head').actorJoint;
    const headParts = portrait.parts.filter(part => part.actorJoint === headJoint);
    const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const colored = box();
    colored.colors = new Float32Array(colored.positions.length);
    const uvStorage = new Float32Array(colored.positions.length / 3 * 2 + 4);
    colored.uvs = uvStorage.subarray(2, uvStorage.length - 2);
    for (let vertex = 0; vertex < colored.positions.length / 3; vertex++) {
      colored.colors.set(vertex % 2 ? [0.02, 0.7, 0.1] : [0.8, 0.02, 0.08], vertex * 3);
      colored.uvs.set([vertex % 3 - 1.25, vertex % 4 + 0.125], vertex * 2);
    }
    const pbr = { color: [1, 1, 1], metallic: 0, roughness: 0.6, emission: 0 };
    const cases = [
      { name: 'film-head', parts: headParts, environment: portrait.environment,
        frame: { eye: [0, 1.72, 0.72], target: [0, 1.7, 0], fov: 36 } },
      { name: 'vertex-color-uv', parts: [{ name: 'Colored cube', geometry: colored, material: pbr, matrix: identity() }],
        frame: { eye: [2, 1.5, 3], target: [0, 0, 0], fov: 40 } },
      { name: 'hdr-emission', parts: [{ name: 'Warm emission, blue base', geometry: sphere(32, 24), matrix: identity(),
        material: { color: [0.01, 0.04, 0.2], emissiveColor: [1, 0.08, 0.005], emission: 5, metallic: 0, roughness: 0.7 } }],
        frame: { eye: [2, 1, 3], target: [0, 0, 0], fov: 40 } },
    ];
    const reports = [];
    function draw(parts, entry) {
      const renderer = new CrucibleRenderer(canvas, parts, {
        world: true, ground: false, samples: 2, pixelRatio: 1, hdr: true, memoryBudgetMiB: 96,
        environment: entry.environment,
      });
      renderer.render({ ...entry.frame, time: 0, effects: { grain: 0, bloom: { strength: 0 } } });
      const context = renderer.context;
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
      const image = canvas.toDataURL('image/png');
      const memory = renderer.memoryPlan;
      const glError = context.getError();
      const info = context.getExtension('WEBGL_debug_renderer_info');
      const gpu = info ? context.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unavailable';
      renderer.dispose();
      return { pixels, image, memory, glError, gpu };
    }
    for (const entry of cases) {
      const bytes = exportGlb(entry.parts);
      const asset = await parseGltf(bytes);
      const source = draw(entry.parts, entry);
      const imported = draw(asset.parts, entry);
      let maximum = 0;
      let total = 0;
      let changed = 0;
      for (let index = 0; index < source.pixels.length; index++) {
        const difference = Math.abs(source.pixels[index] - imported.pixels[index]);
        maximum = Math.max(maximum, difference);
        total += difference;
        if (difference) changed++;
      }
      const channelsMatch = entry.parts.every((part, index) => ['colors', 'uvs'].every(channel => {
        if (!part.geometry[channel]) return true;
        const decoded = asset.parts[index].geometry[channel];
        return decoded?.length === part.geometry[channel].length && part.geometry[channel].every((value, offset) => value === decoded[offset]);
      }));
      reports.push({
        name: entry.name, partCount: entry.parts.length, glbBytes: bytes.byteLength, channelsMatch,
        maximumDifference: maximum, meanDifference: total / source.pixels.length, changedChannels: changed,
        sourceGlError: source.glError, importedGlError: imported.glError, gpu: imported.gpu,
        sourceMemory: source.memory, importedMemory: imported.memory,
        sourceImage: source.image, importedImage: imported.image,
      });
      asset.dispose();
    }
    return reports;
  });
  for (const result of results) {
    for (const kind of ['source', 'imported']) {
      await writeFile(`artifacts/glb-${label}-${result.name}-${width}x${height}-${kind}.png`, Buffer.from(result[`${kind}Image`].split(',')[1], 'base64'));
      delete result[`${kind}Image`];
    }
  }
  await writeFile(`artifacts/glb-fidelity-${label}-${width}x${height}.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  assert.deepEqual(errors, []);
  for (const result of results) {
    assert.equal(result.sourceGlError, 0);
    assert.equal(result.importedGlError, 0);
    assert.equal(result.channelsMatch, true, `${result.name} discarded vertex channels.`);
    assert.ok(result.maximumDifference <= 4 && result.meanDifference < 0.005, `${result.name} changed rendered pixels beyond normal rounding tolerance.`);
  }
} finally {
  await browser.close();
}
