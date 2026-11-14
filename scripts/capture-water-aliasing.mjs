// Renders the open-sea views of #827 (beauty and low camera) at 336x189 and as a 3x supersampled reference, at three small camera
// pan steps, for scripts/score-water-aliasing.mjs. Needs a GPU. Run it through gpu-lock.
//   node scripts/capture-water-aliasing.mjs <output directory>
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(process.argv[2] ?? 'artifacts/water-aliasing');
const VIEW_EYES = { beauty: [-4, 8, 80], low: [-4, 2, 80] };
const PAN_STEPS = [0, 0.25, 0.5];

function seaRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{
      id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0.002 },
      edits: [
        { op: 'delete', select: { not: { normal: [0, 1, 0], maxAngle: 10 } } },
        { op: 'subdivide_edges', edges: { all: true }, cuts: 16 },
        { op: 'subdivide', levels: 4 },
        { op: 'set_position', position: { mul: [{ attr: 'position' }, [400, 1, 400]] } },
        { op: 'ocean', axis: 'y', windSpeed: 16, direction: 100, choppiness: 1.5, size: 50, seed: 7, time: 2, resolution: 10 },
      ],
    }],
    materials: [{ id: 'water', tag: 'water', color: [0.0033, 0.042, 0.069], metallic: 0, roughness: 0.14 }],
    nodes: [{ id: 'sea', geometry: 'sea', material: 'water' }],
    camera: { eye: [-4, 8, 80], target: [0, 0, 0], fov: 50 },
    effects: { exposure: 0.6 },
    environment: { sky: { type: 'physical', sunElevation: 9, sunRotation: 0, turbidity: 2, aerialPerspective: 0.3 }, world: true, ground: false, fogDensity: 0.0008 },
  };
}

// Frame time proxy: the median of 15 full-size looks of the same scene. Compare two checkouts on a quiet machine.
async function printMedianLookTime(client, sessionId, view) {
  const timings = [];
  for (let repeat = 0; repeat < 15; repeat += 1) {
    const started = performance.now();
    await client.callTool({ name: 'scene_look', arguments: { sessionId, width: 1024, height: 576 } }, { timeout: 300000 });
    timings.push(performance.now() - started);
  }
  timings.sort((first, second) => first - second);
  console.log('median look', view, timings[7].toFixed(1), 'ms (min', timings[0].toFixed(1), 'max', timings[14].toFixed(1), ')');
}

await mkdir(outputDirectory, { recursive: true });
const workDirectory = await mkdtemp(join(tmpdir(), 'crucible-water-aliasing-'));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repositoryRoot, 'bin/crucible-mcp.mjs'), '--backend', 'gpu', '--memory', '384', '--jobs', join(workDirectory, 'jobs')],
  cwd: workDirectory, stderr: 'pipe',
});
const client = new Client({ name: 'water-aliasing', version: '1' });
await client.connect(transport);
try {
  for (const [view, eye] of Object.entries(VIEW_EYES)) {
    for (const [index, pan] of PAN_STEPS.entries()) {
      const recipe = seaRecipe();
      recipe.camera = { eye: [eye[0] + pan, eye[1], eye[2]], target: [pan, 0, 0], fov: 50 };
      const created = await client.callTool({ name: 'scene_create', arguments: { recipe } }, { timeout: 300000 });
      if (created.isError) throw new Error(JSON.stringify(created.content).slice(0, 800));
      const sessionId = created.structuredContent.sessionId;
      for (const [name, width, height] of [['n', 336, 189], ['ref', 1008, 567]]) {
        const started = performance.now();
        const look = await client.callTool({ name: 'scene_look', arguments: { sessionId, width, height } }, { timeout: 300000 });
        const image = look.content.find(item => item.type === 'image')?.data;
        if (!image) throw new Error(JSON.stringify(look.content).slice(0, 600));
        await writeFile(join(outputDirectory, `${view}-${index}-${name}.png`), Buffer.from(image, 'base64'));
        console.log('look', view, index, name, Math.round(performance.now() - started), 'ms');
      }
      if (index === 0) await printMedianLookTime(client, sessionId, view);
      await client.callTool({ name: 'scene_dispose', arguments: { sessionId } });
    }
  }
} finally {
  await client.close();
}
