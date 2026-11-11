// Builds the "first view" of a hero world: a crop of the full world that holds only what the camera sees during the first seconds of
// the flight, small enough for the home page to download and draw within a few seconds on a slow link while the full world streams in.
//
//   node scripts/build-hero-first-view.mjs [--scene port] [--flight-seconds 5] [--near-pixels 3] [--far-pixels 6]
//        [--near-texture 512] [--far-texture 128] [--webp-quality 70] [--output <file>]
//
// The full world is the committed pair public/showcase/<scene>/scene.glb and scene.rest.glb. This script joins them in memory and
// reads the flight from src/hero-lab/loop/scenes.js. A triangle no camera pose of the first --flight-seconds sees is dropped. The
// rest is cut into bands by its distance from the nearest pose, and each band is simplified until the error is --near-pixels on
// screen (--far-pixels beyond 400 m), so near geometry keeps its mesh and the far yard is coarse. Textures of materials seen from
// nearer than 400 m keep --near-texture pixels, the rest get --far-texture. Every material that is still in view keeps its name,
// so the page swaps to the full world with few shader changes. Nothing is read from the network.
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dequantize, mergeDocuments, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { CROP_DEFAULTS, cropDocument, sampleFlightPoses, scaleTexturesByDistance } from './hero-first-view-crop.mjs';
import { recodeGlbTextures } from './recode-glb-textures.mjs';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = { scene: 'port', flightSeconds: CROP_DEFAULTS.flightSeconds, nearPixels: CROP_DEFAULTS.nearPixels, farPixels: CROP_DEFAULTS.farPixels, nearTexture: 512, farTexture: 128, webpQuality: 70, output: '' };

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

export async function buildFirstView(options) {
  const directory = resolve(SCRIPT_DIRECTORY, '..', 'public', 'showcase', options.scene);
  await MeshoptSimplifier.ready;
  const { io, document } = await readJoinedWorld(directory);
  const poses = sampleFlightPoses(options.scene, options.flightSeconds);
  const cropOptions = { ...CROP_DEFAULTS, flightSeconds: options.flightSeconds, nearPixels: options.nearPixels, farPixels: options.farPixels };
  const { nearestByMaterial, totals } = cropDocument(document, poses, cropOptions);
  await scaleTexturesByDistance(document, nearestByMaterial, { farFrom: cropOptions.farFrom, nearTexture: options.nearTexture, farTexture: options.farTexture, webpQuality: options.webpQuality });
  await document.transform(prune({ keepLeaves: false }));
  await document.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 16, quantizeNormal: 8, quantizeTexcoord: 16 }));
  const written = Buffer.from(await io.writeBinary(document));
  const recoded = await recodeGlbTextures(written, { webpQuality: options.webpQuality, maxTexture: options.nearTexture });
  const report = `triangles per band ${totals.join('/')} (${totals.reduce((sum, count) => sum + count, 0)} total)`;
  return { glb: recoded.glb, report };
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
