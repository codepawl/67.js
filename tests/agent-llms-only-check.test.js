import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { checkPng } from '../bench/agent-modeling/png-check.mjs';

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/** An RGB PNG of `size` squared pixels whose colour comes from `pixelAt(x, y)`, every row stored with filter 0. */
function makePng(size, pixelAt) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) row.set(pixelAt(x, y), 1 + x * 3);
    rows.push(row);
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

async function checkBytes(bytes) {
  const folder = await mkdtemp(join(tmpdir(), 'crucible-png-check-'));
  try {
    const path = join(folder, 'scene.png');
    await writeFile(path, bytes);
    return await checkPng(path, { minimumBytes: 0 });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('a picture with a shaded disc on a plain background passes', async () => {
  const disc = makePng(300, (x, y) => {
    const distance = Math.hypot(x - 150, y - 150);
    return distance < 90 ? [255 - Math.floor(distance), 40, 30 + Math.floor(distance)] : [30, 30, 30];
  });
  assert.equal((await checkBytes(disc)).pass, true);
});

test('a flat picture, a tiny picture and a file that is not a PNG fail', async () => {
  assert.equal((await checkBytes(makePng(300, () => [30, 30, 30]))).pass, false);
  assert.equal((await checkBytes(makePng(64, (x, y) => [x * 3, y * 3, 0]))).pass, false);
  assert.equal((await checkBytes(Buffer.from('not an image at all, just text'))).pass, false);
});

test('a missing file fails with a reason', async () => {
  const result = await checkPng(join(tmpdir(), 'crucible-no-such-scene.png'));
  assert.equal(result.pass, false);
  assert.match(result.detail, /does not exist/);
});
