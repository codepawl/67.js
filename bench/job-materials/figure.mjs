// The before / after / Cycles picture of one parity scene as a JPEG.
//   node bench/job-materials/figure.mjs <folder> <scene> <output.jpg>
// Reads <scene>-before.npy, <scene>-cook.npy and <scene>-cycles.npy (linear RGB, rows from the top), shows them with the
// display transform of a job (ACES, gamma 2.2) side by side, left to right, and writes a JPEG under 400 KB.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { toneMapToRgba8 } from '../../src/path-tracer.js';

function readNpy(path) {
  const bytes = readFileSync(path);
  const headerLength = bytes.readUInt16LE(8);
  const header = bytes.toString('ascii', 10, 10 + headerLength);
  const [height, width] = header.match(/\((\d+), (\d+), 3\)/).slice(1).map(Number);
  const data = new Float32Array(bytes.buffer.slice(bytes.byteOffset + 10 + headerLength, bytes.byteOffset + bytes.length));
  return { width, height, data };
}

const LABEL_HEIGHT = 28;

async function panel(path, label) {
  const { width, height, data } = readNpy(path);
  const rgba = toneMapToRgba8(data, width, height);
  const labelSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL_HEIGHT}"><rect width="100%" height="100%" fill="#111"/>`
    + `<text x="10" y="19" font-family="sans-serif" font-size="15" fill="#eee">${label}</text></svg>`);
  const image = await sharp(Buffer.from(rgba.buffer), { raw: { width, height, channels: 4 } }).removeAlpha().png().toBuffer();
  return { width, height: height + LABEL_HEIGHT, input: await sharp({ create: { width, height: height + LABEL_HEIGHT, channels: 3, background: '#111' } })
    .composite([{ input: image, top: 0, left: 0 }, { input: labelSvg, top: height, left: 0 }]).png().toBuffer() };
}

const [folder, scene, output] = process.argv.slice(2);
if (!folder || !scene || !output) throw new RangeError('Usage: figure.mjs <folder> <scene> <output.jpg>');
const panels = [await panel(join(folder, `${scene}-before.npy`), 'before'), await panel(join(folder, `${scene}-cook.npy`), 'after'), await panel(join(folder, `${scene}-cycles.npy`), 'Cycles 4096 spp')];
const totalWidth = panels.reduce((sum, entry) => sum + entry.width, 0);
let left = 0;
const composites = panels.map(entry => {
  const placed = { input: entry.input, top: 0, left };
  left += entry.width;
  return placed;
});
for (const quality of [85, 75, 65, 55, 45]) {
  const jpeg = await sharp({ create: { width: totalWidth, height: panels[0].height, channels: 3, background: '#111' } }).composite(composites).jpeg({ quality }).toBuffer();
  if (jpeg.length < 400 * 1024 || quality === 45) {
    writeFileSync(output, jpeg);
    console.log(JSON.stringify({ output, bytes: jpeg.length, quality }));
    break;
  }
}
