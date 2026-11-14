#!/usr/bin/env node
// Builds the Marketplace downloads: validates every folder under packs/, zips it the same way every time and writes
// public/packs/<name>-<version>.zip, a preview image and public/packs/index.json. A pack that fails the pack check stops the build.
// Usage: node scripts/build-pack-index.mjs [--packs <folder>] [--out <folder>]
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import packageMetadata from '../package.json' with { type: 'json' };
import { PACK_MANIFEST_FILE } from '../src/pack-manifest.js';
import { LEGACY_ENGINE_KEY, LEGACY_PACK_MANIFEST_FILE } from '../src/legacy-names.js';
import { loadPack } from './agent-packs.mjs';
import { validatePackScene } from './pack-scene-validator.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x0021; // 1980-01-01, the earliest date a zip can hold
const STORED = 0;
const DEFLATED = 8;

async function listFiles(directory, prefix = '') {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await listFiles(join(directory, entry.name), relative));
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}

function compress(bytes) {
  const deflated = deflateRawSync(bytes, { level: 9 });
  return deflated.length < bytes.length ? { method: DEFLATED, data: deflated } : { method: STORED, data: bytes };
}

function localHeader(nameBytes, entry) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(FIXED_DOS_TIME, 10);
  header.writeUInt16LE(FIXED_DOS_DATE, 12);
  header.writeUInt32LE(entry.checksum, 14);
  header.writeUInt32LE(entry.data.length, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  return Buffer.concat([header, nameBytes]);
}

function centralHeader(nameBytes, entry, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(FIXED_DOS_TIME, 12);
  header.writeUInt16LE(FIXED_DOS_DATE, 14);
  header.writeUInt32LE(entry.checksum, 16);
  header.writeUInt32LE(entry.data.length, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt32LE(0o100644 * 0x10000, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBytes]);
}

/** Zips `files` (relative path to bytes). Sorted paths, fixed timestamps and fixed attributes make equal input give equal bytes. */
export function createZip(files) {
  const names = [...files.keys()].sort((first, second) => Buffer.compare(Buffer.from(first), Buffer.from(second)));
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const name of names) {
    const bytes = files.get(name);
    const nameBytes = Buffer.from(name, 'utf8');
    const entry = { ...compress(bytes), checksum: crc32(bytes), size: bytes.length };
    const local = Buffer.concat([localHeader(nameBytes, entry), entry.data]);
    centralParts.push(centralHeader(nameBytes, entry, offset));
    localParts.push(local);
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function readPackFiles(folder) {
  const files = new Map();
  for (const relative of await listFiles(folder)) files.set(relative, await readFile(join(folder, relative)));
  return files;
}

async function describePack(folder, outputDirectory) {
  const pack = await loadPack(folder, { packageVersion: packageMetadata.version, validateScene: validatePackScene });
  const manifestFile = existsSync(join(folder, PACK_MANIFEST_FILE)) ? PACK_MANIFEST_FILE : LEGACY_PACK_MANIFEST_FILE;
  const manifest = JSON.parse(await readFile(join(folder, manifestFile), 'utf8'));
  const stem = `${pack.name}-${pack.version}`;
  const zip = createZip(await readPackFiles(folder));
  await writeFile(join(outputDirectory, `${stem}.zip`), zip);
  const previewFile = Object.values(manifest.contents).flat().find(item => item.preview)?.preview ?? null;
  let preview = null;
  if (previewFile) {
    const previewName = `${stem}-preview${extname(previewFile).toLowerCase()}`;
    await copyFile(join(folder, previewFile), join(outputDirectory, previewName));
    preview = `/packs/${previewName}`;
  }
  const counts = Object.fromEntries(Object.entries(pack.items).filter(([, items]) => items.length > 0).map(([kind, items]) => [kind, items.length]));
  return {
    name: pack.name,
    version: pack.version,
    engines: manifest.engines['crucible'] ?? manifest.engines[LEGACY_ENGINE_KEY],
    license: pack.license,
    author: pack.author,
    description: pack.description,
    items: counts,
    preview,
    zip: `/packs/${stem}.zip`,
    bytes: zip.length,
    sha256: createHash('sha256').update(zip).digest('hex'),
  };
}

/** Validates and zips every pack folder. Throws one error that lists every pack that failed. */
export async function buildPackIndex({ packsDirectory = join(repositoryRoot, 'packs'), outputDirectory = join(repositoryRoot, 'public/packs') } = {}) {
  const source = resolve(packsDirectory);
  const output = resolve(outputDirectory);
  const folders = [];
  for (const entry of await readdir(source, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() || entry.isSymbolicLink()) folders.push(entry.name);
  }
  folders.sort();
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const packs = [];
  const failures = [];
  for (const name of folders) {
    try {
      packs.push(await describePack(join(source, name), output));
    } catch (error) {
      failures.push(error.message);
    }
  }
  if (failures.length > 0) throw new Error(`Refusing to publish ${failures.length} invalid pack${failures.length === 1 ? '' : 's'}:\n${failures.join('\n')}`);
  const seen = new Set();
  for (const pack of packs) {
    const key = `${pack.name}-${pack.version}`;
    if (seen.has(key)) throw new Error(`Two pack folders publish ${key}. Give each pack its own name or version.`);
    seen.add(key);
  }
  packs.sort((first, second) => first.name.localeCompare(second.name));
  await writeFile(join(output, 'index.json'), `${JSON.stringify({ schemaVersion: 1, packs }, null, 2)}\n`);
  return packs;
}

function optionValue(name) {
  const position = process.argv.indexOf(name);
  return position === -1 ? undefined : process.argv[position + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const packs = await buildPackIndex({ packsDirectory: optionValue('--packs'), outputDirectory: optionValue('--out') });
    for (const pack of packs) console.log(`pack ${pack.name} ${pack.version} ${pack.bytes} bytes sha256 ${pack.sha256.slice(0, 12)}`);
    if (packs.length === 0) console.log('no packs found');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
