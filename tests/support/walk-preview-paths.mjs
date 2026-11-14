// Runs in a fresh process with NO scene-module preload, so the on-demand modules (mesh, motion, ...) start unloaded, the
// way they do in a new preview page. Walks every preview path that reads a scene and prints the messages of the ones that
// fail with the "loads on demand" error. tests/agent-preview-modules.test.js runs it.
import { previewHarness } from './preview-harness.mjs';
import { skinnedStripAsset } from '../fixtures/skinned-strip.js';

const recipe = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'block', type: 'mesh', base: { type: 'box', bevel: 0 }, stack: [{ op: 'subdivide', levels: 1 }] }],
  materials: [{ id: 'paint', color: [0.4, 0.5, 0.6] }],
  nodes: [{ id: 'part', geometry: 'block', material: 'paint' }],
  motion: { duration: 1, loop: true, tracks: [{ kind: 'node', id: 'part', property: 'translation',
    keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [1, 0, 0] }] }] },
};
const assetRecipe = { format: 'crucible.asset', schemaVersion: 1, assetId: 'ab'.repeat(32) };

async function walk(label, createSession) {
  const harness = previewHarness();
  const sessionId = `walk-${label}`;
  await createSession(harness, sessionId);
  const { preview } = harness;
  const paths = {
    look: () => preview.look({ sessionId }),
    lookWithLabels: () => preview.look({ sessionId, labels: true }),
    review: () => {
      preview.reviewBegin({ sessionId, width: 768, height: 408 });
      return preview.reviewShot({ sessionId, index: 0, width: 384, height: 384, columns: 2, labels: true, shot: { label: 'one', rendererTime: 0 } });
    },
    snapshot: () => preview.snapshot({ sessionId, expectedRevision: 0 }),
    frame: () => preview.frame({ sessionId, rendererTime: 0 }),
    exportGlb: () => preview.exportGlb({ sessionId, maximumBytes: 32 * 1024 * 1024 }),
    inspectMeshes: () => preview.inspectMeshes({ sessionId }),
    walkMap: () => preview.walkMap({ sessionId, min: [-2, -2], max: [2, 2], cellSize: 1 }),
    exportRecipe: () => preview.exportRecipe({ sessionId }),
  };
  if (label === 'recipe') {
    paths.branchApply = () => preview.branchApply({ sessionId, name: 'warm', expectedRevision: 0,
      operations: [{ type: 'set-material', id: 'paint', color: [1, 0.5, 0.2] }] });
  }
  const failures = [];
  for (const [name, run] of Object.entries(paths)) {
    try {
      await run();
    } catch (error) {
      if (/loads on demand/.test(error.message)) failures.push(`${label}.${name}: ${error.message}`);
    }
  }
  return failures;
}

// The modules stay loaded for the rest of the process, so each scene kind walks in its own process: this one takes the
// kind from the command line.
const kind = process.argv[2];
const sessions = {
  recipe: (harness, sessionId) => harness.preview.create({ recipe, sessionId, backend: 'cpu', memoryBudgetMiB: 64 }),
  asset: (harness, sessionId) => harness.preview.createAsset({ sessionId, recipe: assetRecipe,
    data: Buffer.from(skinnedStripAsset()).toString('base64'), backend: 'cpu', memoryBudgetMiB: 64 }),
};
console.log(JSON.stringify(await walk(kind, sessions[kind])));
