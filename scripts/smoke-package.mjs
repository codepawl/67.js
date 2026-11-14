import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DEFAULT_BASE_REF, baseRefExists, measureBaseArchive, readAcceptedBundles } from './size-base.mjs';
import { archiveCeilingProblem, archiveGrowthProblem } from './size-growth.mjs';

const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const release = JSON.parse(await readFile('public/release.json', 'utf8'));
const sizeBudgets = JSON.parse(await readFile('bench/size/budgets.json', 'utf8'));
const archive = resolve('public', release.tarball.slice(1));
const binary = await readFile(archive);
assert.equal(release.version, metadata.version);
assert.equal(release.packageName, metadata.name);
assert.equal(release.packageAlias, 'crucible');
assert.equal(release.integrity, `sha512-${createHash('sha512').update(binary).digest('base64')}`);
assert.ok(binary.length <= sizeBudgets.archiveBytes, `Library and optional addon wrappers must fit within the archive budget of ${sizeBudgets.archiveBytes} bytes.`);
assert.ok((await readFile('build/67.module.js')).length < 150000, 'The core must exclude the optional asset decoder.');
// The archive is measured against the base branch like a bundle. The release ceiling in budgets.json is reported, and
// npm run smoke:package -- --absolute enforces it.
async function checkArchiveSize(archiveBytes) {
  const baseRef = process.env.SIZE_BASE_REF ?? DEFAULT_BASE_REF;
  if (baseRefExists(baseRef)) {
    const accepted = readAcceptedBundles(baseRef);
    const growthFailure = archiveGrowthProblem(archiveBytes, await measureBaseArchive(baseRef), accepted);
    assert.ok(!growthFailure, growthFailure);
  } else {
    console.log(`No ${baseRef} to compare the archive with, so the archive growth check is skipped. Fetch it, or set SIZE_BASE_REF.`);
  }
  const ceilingFailure = archiveCeilingProblem(archiveBytes, sizeBudgets.archiveBytes);
  if (ceilingFailure && process.argv.includes('--absolute')) assert.fail(ceilingFailure);
  if (ceilingFailure) console.log(ceilingFailure);
}
const consumer = await mkdtemp(resolve(tmpdir(), 'crucible-consumer-'));
await writeFile(resolve(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
const npmCli = process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const published = process.argv.includes('--published');
// Release preparation preserves the registry archive for an already-published version.
// Validate the current source through a separate local pack, without replacing that archive.
let installTarget;
if (published) {
  assert.equal(release.registryPublished, true, 'Published consumer checks require registry-backed release metadata.');
  installTarget = `crucible@npm:${metadata.name}@${metadata.version}`;
} else {
  const sourcePack = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', consumer], { windowsHide: true, encoding: 'utf8' });
  assert.equal(sourcePack.status, 0, sourcePack.stderr);
  const sourcePackResult = JSON.parse(sourcePack.stdout);
  const packedSource = Array.isArray(sourcePackResult) ? sourcePackResult[0] : sourcePackResult[metadata.name];
  assert.ok(packedSource?.filename, 'npm pack must return a source archive.');
  await checkArchiveSize(packedSource.size);
  const sourceArchive = resolve(consumer, packedSource.filename);
  installTarget = `crucible@file:${sourceArchive.replaceAll('\\', '/')}`;
}
const installed = spawnSync(process.execPath, [npmCli, 'install', installTarget, '@dimforge/rapier3d-compat@0.21.0', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumer, windowsHide: true, encoding: 'utf8' });
assert.equal(installed.status, 0, installed.stderr);
if (published) {
  const installedLock = JSON.parse(await readFile(resolve(consumer, 'package-lock.json'), 'utf8'));
  assert.equal(installedLock.packages['node_modules/crucible'].integrity, release.integrity, 'Installed npm package differs from release integrity.');
}
const example = `import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION, CrucibleRenderer, box, assemblyOffset, cameraView, fitPerspectiveDistance, createAnimationClip, sampleAnimationClip, EFFECT_PRESETS, createMorphPose, MAX_MORPH_TARGETS, exportGlb } from 'crucible';
import { createModel } from 'crucible/addons/model';
import * as nature from 'crucible/addons/nature';
import { createMotionScene } from 'crucible/addons/motion';
import { createCanvas2D } from 'crucible/addons/canvas2d';
import { parseGltf } from 'crucible/addons/gltf';
import { sculptGeometry } from 'crucible/addons/sculpt';
import { createSurfacePatch } from 'crucible/addons/surface';
import { createMeshQueryIndex, createMeshPairQuery } from 'crucible/addons/mesh-query';
import { meshFromGeometry, lintMesh } from 'crucible/addons/mesh';
import { shrinkwrapGeometry } from 'crucible/addons/shrinkwrap';
import { createPhysicsScene, planPhysicsScene } from 'crucible/addons/physics';
assert.equal(VERSION, '${metadata.version}');
assert.equal(typeof CrucibleRenderer, 'function');
assert.equal(MAX_MORPH_TARGETS, 64);
assert.ok(createMorphPose(64).weights instanceof Float32Array);
const morphGeometry = box();
morphGeometry.colors = new Float32Array(morphGeometry.positions.length).fill(0.75);
morphGeometry.uvs = new Float32Array(morphGeometry.positions.length / 3 * 2).fill(-0.25);
morphGeometry.morphTargets = [{ positions: new Float32Array(morphGeometry.positions.length).fill(0.125) }];
const morphPose = createMorphPose(1);
morphPose.weights[0] = -0.5;
const morphSnapshot = exportGlb([{ name: 'packed morph', geometry: morphGeometry, morph: morphPose, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material: { color: [0.5, 0.5, 0.5], emissiveColor: [1, 0.25, 0], metallic: 0, roughness: 0.7, emission: 4 } }]);
const morphHeader = new DataView(morphSnapshot);
const morphDocument = JSON.parse(new TextDecoder().decode(new Uint8Array(morphSnapshot, 20, morphHeader.getUint32(12, true))));
assert.deepEqual(morphDocument.nodes[0].weights, [-0.5]);
assert.ok(Number.isInteger(morphDocument.meshes[0].primitives[0].targets[0].POSITION));
const importedMorph = await parseGltf(morphSnapshot);
assert.equal(importedMorph.parts.length, 1);
assert.deepEqual(Array.from(importedMorph.parts[0].morph.weights), [-0.5]);
assert.deepEqual(importedMorph.parts[0].geometry.morphTargets[0].positions, morphGeometry.morphTargets[0].positions);
assert.deepEqual(importedMorph.parts[0].geometry.colors, morphGeometry.colors);
assert.deepEqual(importedMorph.parts[0].geometry.uvs, morphGeometry.uvs);
assert.deepEqual(importedMorph.parts[0].material.emissiveColor, [1, 0.25, 0]);
assert.equal(importedMorph.parts[0].material.emission, 4);
importedMorph.dispose();
assert.throws(() => new CrucibleRenderer({}, [], { environment: { pointLights: Array(17).fill({ position: [0, 1, 0] }) } }), /at most/, 'Packed renderer must validate light limits before requesting a GPU context.');
assert.ok(box().positions.length > 0);
const sculptSource = box();
const sculptOutput = sculptGeometry(sculptSource, [{ type: 'inflate', center: [0, 0, 0], radius: 10, strength: 0.05 }]);
assert.equal(sculptOutput.positions.length, sculptSource.positions.length);
assert.notDeepEqual(sculptOutput.positions, sculptSource.positions);
const packedPatch = createSurfacePatch({ geometry: sculptSource }, { position: [0, 0, 0.5], size: [0.3, 0.3, 0.1] });
assert.ok(packedPatch.indices.length > 0);
assert.ok(packedPatch.positions.some((value, index) => index % 3 === 2 && value > 0.5));
assert.equal(lintMesh(meshFromGeometry(box(0))).ok, true);
const queryGeometry = box(0);
const solidIndex = createMeshQueryIndex(queryGeometry, { solid: true });
const queryMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const outerMatrix = queryMatrix.slice();
outerMatrix[0] = outerMatrix[5] = outerMatrix[10] = 4;
const solidQuery = createMeshPairQuery(solidIndex, solidIndex, { mode: 'closed-solids' });
assert.equal(solidQuery.evaluate(outerMatrix, queryMatrix).solidRelation, 'b-in-a');
queryMatrix[12] = 2;
assert.equal(solidQuery.evaluate(outerMatrix, queryMatrix).kind, 'surface-intersection');
queryMatrix[12] = 4;
assert.equal(solidQuery.evaluate(outerMatrix, queryMatrix).kind, 'separate');
const queryHit = solidIndex.raycast(outerMatrix, { origin: [0.2, 0.3, 6], direction: [0, 0, -1] });
assert.ok(Math.abs(queryHit.distance - 4) < 1e-6);
const nearestHit = solidIndex.nearest([0.1, 0.1, 1]);
assert.ok(Math.abs(nearestHit.hit.distance - 0.5) < 1e-6);
assert.ok(nearestHit.triangleTests > 0);
const projectedHit = solidIndex.project({ origin: [0.1, 0.1, 1], direction: [0, 0, -1] });
assert.ok(Math.abs(projectedHit.hit.point[2] - 0.5) < 1e-6);
const wrappedPatch = shrinkwrapGeometry(packedPatch, queryGeometry, { clearance: 0.002, maxDistance: 1 });
assert.equal(wrappedPatch.stats.missedVertices, 0);
assert.deepEqual(wrappedPatch.geometry.indices, packedPatch.indices);
assert.deepEqual(wrappedPatch.geometry.uvs, packedPatch.uvs);
assert.ok(wrappedPatch.geometry.positions.every((value, index) => index % 3 !== 2 || Math.abs(value - 0.502) < 1e-6));
if (${!published || metadata.version !== '0.4.0'}) {
  const { createSurfaceAttachment } = await import('crucible/addons/surface-attachment');
  const attachmentMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const attachmentMorph = createMorphPose(1);
  const target = { matrix: attachmentMatrix, morph: attachmentMorph, geometry: {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    morphTargets: [{ positions: new Float32Array([0, 0, 0.2, 0, 0, 0.2, 0, 0, 0.2]) }],
  } };
  const attachment = createSurfaceAttachment(target, { triangle: 0, barycentric: [0.2, 0.3, 0.5], clearance: 0.002 });
  const retainedMatrix = attachment.matrix;
  attachmentMorph.weights[0] = 1;
  attachmentMatrix[12] = 2;
  assert.equal(attachment.update(), retainedMatrix);
  assert.ok(Math.abs(retainedMatrix[12] - 2.3) < 1e-6);
  assert.ok(Math.abs(retainedMatrix[14] - 0.202) < 1e-6);
}
solidIndex.dispose();
if (${!published}) {
  const { createAgentScene, loadAgentSceneModules, resolveAgentShadow } = await import('crucible/addons/agent-scene');
  const agentScene = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.2, 0.4, 0.5] }],
    nodes: [{ id: 'object', geometry: 'cube', material: 'paint' }],
  });
  const agentPart = agentScene.parts[0];
  const agentCheckpoint = agentScene.checkpoint();
  agentScene.apply([{ type: 'set-node', id: 'object', translation: [2, 0, 0] }], { expectedRevision: agentScene.revision });
  assert.equal(agentPart, agentScene.parts[0]);
  assert.equal(agentPart.matrix[12], 2);
  agentScene.restore(agentCheckpoint, { expectedRevision: agentScene.revision });
  assert.equal(agentPart.matrix[12], 0);
  agentScene.releaseCheckpoint(agentCheckpoint);
  const dynamicCheckpoint = agentScene.checkpoint();
  agentScene.apply([
    { type: 'add-geometry', geometry: { id: 'ball', type: 'sphere', segments: 12, rings: 8 } },
    { type: 'add-node', node: { id: 'ball', geometry: 'ball', material: 'paint', translation: [1, 0, 0] } },
  ], { expectedRevision: agentScene.revision });
  assert.equal(agentScene.parts.length, 2);
  assert.equal(agentScene.parts[0], agentPart);
  assert.equal(agentScene.topologyRevision, 1);
  agentScene.restore(dynamicCheckpoint, { expectedRevision: agentScene.revision });
  assert.equal(agentScene.parts.length, 1);
  assert.equal(agentScene.parts[0], agentPart);
  agentScene.releaseCheckpoint(dynamicCheckpoint);
  const lookCheckpoint = agentScene.checkpoint();
  const originalLook = agentScene.exportRecipe();
  agentScene.apply([
    { type: 'set-environment', environment: { lightDirection: [0, 1, 0], pointLights: [{ position: [1, 2, 3] }] } },
    { type: 'set-effects', effects: { exposure: 0.8, bloom: { strength: 0.2 } } },
  ], { expectedRevision: agentScene.revision });
  assert.deepEqual(resolveAgentShadow(agentScene.shadow, agentScene.environment.lightDirection).up, [0, 0, 1]);
  assert.equal(agentScene.parts[0], agentPart);
  agentScene.restore(lookCheckpoint, { expectedRevision: agentScene.revision });
  assert.deepEqual(agentScene.exportRecipe(), originalLook);
  agentScene.releaseCheckpoint(lookCheckpoint);
  // The recipe started as primitives; the next edit adds motion, whose code loads on demand.
  await loadAgentSceneModules({ motion: {} });
  const motionCheckpoint = agentScene.checkpoint();
  const authoredRecipe = agentScene.exportRecipe();
  agentScene.apply([{ type: 'set-motion', motion: { duration: 1, tracks: [{
    kind: 'node', id: 'object', property: 'translation', interpolation: 'SMOOTH',
    keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [3, 0, 0] }],
  }] } }], { expectedRevision: agentScene.revision });
  const motionRevision = agentScene.revision;
  agentScene.sampleMotion(1);
  assert.equal(agentPart.matrix[12], 3);
  agentScene.sampleMotion(0);
  assert.equal(agentPart.matrix[12], 0);
  assert.equal(agentScene.revision, motionRevision);
  assert.equal(agentScene.parts[0], agentPart);
  agentScene.restore(motionCheckpoint, { expectedRevision: agentScene.revision });
  assert.deepEqual(agentScene.exportRecipe(), authoredRecipe);
  agentScene.releaseCheckpoint(motionCheckpoint);
  const { createAgentAssetScene } = await import('crucible/addons/agent-asset');
  const parsedAgentAsset = await parseGltf(exportGlb(agentScene.parts));
  const importedSession = createAgentAssetScene(parsedAgentAsset, { format: 'crucible.asset', schemaVersion: 1, assetId: '0'.repeat(64) });
  const importedPart = importedSession.parts[0];
  const importedCheckpoint = importedSession.checkpoint();
  importedSession.apply([{ type: 'set-root', translation: [1, 0, 0] }], { expectedRevision: 0 });
  assert.equal(importedSession.parts[0], importedPart);
  importedSession.restore(importedCheckpoint, { expectedRevision: 1 });
  assert.equal(importedSession.parts[0], importedPart);
  assert.equal(importedSession.exportRecipe().format, 'crucible.asset');
  parsedAgentAsset.dispose();
}
const parts = createModel();
assert.equal(parts.length, 574);
assert.ok(parts.every(part => assemblyOffset(part, 1).some(value => value !== 0)));
assert.ok(Object.keys(nature).length > 0);
await assert.rejects(() => import('crucible/addons/film'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
const installedMetadata = JSON.parse(readFileSync(new URL('./node_modules/crucible/package.json', import.meta.url), 'utf8'));
const exportedEntries = Object.keys(installedMetadata.exports);
assert.ok(exportedEntries.length > 30, 'The installed package must publish its export map.');
for (const entry of exportedEntries) {
  const specifier = entry === '.' ? 'crucible' : 'crucible/' + entry.slice(2);
  const resolvedPath = fileURLToPath(import.meta.resolve(specifier));
  assert.ok(existsSync(resolvedPath), 'Export ' + entry + ' resolves to a file that is missing from the package.');
  if (entry === './package.json') continue;
  // An entry may register itself on import and export nothing, so loading without an error is the check.
  await import(specifier);
}
assert.equal(cameraView('top').projection, 'orthographic');
const fitBounds = { minimum: [-1, -1, -1], maximum: [1, 1, 1] };
const fitView = { eye: [0, 0, 5], target: [0, 0, 0], fov: 45, far: 100 };
const fitDistance = fitPerspectiveDistance(fitBounds, fitView, 0.5, 1);
assert.ok(Math.abs(fitDistance - (1 + 2 / Math.tan(Math.PI / 8))) < 1e-10);
assert.ok(EFFECT_PRESETS.cinematic.bloom.strength > 0);
const clip = createAnimationClip({ duration: 2, tracks: [{ target: 'cube', property: 'value', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 2 }] }] });
assert.equal(sampleAnimationClip(clip, 1)[0].value, 1);
assert.ok(createMotionScene().parts.length > 0);
assert.ok(createCanvas2D().parts.length > 0);
assert.equal(typeof parseGltf, 'function');
const physicsDefinition = {
  bodies: [{ name: 'floor', type: 'fixed', translation: [0, -0.5, 0] }, { name: 'ball', translation: [0, 2, 0] }],
  colliders: [{ name: 'floor', body: 'floor', shape: 'cuboid', halfExtents: [4, 0.5, 4] }, { name: 'ball', body: 'ball', shape: 'ball', radius: 0.25, mass: 1 }],
};
assert.ok(planPhysicsScene(physicsDefinition, { frameCount: 121 }).timelineBytes > 0);
const physics = await createPhysicsScene(physicsDefinition, { frameCount: 121 });
const finalPose = physics.sample(physics.duration);
assert.ok(finalPose[8] >= 0.23 && finalPose[8] < 0.3, 'Packed addon wrapper must run real Rapier floor contact.');
physics.sample(0);
assert.deepEqual(physics.sample(physics.duration), finalPose);
physics.dispose();
const motorScene = await createPhysicsScene({
  gravity: [0, 0, 0],
  bodies: [{ name: 'base', type: 'fixed' }, { name: 'slider' }],
  colliders: [{ name: 'slider', body: 'slider', shape: 'ball', radius: 0.25, mass: 1 }],
  joints: [{ name: 'drive', type: 'prismatic', bodyA: 'base', bodyB: 'slider', axis: [1, 0, 0], limits: [-1, 1], motor: { mode: 'position', target: 0.5, stiffness: 40, damping: 8, maxForce: 10 } }],
}, { frameCount: 241 });
const motorPose = motorScene.sample(motorScene.duration);
assert.ok(Math.abs(motorPose[7] - 0.5) < 0.02, 'Packed motor API must reach its bounded slider target through the real solver.');
motorScene.sample(0);
assert.deepEqual(motorScene.sample(motorScene.duration), motorPose);
motorScene.dispose();
console.log('Clean consumer: core, geometry, addons, real physics contact and all574 explosion offsets passed.');`;
await writeFile(resolve(consumer, 'check.mjs'), example);
const result = spawnSync(process.execPath, ['check.mjs'], { cwd: consumer, windowsHide: true, encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
console.log(`${published ? 'Published npm' : 'Source archive'} ${metadata.version}: ${result.stdout.trim()}`);
