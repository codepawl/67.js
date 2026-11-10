// Averages a Radiance .hdr down to a smaller flat RGBE file so a world's sky costs kilobytes, not megabytes.
//   node scripts/downsample-hdr.mjs <source.hdr> <target.hdr> <width> <height>
import { readFileSync, writeFileSync } from 'node:fs';
import { parseRadianceHdr } from '../src/hdri.js';

const [sourcePath, targetPath, widthText, heightText] = process.argv.slice(2);
const targetWidth = Number(widthText);
const targetHeight = Number(heightText);
if (!sourcePath || !targetPath || !(targetWidth > 0) || !(targetHeight > 0)) throw new Error('Pass <source.hdr> <target.hdr> <width> <height>.');
const { width, height, data } = parseRadianceHdr(readFileSync(sourcePath));
const blockWidth = Math.max(1, Math.floor(width / targetWidth));
const blockHeight = Math.max(1, Math.floor(height / targetHeight));
const pixels = Buffer.alloc(targetWidth * targetHeight * 4);
for (let row = 0; row < targetHeight; row++) {
  for (let column = 0; column < targetWidth; column++) {
    const sum = [0, 0, 0];
    for (let blockRow = 0; blockRow < blockHeight; blockRow++) {
      for (let blockColumn = 0; blockColumn < blockWidth; blockColumn++) {
        const texel = ((row * blockHeight + blockRow) * width + column * blockWidth + blockColumn) * 3;
        for (let channel = 0; channel < 3; channel++) sum[channel] += data[texel + channel];
      }
    }
    const average = sum.map(value => value / (blockWidth * blockHeight));
    const brightest = Math.max(...average);
    if (brightest < 1e-32) continue;
    const exponent = Math.floor(Math.log2(brightest)) + 1;
    const scale = 256 / 2 ** exponent;
    const target = (row * targetWidth + column) * 4;
    for (let channel = 0; channel < 3; channel++) pixels[target + channel] = Math.min(255, Math.round(average[channel] * scale));
    pixels[target + 3] = exponent + 128;
  }
}
const header = Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${targetHeight} +X ${targetWidth}\n`, 'latin1');
const file = Buffer.concat([header, pixels]);
writeFileSync(targetPath, file);
const check = parseRadianceHdr(file);
if (check.width !== targetWidth || check.height !== targetHeight) throw new Error('The sky does not parse back.');
console.log(`${targetPath}: ${file.length} bytes`);
