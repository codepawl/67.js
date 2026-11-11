// Effects on the cut geometry (issue #751): does a screen-space stage (ambient occlusion, depth of field, line art) draw a seam,
// halo or speckle where the flush pass cut or ranked faces? Each stacked trap has a flat tiling (TILED_TRAPS) that shows the same
// picture with no face over another, so nothing is cut or ranked and nothing can fight. The probe renders the trap with the flush
// pass and its tiling, once with no effect and once through each effect, and counts the pixels that differ between the two.
//   node bench/flicker/effects-probe.mjs --asset /@fs/D:/path/city.glb --spots spots.json   the same on a model's camera spots, with the
// flush pass off (offset=0) as the other picture: there faces that are not stacked match, so `staged` above `plain` is again the effect.
//   node bench/flicker/effects-probe.mjs --url http://127.0.0.1:5261 --effects ao,dof,lines --out artifacts/flicker-effects
// `plain` is the difference with no effect: edge pixels where the cut and the tiling put a triangle edge in a different place.
// `staged` is the difference through the effect. Only `staged` above `plain` is the effect's own doing. Counts are pixels whose
// largest channel differs by more than 8 (`small`) and more than 32 (`large`) of 255.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

// Traps with a flat tiling (TILED_TRAPS in traps.js). Any other trap, and any asset, is compared with the flush pass off instead.
const HAS_TILING = new Set(['plaque-2m', 'plaque-20m', 'stack-30-exact']);
const baseUrl = argument('url', 'http://127.0.0.1:5261');
const outputFolder = argument('out', 'artifacts/flicker-effects');
const [width, height] = argument('viewport', '1280x720').split('x').map(Number);
const effects = argument('effects', 'ao,dof,lines').split(',');
const traps = argument('traps', 'plaque-2m,plaque-20m,stack-30-exact').split(',');
const assetPath = argument('asset');
const spots = assetPath ? JSON.parse(readFileSync(argument('spots'), 'utf8')) : [];
const extraQuery = argument('query', 'reversed=1');
mkdirSync(outputFolder, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: process.env.RENDER_CPU === '1'
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding']
    : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.setDefaultTimeout(240000);
page.on('pageerror', error => console.error('pageerror', error.message));

async function capture(trap, { tiled, effect, spot = null }) {
  const subject = assetPath ? { asset: assetPath, ids: '1', shadows: '0' } : { trap };
  const query = new URLSearchParams({ ...subject, ...(tiled ? { ...(assetPath || !HAS_TILING.has(trap) ? {} : { tiled: '1' }), offset: '0' } : {}), ...(effect ? { effect } : {}) });
  await page.goto(`${baseUrl}/bench/flicker/index.html?${query}&${extraQuery}`);
  await page.evaluate(() => window.flicker.ready);
  if (assetPath) {
    await page.waitForFunction(() => window.flicker.info.bounds, null, { polling: 500 });
    if (!tiled) await page.waitForFunction(() => window.flicker.info.flush, null, { polling: 500 });
  }
  await page.waitForTimeout(300);
  const shot = await page.evaluate(({ eye, target }) => {
    if (eye) window.flicker.setCamera({ eye, target });
    return { ...window.flicker.frameBase64(), flush: window.flicker.info.flush };
  }, spot ?? {});
  return { width: shot.width, height: shot.height, flush: shot.flush, bytes: Buffer.from(shot.base64, 'base64') };
}

function compare(first, second) {
  const counts = { small: 0, large: 0, maximum: 0, firstX: null };
  for (let offset = 0; offset < first.bytes.length; offset += 4) {
    const difference = Math.max(Math.abs(first.bytes[offset] - second.bytes[offset]), Math.abs(first.bytes[offset + 1] - second.bytes[offset + 1]), Math.abs(first.bytes[offset + 2] - second.bytes[offset + 2]));
    if (difference > counts.maximum) counts.maximum = difference;
    if (difference > 8) counts.small++;
    if (difference > 32) counts.large++;
  }
  return counts;
}

// Pixels the effect changed (largest channel by more than 8) with no colour edge of the plain frame within two pixels. Where a
// frame has no edge the effect has nothing to work on, so a changed pixel there is a seam, halo or speckle (a surface with real
// occlusion at a crease is the exception, and it counts the same in the two pictures being compared). Needs no reference scene.
function spurious(effectShot, plainShot) {
  const { width: columns, height: rows } = plainShot;
  const bytes = plainShot.bytes;
  const step = (first, second) => Math.max(Math.abs(bytes[first] - bytes[second]), Math.abs(bytes[first + 1] - bytes[second + 1]), Math.abs(bytes[first + 2] - bytes[second + 2]));
  const nearEdge = new Uint8Array(columns * rows);
  for (let row = 1; row < rows - 1; row++) {
    for (let column = 1; column < columns - 1; column++) {
      const at = (row * columns + column) * 4;
      if (Math.max(step(at, at + 4), step(at, at - 4), step(at, at + columns * 4), step(at, at - columns * 4)) <= 12) continue;
      for (let nearRow = row - 2; nearRow <= row + 2; nearRow++) {
        for (let nearColumn = column - 2; nearColumn <= column + 2; nearColumn++) nearEdge[nearRow * columns + nearColumn] = 1;
      }
    }
  }
  let count = 0;
  for (let pixel = 0; pixel < columns * rows; pixel++) {
    if (nearEdge[pixel]) continue;
    const at = pixel * 4;
    const change = Math.max(Math.abs(effectShot.bytes[at] - bytes[at]), Math.abs(effectShot.bytes[at + 1] - bytes[at + 1]), Math.abs(effectShot.bytes[at + 2] - bytes[at + 2]));
    if (change > 8) count++;
  }
  return count;
}

async function save(shot, name) {
  const { default: sharp } = await import('sharp');
  await sharp(shot.bytes, { raw: { width: shot.width, height: shot.height, channels: 4 } }).png().toFile(path.join(outputFolder, `${name}.png`));
}

const rows = [];
try {
  const subjects = assetPath ? spots : traps.map(name => ({ name }));
  for (const subject of subjects) {
    const trap = subject.name;
    const spot = assetPath ? subject : null;
    const plainStacked = await capture(trap, { tiled: false, effect: null, spot });
    const plainTiled = await capture(trap, { tiled: true, effect: null, spot });
    const plain = compare(plainStacked, plainTiled);
    for (const effect of effects) {
      const stacked = await capture(trap, { tiled: false, effect, spot });
      const tiled = await capture(trap, { tiled: true, effect, spot });
      const staged = compare(stacked, tiled);
      rows.push({ trap, effect, plain, staged, spurious: { flushOn: spurious(stacked, plainStacked), reference: spurious(tiled, plainTiled) }, flush: stacked.flush && { cutParts: stacked.flush.cutParts, ranked: stacked.flush.ranked, leftovers: stacked.flush.leftovers?.length } });
      console.log(JSON.stringify(rows.at(-1)));
      if (process.argv.includes('--save')) {
        await save(stacked, `${trap}-${effect}-stacked`);
        await save(tiled, `${trap}-${effect}-tiled`);
      }
    }
  }
  writeFileSync(path.join(outputFolder, 'effects-results.json'), JSON.stringify(rows, null, 1));
} finally {
  await browser.close();
}
