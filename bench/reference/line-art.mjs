// Line art reference for issue #285: draws bench/reference/line-art-scene.json with outlines in Crucible at a preview size and
// at 4K, draws the same scene in Blender 5.2 with Freestyle, and compares the line masks.
//   node bench/reference/line-art.mjs [--backend gpu|cpu] [--skip-blender] [--reuse-crucible] [--width <pixels>]
// Writes PNGs and a side-by-side sheet to artifacts/line-art/ (gitignored) and prints the numbers.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readPixels, lineStrength, lineMask, maskOverlap, dilate, verticalEdgeWidths, median } from './line-art-measure.mjs';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BLENDER = process.env.BLENDER_PATH ?? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
const argumentsGiven = process.argv.slice(2);
const backend = argumentsGiven.includes('--backend') ? argumentsGiven[argumentsGiven.indexOf('--backend') + 1] : 'gpu';
const lineWidth = argumentsGiven.includes('--width') ? Number(argumentsGiven[argumentsGiven.indexOf('--width') + 1]) : 2;
const SIZES = [{ name: 'preview', width: 960, height: 540 }, { name: '4k', width: 3840, height: 2160 }];
const output = resolve('artifacts/line-art');
const BACKEND_ARGUMENTS = {
  gpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
  cpu: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
};

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(output, { recursive: true });

async function drawWithJs67() {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/bench/reference/line-art-harness.html`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BACKEND_ARGUMENTS[backend] });
  try {
    for (const size of SIZES) {
      const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
      page.on('pageerror', error => console.log('PAGE ERROR', error.message));
      await page.goto(url, { timeout: 180000 });
      await page.waitForFunction(() => window.lineArtReady, null, { timeout: 180000 });
      for (const [label, requestedWidth] of [['off', 0], ['on', lineWidth]]) {
        const frame = await page.evaluate(width => window.drawLineArtScene(width), requestedWidth);
        if (frame.glError !== 0) throw new Error(`WebGL error ${frame.glError}`);
        if (frame.width !== size.width || frame.height !== size.height) throw new Error(`Drew ${frame.width}x${frame.height}, wanted ${size.width}x${size.height}`);
        await writeFile(`${output}/js67-${size.name}-${label}.png`, Buffer.from(frame.png.split(',')[1], 'base64'));
      }
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

async function loadPair(prefix) {
  const [withoutLines, withLines] = await Promise.all(['off', 'on'].map(label => sharp(`${output}/${prefix}-${label}.png`).toBuffer().then(readPixels)));
  return { withoutLines, withLines, strength: lineStrength(withoutLines, withLines) };
}

if (!argumentsGiven.includes('--reuse-crucible')) await drawWithJs67();
const widthRows = [];
for (const size of SIZES) {
  const pair = await loadPair(`js67-${size.name}`);
  const widths = verticalEdgeWidths(pair.strength, size.width, size.height, { rowStep: 3, slopeRows: Math.round(6 * size.width / 960) });
  widthRows.push({ size: size.name, edges: widths.length, median: median(widths) });
  console.log(`Crucible ${size.name} ${size.width}x${size.height}: requested width ${lineWidth}, median vertical-edge width ${median(widths).toFixed(2)} px over ${widths.length} samples`);
}

if (!argumentsGiven.includes('--skip-blender')) {
  const preview = SIZES[0];
  const run = spawnSync(BLENDER, ['--background', '--factory-startup', '-t', '6', '--python', 'bench/reference/line-art-blender.py', '--', 'bench/reference/line-art-scene.json', output, String(preview.width), String(preview.height), String(lineWidth)], { encoding: 'utf8' });
  if (!run.stdout.includes('LINE_ART_DONE')) throw new Error(`Blender failed:\n${run.stdout.slice(-1500)}\n${run.stderr.slice(-1500)}`);
  const js67 = await loadPair('js67-preview');
  const blender = await loadPair('blender');
  const blenderWidths = verticalEdgeWidths(blender.strength, preview.width, preview.height, { rowStep: 3 });
  console.log(`Blender Freestyle ${preview.width}x${preview.height}: median vertical-edge width ${median(blenderWidths).toFixed(2)} px over ${blenderWidths.length} samples`);
  const maskJs = lineMask(js67.strength);
  const maskBlender = lineMask(blender.strength);
  const exact = maskOverlap(maskJs, maskBlender);
  const tolerant = {
    js67Found: maskOverlap(maskJs, dilate(maskBlender, preview.width, preview.height, 2)).intersection / maskJs.reduce((sum, value) => sum + value, 0),
    blenderFound: maskOverlap(maskBlender, dilate(maskJs, preview.width, preview.height, 2)).intersection / maskBlender.reduce((sum, value) => sum + value, 0),
  };
  console.log(`edge mask IoU ${exact.iou.toFixed(3)}; with 2 px tolerance, ${(tolerant.js67Found * 100).toFixed(1)}% of Crucible line pixels lie on a Blender line and ${(tolerant.blenderFound * 100).toFixed(1)}% of Blender line pixels lie on a Crucible line`);
  const sheet = await sharp({ create: { width: preview.width * 2, height: preview.height, channels: 3, background: '#fff' } })
    .composite([{ input: `${output}/js67-preview-on.png`, left: 0, top: 0 }, { input: `${output}/blender-on.png`, left: preview.width, top: 0 }])
    .png().toBuffer();
  await writeFile(`${output}/side-by-side.png`, sheet);
  await sharp(sheet).webp({ quality: 80 }).toFile(`${output}/side-by-side.webp`);
  await writeFile(`${output}/result.json`, JSON.stringify({ lineWidth, widthRows, iou: exact.iou, tolerant, blenderWidth: median(blenderWidths) }, null, 2));
}
