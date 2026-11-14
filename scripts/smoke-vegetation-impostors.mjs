// Draws one forest three ways in headless Chrome (SwiftShader unless `--gpu`): every level as it is, with impostor cards
// from level 2, and with cross-fade bands. Writes the pictures to artifacts/ and checks the cards drew something close
// to the full trees and that a fade draws both levels.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

async function evaluateWithRetry(page, task) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.evaluate(task);
    } catch (error) {
      if (attempt >= 3 || !/context was destroyed/.test(error.message)) throw error;
      await page.waitForLoadState('load');
    }
  }
}

const port = 5183;
const useGpu = process.argv.includes('--gpu');
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The smoke server did not start.')), 30000);
    server.stdout.on('data', (data) => {
      if (/ready in/.test(data.toString())) { clearTimeout(timeout); resolve(); }
    });
    server.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`The smoke server exited ${code}.`)); });
  });
  const args = useGpu ? ['--enable-webgl', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'];
  browser = await chromium.launch({ headless: true, args });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/404/.test(message.text())) errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  // Vite reloads the page once when it first optimises a dependency, which destroys a running evaluate.
  const result = await evaluateWithRetry(page, async () => {
    const { scatterVegetation, selectLevels, prepareImpostors } = await import('/src/vegetation.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const forest = scatterVegetation({ area: { minX: -260, maxX: 260, minZ: -260, maxZ: 260 }, density: 0.0016, mix: { broadleaf: 3, birch: 1.5, conifer: 2 }, seed: 5 });
    const bake = prepareImpostors(forest.variants);
    const frame = { eye: [0, 3.5, 250], target: [0, 8, 0], up: [0, 1, 0], fov: 38, near: 0.5, far: 1500, time: 1, wind: 0.3 };
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    document.body.append(canvas);
    const copy = document.createElement('canvas');
    copy.width = 960;
    copy.height = 540;
    const copyContext = copy.getContext('2d', { willReadFrequently: true });
    const draw = (view) => {
      const renderer = new CrucibleRenderer(canvas, view.parts, { ground: true, world: true, samples: 1, pixelRatio: 1 });
      renderer.render(frame);
      copyContext.drawImage(canvas, 0, 0);
      const pixels = copyContext.getImageData(0, 0, 960, 540).data;
      const picture = copy.toDataURL('image/png');
      renderer.dispose?.();
      return { pixels, picture };
    };
    const plainView = selectLevels(forest.instances, frame.eye, {});
    const cardView = selectLevels(forest.instances, frame.eye, { impostors: { from: 2 } });
    const fadeView = selectLevels(forest.instances, frame.eye, { fade: 0.12 });
    const plain = draw(plainView);
    const cards = draw(cardView);
    const fade = draw(fadeView);
    // A close shot with the card distance scaled down, against the same trees at full detail, shows what a card looks like.
    const nearFrame = { ...frame, eye: [10, 2.5, 70], target: [0, 5, 0], fov: 50 };
    Object.assign(frame, nearFrame);
    const nearTrees = draw(selectLevels(forest.instances, frame.eye, { distanceScale: 100 }));
    const nearCards = draw(selectLevels(forest.instances, frame.eye, { distanceScale: 0.2, impostors: { from: 2 } }));
    let difference = 0;
    for (let index = 0; index < plain.pixels.length; index += 4) {
      difference += Math.abs(plain.pixels[index] - cards.pixels[index]) + Math.abs(plain.pixels[index + 1] - cards.pixels[index + 1]) + Math.abs(plain.pixels[index + 2] - cards.pixels[index + 2]);
    }
    const summary = (view) => ({ triangles: view.triangles, parts: view.parts.length, impostors: view.impostors ?? 0, fading: view.fading ?? 0 });
    return {
      trees: forest.instances.length, bake,
      plain: summary(plainView), cards: summary(cardView), fade: summary(fadeView),
      meanDifference: difference / (plain.pixels.length / 4 * 3 * 255),
      pictures: { plain: plain.picture, cards: cards.picture, fade: fade.picture, 'near-trees': nearTrees.picture, 'near-cards': nearCards.picture },
    };
  });
  await mkdir('artifacts', { recursive: true });
  for (const [name, picture] of Object.entries(result.pictures)) await writeFile(`artifacts/vegetation-impostors-${name}.png`, Buffer.from(picture.split(',')[1], 'base64'));
  delete result.pictures;
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.ok(result.cards.impostors > 0 && result.cards.triangles < result.plain.triangles);
  assert.ok(result.fade.fading > 0);
  assert.ok(result.meanDifference < 0.08, `cards differ from the trees by ${result.meanDifference}`);
} finally {
  await browser?.close();
  server.kill();
}
