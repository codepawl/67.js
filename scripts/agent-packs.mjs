// Installed data-only packs: reads each subfolder of the --packs directory, checks it against src/pack-manifest.js and the
// catalog's own file checks, and hands the MCP runtime its GLB, image, look and environment files (content-hash IDs, like
// --assets) plus its material and recipe JSON. Nothing is fetched and no caller-supplied path is read.
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

import { invalidField } from '../src/field-error.js';
import {
  MAXIMUM_INSTALLED_PACKS, MAXIMUM_JSON_DEPTH, MAXIMUM_PACK_BYTES, MAXIMUM_PACK_FILES, MAXIMUM_PACK_FILE_BYTES, MAXIMUM_PACK_JSON_BYTES,
  PACK_MANIFEST_FILE, findRemoteUrl, isExecutableLookingName, isPackDocumentName, validatePackManifest,
} from '../src/pack-manifest.js';
import { describeCatalogFile, readCatalogFile } from './agent-asset-catalog.mjs';

const MAXIMUM_FOLDER_DEPTH = 8;
// The catalog kind each manifest list must hold.
const CATALOG_KIND = { assets: 'glb', images: 'image', looks: 'look', environments: 'environment' };

function packError(label, detail) {
  return new Error(`pack "${label}": ${detail}`);
}

/** Lists every file of the pack as `Map(relative path -> bytes)`, refusing links, odd entries, code files and oversize packs. */
async function listPackFiles(directory, label) {
  const files = new Map();
  let totalBytes = 0;
  async function visit(folder, prefix, depth) {
    if (depth > MAXIMUM_FOLDER_DEPTH) throw packError(label, `${prefix || '.'} is nested deeper than ${MAXIMUM_FOLDER_DEPTH} folders. Flatten the pack.`);
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const relativePath = prefix + entry.name;
      const details = await lstat(join(folder, entry.name));
      if (details.isSymbolicLink()) throw invalidField(`pack "${label}" ${relativePath}`, 'a symbolic link', 'a regular file or folder; remove the link and copy the real file into the pack');
      if (details.isDirectory()) {
        await visit(join(folder, entry.name), `${relativePath}/`, depth + 1);
        continue;
      }
      if (!details.isFile()) throw invalidField(`pack "${label}" ${relativePath}`, 'a special file', 'a regular file or folder');
      if (isExecutableLookingName(entry.name)) throw invalidField(`pack "${label}" ${relativePath}`, 'a script, page or program file', 'data only: remove every .js, .html, .wasm, .exe, .sh, .bat, .ps1, .py and similar file from the pack');
      if (details.size > MAXIMUM_PACK_FILE_BYTES) throw invalidField(`pack "${label}" ${relativePath}`, `${details.size} bytes`, `at most ${MAXIMUM_PACK_FILE_BYTES} bytes (64 MiB) per file; shrink or remove it`);
      totalBytes += details.size;
      if (files.size + 1 > MAXIMUM_PACK_FILES) throw invalidField(`pack "${label}"`, `over ${MAXIMUM_PACK_FILES} files`, `at most ${MAXIMUM_PACK_FILES} files; remove unused ones or split the pack`);
      if (totalBytes > MAXIMUM_PACK_BYTES) throw invalidField(`pack "${label}"`, `over ${totalBytes} bytes`, `at most ${MAXIMUM_PACK_BYTES} bytes (256 MiB) in total; split the pack`);
      files.set(relativePath, details.size);
    }
  }
  await visit(directory, '', 0);
  return files;
}

/** Refuses a file that is not the manifest, not listed in it and not a plain text document (LICENSE, README...). */
async function assertOnlyAllowedFiles(directory, files, listedFiles, label) {
  for (const [relativePath, size] of files) {
    if (listedFiles.has(relativePath)) continue;
    const field = `pack "${label}" ${relativePath}`;
    if (!isPackDocumentName(relativePath.split('/').at(-1))) {
      throw invalidField(field, 'a file that is not listed in the manifest', `a file listed in ${PACK_MANIFEST_FILE} contents, or a LICENSE, README, NOTICE, CHANGELOG or AUTHORS text document; list it in contents or remove it`);
    }
    if (size > MAXIMUM_PACK_JSON_BYTES) throw invalidField(field, `${size} bytes`, 'a text document of at most 1 MiB; shorten or remove it');
    const bytes = await readFile(join(directory, relativePath));
    let isText = !bytes.includes(0);
    if (isText) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        isText = false;
      }
    }
    if (!isText) throw invalidField(field, 'a document that is not UTF-8 text', 'plain UTF-8 text without NUL bytes; remove the file or convert it');
  }
}

async function readJsonFile(directory, file, label, field, size) {
  if (size > MAXIMUM_PACK_JSON_BYTES) throw invalidField(`pack "${label}" ${field}`, `${file} over ${MAXIMUM_PACK_JSON_BYTES} bytes`, 'a JSON file of at most 1 MiB; split it or drop data you do not need');
  const text =(await readFile(join(directory, file), 'utf8')).replace(/^﻿/, '');
  if (Buffer.byteLength(text) > MAXIMUM_PACK_JSON_BYTES) throw invalidField(`pack "${label}" ${field}`, `${file} over ${MAXIMUM_PACK_JSON_BYTES} bytes`, 'a JSON file of at most 1 MiB; split it or drop data you do not need');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw invalidField(`pack "${label}" ${file}`, 'text that is not JSON', `valid JSON (${error.message})`, SyntaxError);
  }
}

/**
 * `validateScene(kind, id, json)` is the scene validator (scripts/pack-scene-validator.mjs). The MCP server does not carry the
 * scene engine, so it passes none and scene_create checks a recipe when the agent uses it; `npm run pack:check` passes it.
 */
async function validateJsonContent(kind, id, json, label, file, validateScene) {
  const remote = findRemoteUrl(json);
  if (remote?.tooDeep) throw invalidField(`pack "${label}" ${file}`, `JSON nested over ${MAXIMUM_JSON_DEPTH} levels`, `at most ${MAXIMUM_JSON_DEPTH} levels of nested objects and lists; flatten ${remote.path}`);
  if (remote) throw invalidField(`pack "${label}" ${file} ${remote.path}`, remote.value, 'no remote URL: a pack is data only. Reference pack files by their catalog ID, and use data:image/png|jpeg|webp;base64 only for small images');
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw invalidField(`pack "${label}" ${file}`, json, 'one JSON object');
  if (kind === 'recipes' && json.format !== '67js.scene') throw invalidField(`pack "${label}" ${file} format`, json.format, '"67js.scene", the recipe format scene_create takes');
  if (!validateScene) return;
  try {
    await validateScene(kind, id, json);
  } catch (error) {
    error.message = `pack "${label}" ${file}: ${error.message}`;
    throw error;
  }
}

/** Loads and fully validates one pack folder. Throws an error that names the pack, file and field. */
export async function loadPack(folder, { packageVersion, label = basename(String(folder)), validateScene }) {
  if (typeof folder !== 'string' || !isAbsolute(folder)) throw packError(label, 'pass the pack folder as an absolute path.');
  const folderDetails = await lstat(folder);
  if (folderDetails.isSymbolicLink() || !folderDetails.isDirectory()) throw packError(label, 'the pack must be a real folder, not a link or a file.');
  const directory = await realpath(folder);
  const files = await listPackFiles(directory, label);
  if (!files.has(PACK_MANIFEST_FILE)) throw invalidField(`pack "${label}"`, `no ${PACK_MANIFEST_FILE}`, `a ${PACK_MANIFEST_FILE} file at the pack root`);
  const manifest = validatePackManifest(await readJsonFile(directory, PACK_MANIFEST_FILE, label, PACK_MANIFEST_FILE, files.get(PACK_MANIFEST_FILE)), { label, packageVersion });
  const listedFiles = new Set([PACK_MANIFEST_FILE]);
  for (const [kind, list] of Object.entries(manifest.contents)) {
    for (const [index, item] of list.entries()) {
      for (const key of ['file', 'preview']) {
        if (item[key] === undefined) continue;
        if (!files.has(item[key])) throw invalidField(`pack "${label}" ${PACK_MANIFEST_FILE} contents.${kind}[${index}].${key}`, item[key], 'a file that exists in the pack; check the spelling and capitals');
        listedFiles.add(item[key]);
      }
    }
  }
  await assertOnlyAllowedFiles(directory, files, listedFiles, label);
  const packFiles = [];
  const json = { materials: new Map(), recipes: new Map() };
  const items = {};
  for (const [kind, list] of Object.entries(manifest.contents)) {
    items[kind] = [];
    for (const [index, item] of list.entries()) {
      const field = `contents.${kind}[${index}]`;
      if (kind === 'materials' || kind === 'recipes') {
        const content = await readJsonFile(directory, item.file, label, `${field}.file`, files.get(item.file));
        await validateJsonContent(kind, item.id, content, label, item.file, validateScene);
        json[kind].set(item.id, content);
        items[kind].push({ id: item.id, ...(item.preview && { preview: item.preview }) });
      } else {
        const result = await readFileForKind(directory, item.file, label, `${field}.file`, kind);
        packFiles.push({ directory, filename: item.file, assetId: result.assetId, metadata: describeCatalogFile(`${manifest.name}/${item.file}`, result) });
        items[kind].push({ id: item.id, assetId: result.assetId });
      }
      if (item.preview) await readFileForKind(directory, item.preview, label, `${field}.preview`, 'images');
    }
  }
  return Object.freeze({ name: manifest.name, folder: basename(directory), version: manifest.version, license: manifest.license, author: manifest.author, description: manifest.description, items, json, files: packFiles });
}

async function readFileForKind(directory, file, label, field, kind) {
  let result;
  try {
    result = await readCatalogFile(directory, file);
  } catch (error) {
    throw invalidField(`pack "${label}" ${file}`, `${field}: ${error.message}`, 'a valid file of the listed kind (self-contained GLB, PNG/JPEG/WebP, Radiance .hdr, 3D .cube)');
  }
  if (result.kind !== CATALOG_KIND[kind]) throw invalidField(`pack "${label}" ${file}`, `a ${result.kind} file`, `a ${CATALOG_KIND[kind]} file for contents.${kind}`);
  return result;
}

/** Loads every subfolder of `root` as a pack. A bad pack is reported in `rejected` and skipped. */
export async function loadPacks(root, { packageVersion, validateScene }) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new TypeError('Pack root must be an explicit absolute directory path.');
  const directory = await realpath(root);
  if (!(await lstat(directory)).isDirectory()) throw new TypeError('Pack root must be a directory.');
  const folders = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
    .map(entry => entry.name).sort();
  const packs = [];
  const rejected = [];
  for (const folder of folders) {
    try {
      if (packs.length >= MAXIMUM_INSTALLED_PACKS) throw packError(folder, `skipped: at most ${MAXIMUM_INSTALLED_PACKS} packs load at once. Remove packs from the --packs folder.`);
      const pack = await loadPack(join(directory, folder), { packageVersion, label: folder, validateScene });
      if (packs.some(other => other.name === pack.name)) throw packError(folder, `another installed pack already uses the name "${pack.name}". Rename one in its ${PACK_MANIFEST_FILE}.`);
      packs.push(pack);
    } catch (error) {
      rejected.push({ folder, error: error.message });
    }
  }
  return { packs, rejected };
}

/** The runtime's view of the installed packs: a listing, the catalog files, and read-only access to material and recipe JSON. */
export async function createPackRegistry(root, { packageVersion }) {
  const { packs, rejected } = await loadPacks(root, { packageVersion });
  return Object.freeze({
    files: packs.flatMap(pack => pack.files),
    list() {
      return {
        packs: packs.map(({ name, version, license, author, description, items }) => structuredClone({ name, version, license, author, description, items })),
        rejected: structuredClone(rejected),
      };
    },
    /** A copy of one material or recipe JSON, by pack name and id. */
    read(kind, packName, id) {
      if (kind !== 'materials' && kind !== 'recipes') throw invalidField('kind', kind, '"materials" or "recipes"');
      const pack = packs.find(candidate => candidate.name === packName);
      if (!pack) throw invalidField('pack', packName, `an installed pack name: ${packs.map(candidate => candidate.name).join(', ') || 'none installed'}`);
      const content = pack.json[kind].get(id);
      if (content === undefined) throw invalidField(kind === 'recipes' ? 'recipe' : 'material', id, `an id of this pack's ${kind}: ${pack.items[kind].map(item => item.id).join(', ') || 'none'}`);
      return structuredClone(content);
    },
  });
}
