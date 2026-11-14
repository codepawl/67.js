// Writes public/llms.txt, the task map an agent reads first.
// The prose is here; the tool list comes from the MCP server's own registry,
// so a new, renamed or removed tool changes the file and tests/llms-txt.test.js fails until it is regenerated.
// Usage: node scripts/generate-llms.mjs          write public/llms.txt
//        node scripts/generate-llms.mjs --check  exit 1 when the file is stale
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from './mcp-server.mjs';

const siteOrigin = 'https://crucible.codepawl.com';
const outputUrl = new URL('../public/llms.txt', import.meta.url);
const maximumSummaryLength = 140;

export async function listRegisteredTools() {
  const server = createAgentMcpServer({ async close() {} });
  const client = new Client({ name: 'crucible-llms-generator', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

// First sentence of the description, cut at a word boundary. A full stop only ends
// a sentence when a letter or digit precedes it and a space follows it.
export function summarize(description) {
  const flat = description.replace(/\s+/g, ' ').trim();
  const firstSentence = flat.match(/^.*?[a-z0-9)`]\.(?=\s|$)/i)?.[0] ?? flat;
  if (firstSentence.length <= maximumSummaryLength) return firstSentence;
  const cut = firstSentence.slice(0, maximumSummaryLength - 3);
  return `${cut.slice(0, cut.lastIndexOf(' '))}...`;
}

const page = name => `${siteOrigin}/${name}`;

function taskMap() {
  const rows = [
    ['Create a scene', '`scene_capabilities`, then `scene_create` with a JSON recipe, or `scene_asset_catalog` and `scene_create_asset` for a GLB', 'agent-scene.md'],
    ['Edit parts, transforms and the camera', '`scene_inspect` for stable IDs and the revision, then `scene_apply` with `expectedRevision`', 'agent-scene.md'],
    ['Shape geometry', '`mesh_inspect`, `mesh_edit`, `mesh_stack`', 'mesh.md'],
    ['Materials, looks, HDRI, fog, effects', '`scene_apply` with `set-material`, `set-environment`, `set-effects`, `set-shadow`; `scene_asset_catalog` lists HDRI and look IDs', 'agent-look.md'],
    ['Lights and shadows', '`scene_apply` with `set-environment` (sun, sky, point lights) and `set-shadow`', 'lighting.md'],
    ['Camera and lens', '`scene_apply` with `set-camera`; check the framing with `scene_look` or `scene_review`', 'camera-path.md'],
    ['Animation', '`scene_apply` with `set-motion`; preview with `scene_look` and `motionTime`', 'agent-motion.md'],
    ['Imported character motion', '`scene_inspect` with `kind: hierarchy`, then `scene_apply` with `set-asset-node`', 'agent-character-motion.md'],
    ['Bake light', 'Put `bakes` in the recipe; `scene_capabilities` lists the fields', 'light-bake.md'],
    ['Review the result', '`scene_look` for one PNG, `scene_review` for a labeled grid of up to four views', 'agent-review.md'],
    ['Render a still or a video', '`scene_render_submit`, poll `scene_render_status`, read `scene_render_result`, then `scene_render_release`', 'agent-render-jobs.md'],
    ['Export a model', '`scene_export_glb`, or `scene_export_recipe` for the JSON recipe', 'export-glb.md'],
    ['Make a playable game', '`scene_apply` with `set-game` (topic `game` in `scene_capabilities`), then `scene_export_web` for a static folder', 'game.md'],
    ['Recover from an error', '`scene_restore` to a `scene_checkpoint`, or `scene_inspect` for the current revision and retry; every error names its next step', 'mcp.md'],
  ];
  return rows.map(([task, calls, doc]) => `- ${task}: ${calls}. [Docs](${page(doc)})`).join('\n');
}

export function buildLlmsText(tools) {
  const toolLines = tools.map(tool => `- \`${tool.name}\`: ${summarize(tool.description ?? '')}`).join('\n');
  return `# Crucible

> A 3D engine that AI agents drive. Glaze draws real-time scenes on WebGL2, and Cook path traces stills on the CPU or WebGL2, and on Vulkan with the optional Cook package. PNG, MP4 and GLB output comes from the same scene.

Crucible has an MCP server (\`crucible-mcp\`, ${tools.length} tools) that builds, edits, looks at and renders scenes from JSON recipes.
The same engine is a JavaScript library for pages and Node. The library API is in the guide below.
Scenes are plain data with stable IDs, so an agent can edit by ID and check each change with a rendered image.

## Renderers

- Glaze (\`CrucibleRenderer\`) is the real-time rasterizer. It runs on WebGL2 only.
- Cook is the path tracer. Its backends are cpu (the default), gpu (WebGL2), webgpu (a software BVH in WGSL compute) and native (Vulkan ray queries, from the optional Cook package, \`@codepawlhq/cook\`).
- An experimental real-time path tracer runs on WebGPU with a WebGL2 fallback. The MCP server does not expose it. MCP render jobs take the cpu, gpu and native backends of Cook.
- In the MCP server, \`--backend gpu\` means hardware WebGL2 in Chrome, and \`--backend cpu\` means software rendering.
- \`scene_render_submit\` takes \`settings.quality\` (draft, realtime, realtime-high, final) and falls back one tier when a tier cannot run; the tiers are in [Render quality](${page('mcp.md')}#render-quality).
- Planned, not shipped: Glaze on WebGPU, the real-time path tracer behind \`realtime-high\`, and refine at rest. The roadmap is [issue 890](https://github.com/codepawl/crucible/issues/890).

## Connect

- npm package: \`@codepawlhq/crucible\`. The MCP server is its \`crucible-mcp\` binary. Node.js 20.19 or newer and an installed Chrome are required.
- Claude Code plugin, which adds the server and both skills: \`/plugin marketplace add codepawl/crucible\`, then \`/plugin install crucible@crucible\`.
- Any other MCP client: \`npm install crucible@npm:@codepawlhq/crucible\`, then run Node on \`node_modules/crucible/bin/crucible-mcp.mjs --backend gpu --memory 192\` over stdio. Use the absolute path.
- Setup, flags and client notes: [mcp.md](${page('mcp.md')}).
- Skills in the package: \`skills/build-crucible-scene\` (build and light) and \`skills/render-crucible-media\` (stills and video).

## Start

1. Call \`scene_capabilities\`. It reports the recipe fields, limits and budgets, and it is the source for field detail.
2. Create a scene, call \`scene_inspect\` for IDs and the revision, edit in small batches, and call \`scene_look\` after each batch.
3. Checkpoint before a risky change. Restore it if the picture is worse. Call \`scene_dispose\` when finished.

## To do X, call Y

${taskMap()}

## All tools

${toolLines}

Call \`scene_capabilities\` for field detail. This list is generated from the server's tool registry by \`scripts/generate-llms.mjs\`.

## If you know three.js

Models write three.js from memory. The section "If you know three.js" of the [complete guide](${page('guide.md')}) maps each common three.js idiom to the Crucible call. The optional addon \`@codepawlhq/crucible-three-compat\` (folder \`packages/three-compat\`) accepts the common three.js shapes (\`Scene\`, \`Mesh\`, \`MeshStandardMaterial\`, \`PerspectiveCamera\`, the light classes, \`GLTFLoader\`, \`setAnimationLoop\`) and builds Crucible parts from them. It throws an error that names the Crucible call when you use a name it does not support.

## Docs

- [Complete plain-text guide](${page('guide.md')}): renderer, parts, materials, cameras, animation, export and troubleshooting.
- [MCP server](${page('mcp.md')}), [scene recipes](${page('agent-scene.md')}), [look and lighting](${page('agent-look.md')}), [motion](${page('agent-motion.md')}), [review](${page('agent-review.md')}), [render jobs](${page('agent-render-jobs.md')}), [imported assets](${page('agent-asset.md')}).
- [GLB contract](${page('gltf.md')}): supported assets and conversion limits.
- [Release metadata](${page('release.json')}): package name, version, install command and commit.
- [Changelog data](${page('changelog.json')}): every release and the unreleased changes with issue numbers and breaking flags. Read it before relying on a feature the docs describe.
`;
}

export async function generateLlmsText() {
  return buildLlmsText(await listRegisteredTools());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = await generateLlmsText();
  if (process.argv.includes('--check')) {
    const current = await readFile(outputUrl, 'utf8').catch(() => '');
    if (current !== text) {
      console.error('public/llms.txt is stale. Run: npm run llms');
      process.exit(1);
    }
  } else {
    await writeFile(outputUrl, text);
    console.log(`public/llms.txt written (${text.length} characters)`);
  }
  process.exit(0);
}
