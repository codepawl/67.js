// Writes a PNG from RGBA pixels read with readPixels (bottom row first): node bench/glaze-passes/png.mjs <frame.rgba> <out.png> [width]
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function checksum(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(checksum(body));
  return Buffer.concat([length, body, crc]);
}

/** Encodes bottom-up RGBA pixels as a PNG. */
export function encodePng(pixels, width) {
  const height = pixels.length / 4 / width;
  const rows = [];
  for (let row = height - 1; row >= 0; row--) rows.push(Buffer.concat([Buffer.from([0]), pixels.subarray(row * width * 4, (row + 1) * width * 4)]));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [inputFile, outputFile, width = '1280'] = process.argv.slice(2);
  if (!inputFile || !outputFile) throw new Error('Pass the .rgba file and the .png file to write.');
  await writeFile(outputFile, encodePng(await readFile(inputFile), Number(width)));
}
