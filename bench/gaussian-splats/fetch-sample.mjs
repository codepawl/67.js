// Downloads the sample splat of the Gaussian splat benchmark into bench/gaussian-splats/data/ (git ignores that folder) and
// writes it as a standard 3DGS PLY, which is the file both Crucible and three.js then load.
//   node bench/gaussian-splats/fetch-sample.mjs
// The sample is "millipede spec." by Fabian Plum, CC BY 4.0, from https://superspl.at/scene/3d5482d4, the file that the
// three.js repository ships in examples/models/splat/millipede.splat (MIT-licensed repository, per-file licence next to it).
// The download is data: nothing in it is run. The .splat format holds 32 bytes per splat: position (3 floats), scale
// (3 floats), colour (4 bytes RGBA) and rotation (4 bytes, w x y z, each (value - 128) / 128).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/splat/millipede.splat';
const SPHERICAL_HARMONIC_DC = 0.28209479177387814;
const BYTES_PER_SPLAT = 32;
const PROPERTIES = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const dataDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'data');

function logit(unit) {
  const clamped = Math.min(254 / 255, Math.max(1 / 255, unit));
  return Math.log(clamped / (1 - clamped));
}

export function splatToPly(arrayBuffer) {
  const count = Math.floor(arrayBuffer.byteLength / BYTES_PER_SPLAT);
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const values = new Float32Array(count * PROPERTIES.length);
  for (let index = 0; index < count; index++) {
    const row = index * BYTES_PER_SPLAT;
    const output = index * PROPERTIES.length;
    for (let axis = 0; axis < 3; axis++) {
      values[output + axis] = view.getFloat32(row + axis * 4, true);
      values[output + 3 + axis] = (bytes[row + 24 + axis] / 255 - 0.5) / SPHERICAL_HARMONIC_DC;
      values[output + 7 + axis] = Math.log(Math.max(view.getFloat32(row + 12 + axis * 4, true), 1e-7));
    }
    values[output + 6] = logit(bytes[row + 27] / 255);
    for (let component = 0; component < 4; component++) {
      values[output + 10 + component] = (bytes[row + 28 + component] - 128) / 128;
    }
  }
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${count}`, ...PROPERTIES.map(name => `property float ${name}`), 'end_header', ''].join('\n');
  return Buffer.concat([Buffer.from(header, 'latin1'), Buffer.from(values.buffer)]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(dataDirectory, { recursive: true });
  const splatPath = resolve(dataDirectory, 'millipede.splat');
  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  await writeFile(splatPath, Buffer.from(await response.arrayBuffer()));
  const original = await readFile(splatPath);
  const ply = splatToPly(original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength));
  await writeFile(resolve(dataDirectory, 'millipede.ply'), ply);
  console.log(`millipede.splat ${original.length} bytes -> millipede.ply ${ply.length} bytes, ${original.length / BYTES_PER_SPLAT} splats`);
}
