// Builds the "first view" of a hero world: the whole world as one small GLB (coarse meshes, small textures) that the home page can
// download and draw within a few seconds on a slow link, while the full world streams in behind it.
//
//   node scripts/build-hero-first-view.mjs [--scene port] [--world-error 1.1] [--uv-weight 1] [--max-texture 256] [--webp-quality 70] [--output <file>]
//
// The full world is the committed pair public/showcase/<scene>/scene.glb and scene.rest.glb. This script joins them in memory,
// runs scripts/simplify-hero-glb.mjs on the join with one coarse level and a small texture cap, and recodes the textures as WebP
// through scripts/recode-glb-textures.mjs. Every material of the full world stays, so the first view needs the same shader
// programs and the page swaps to the full world with no recompile. Nothing is read from the network.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dequantize, mergeDocuments, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { recodeGlbTextures } from './recode-glb-textures.mjs';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = { scene: 'port', worldError: 1.1, uvWeight: 1, maxTexture: 256, webpQuality: 70, output: '' };

export function parseArguments(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!name.startsWith('--')) throw new Error(`Unexpected argument ${name}.`);
    const key = name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!(key in DEFAULTS)) throw new Error(`Unknown option ${name}.`);
    const raw = argv[++index];
    options[key] = typeof DEFAULTS[key] === 'number' ? Number(raw) : raw;
    if (typeof DEFAULTS[key] === 'number' && !(options[key] > 0)) throw new Error(`Option ${name} needs a positive number.`);
  }
  return options;
}

async function readJoinedWorld(directory) {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
  const io = new NodeIO()
    .registerExtensions([...ALL_EXTENSIONS, EXTMeshoptCompression])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  const document = await io.read(join(directory, 'scene.glb'));
  const rest = await io.read(join(directory, 'scene.rest.glb'));
  mergeDocuments(document, rest);
  // The merge brings the rest's scene along as a second scene; its nodes join the first scene.
  const [firstScene, ...otherScenes] = document.getRoot().listScenes();
  for (const scene of otherScenes) {
    for (const node of scene.listChildren()) firstScene.addChild(node);
    scene.dispose();
  }
  firstScene.setExtras({});
  // A GLB holds one buffer: every accessor moves to the first one.
  const [firstBuffer, ...otherBuffers] = document.getRoot().listBuffers();
  for (const accessor of document.getRoot().listAccessors()) accessor.setBuffer(firstBuffer);
  for (const buffer of otherBuffers) buffer.dispose();
  // The simplifier reads float positions; the committed worlds store them quantized.
  await document.transform(dequantize());
  document.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  return { io, document };
}

// A simplification that prunes a whole primitive leaves one with no vertices; the meshopt encoder asserts on its zero-length streams.
export function removeEmptyPrimitives(document) {
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      const indices = primitive.getIndices();
      const hasNoVertices = !position || position.getCount() === 0;
      const hasNoTriangles = indices && indices.getCount() === 0;
      if (hasNoVertices || hasNoTriangles) primitive.dispose();
    }
  }
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh && mesh.listPrimitives().length === 0) node.setMesh(null);
  }
}

// The simplifier writes float attributes; the meshopt step quantizes them and compresses the vertex streams.
async function quantizedCopy(path, outputPath) {
  const io = new NodeIO()
    .registerExtensions([...ALL_EXTENSIONS, EXTMeshoptCompression])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  const document = await io.read(path);
  removeEmptyPrimitives(document);
  await document.transform(prune({ keepLeaves: false }));
  await document.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 16, quantizeNormal: 8, quantizeTexcoord: 16 }));
  await io.write(outputPath, document);
}

export async function buildFirstView(options) {
  const directory = resolve(SCRIPT_DIRECTORY, '..', 'public', 'showcase', options.scene);
  const workDirectory = mkdtempSync(join(tmpdir(), 'hero-first-view-'));
  try {
    const { io, document } = await readJoinedWorld(directory);
    const joinedPath = join(workDirectory, 'joined.glb');
    const simplifiedPath = join(workDirectory, 'simplified.glb');
    await io.write(joinedPath, document);
    const simplify = spawnSync(process.execPath, [
      join(SCRIPT_DIRECTORY, 'simplify-hero-glb.mjs'), options.scene, joinedPath, simplifiedPath,
      '--world-error', String(options.worldError), '--uv-weight', String(options.uvWeight), '--max-texture', String(options.maxTexture), '--prop-texture', String(options.maxTexture),
      '--webp-quality', String(options.webpQuality),
    ], { encoding: 'utf8' });
    if (simplify.status !== 0) throw new Error(`simplify-hero-glb failed: ${simplify.stderr || simplify.stdout}`);
    const quantizedPath = join(workDirectory, 'quantized.glb');
    await quantizedCopy(simplifiedPath, quantizedPath);
    const recoded = await recodeGlbTextures(readFileSync(quantizedPath), { webpQuality: options.webpQuality, maxTexture: options.maxTexture });
    return { glb: recoded.glb, report: simplify.stdout.trim() };
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const output = options.output || resolve(SCRIPT_DIRECTORY, '..', 'public', 'showcase', options.scene, 'scene.first.glb');
  const { glb, report } = await buildFirstView(options);
  writeFileSync(output, glb);
  console.log(report);
  console.log(JSON.stringify({ output, bytes: glb.length }));
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) await main();
