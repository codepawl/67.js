// Renders the jelly bounce preview of docs/physics.md: three cubes side by side (firm and low bounce, medium, soft and high
// bounce) dropped from 1.95 m, as a 960 by 540, 60 fps MP4 through the MCP render job tools, with a still of each cube at
// contact, at its deepest dent and at the top of its first rebound, and one JSON of the measured numbers.
// Usage: node scripts/render-jelly-bounce.mjs <output directory>. Run it through gpu-lock on a shared machine; it needs `npm run build:lib` first.
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import '../tests/support/load-agent-scene-modules.mjs';
import { createAgentScene } from '../src/agent-scene.js';
import { invertedTriangles, JELLY_FRAMES_PER_SECOND, JELLY_PRESETS, jellyCubeRecipe, measureBounce, topFaceTilt } from '../tests/support/jelly-cube.mjs';

const PREVIEW = { width: 960, height: 540, fps: JELLY_FRAMES_PER_SECOND };
const FRAME_COUNT = 240;
const serverEntry = new URL('../bin/67js-mcp.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

// The presets are shared with the test (tests/support/jelly-cube.mjs). Colours are named so the labels and the docs agree:
// blue is firm, orange is medium, pink is soft.
const POSITIONS = { firm: { x: -0.85, color: [0.08, 0.3, 0.85] }, medium: { x: 0, color: [0.85, 0.15, 0.0] }, soft: { x: 0.85, color: [0.85, 0.12, 0.45] } };
const CUBES = JELLY_PRESETS.map(preset => ({ ...preset, ...POSITIONS[preset.id] }));

function threeCubeRecipe() {
  const single = jellyCubeRecipe({ duration: FRAME_COUNT / JELLY_FRAMES_PER_SECOND });
  const cubeNodes = CUBES.map(cube => ({ id: cube.id, geometry: 'jelly', material: `${cube.id}-gel`, translation: [cube.x, 2.2, 0], scale: [0.5, 0.5, 0.5] }));
  return {
    ...single,
    materials: [...CUBES.map(cube => ({ id: `${cube.id}-gel`, color: cube.color })), single.materials[1]],
    nodes: [...cubeNodes, ...single.nodes.slice(1)],
    camera: { fov: 11, eye: [0, 0.7, 8.4], target: [0, 0.42, 0] },
    cloth: {
      ...single.cloth,
      sheets: CUBES.map(cube => ({ node: cube.id, softBody: { pressure: 1, ...cube.softBody }, stiffness: 0.9, bend: 0, damping: 2, ...cube.sheet })),
    },
  };
}

function cubeFrames(recipe) {
  const scene = createAgentScene(recipe);
  const framesByCube = new Map(CUBES.map(cube => [cube.id, []]));
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    scene.sampleMotion(frame / JELLY_FRAMES_PER_SECOND);
    for (const cube of CUBES) {
      const node = recipe.nodes.find(candidate => candidate.id === cube.id);
      const local = scene.parts.find(part => part.name === cube.id).geometry.positions;
      const world = new Float32Array(local.length);
      for (let index = 0; index < local.length; index++) world[index] = local[index] * node.scale[index % 3] + node.translation[index % 3];
      framesByCube.get(cube.id).push(world);
    }
  }
  return framesByCube;
}

function horizontalExtent(frame) {
  let low = Infinity;
  let high = -Infinity;
  for (let index = 0; index < frame.length; index += 3) {
    low = Math.min(low, frame[index]);
    high = Math.max(high, frame[index]);
  }
  return high - low;
}

// What the stills should show besides dent and rebound: sideways bulge at the deepest dent, the step the body stops moving,
// the top face tilt at the deepest dent and at the last frame, and the inverted triangles of the single-cube bake.
function restAndShape(id, frames, bounce) {
  const preset = CUBES.find(cube => cube.id === id);
  let settledStep = 0;
  for (let step = 1; step < frames.length; step++) {
    let move = 0;
    for (let index = 0; index < frames[step].length; index++) move = Math.max(move, Math.abs(frames[step][index] - frames[step - 1][index]));
    if (move > 0.0015) settledStep = step;
  }
  const single = jellyCubeRecipe({ softBody: { pressure: 1, ...preset.softBody }, sheet: preset.sheet, duration: FRAME_COUNT / JELLY_FRAMES_PER_SECOND });
  return {
    bulgeMeters: Number((horizontalExtent(frames[bounce.deepestFrame]) - horizontalExtent(frames[0])).toFixed(4)),
    tiltAtDeepestDentDegrees: Number(topFaceTilt(frames[bounce.deepestFrame]).toFixed(2)),
    tiltAtLastFrameDegrees: Number(topFaceTilt(frames.at(-1)).toFixed(2)),
    lastMovingStep: settledStep,
    invertedTriangles: invertedTriangles(single, FRAME_COUNT),
  };
}

async function renderJob(call, sessionId, settings) {
  const submitted = await call('scene_render_submit', { sessionId, expectedRevision: 0, settings });
  if (submitted.isError) throw new Error(submitted.content?.[0]?.text);
  const { jobId } = submitted.structuredContent;
  for (;;) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (record.state === 'completed') break;
    if (['cancelled', 'failed'].includes(record.state)) throw new Error(`Render job ${record.state}: ${record.error}`);
    await delay(250);
  }
  const result = (await call('scene_render_result', { jobId })).structuredContent;
  return result.artifacts[0].path;
}

async function main() {
  if (!process.argv[2]) throw new Error('Pass the output directory: node scripts/render-jelly-bounce.mjs <directory>');
  if (!existsSync(new URL('../build/mcp/server.mjs', import.meta.url))) throw new Error('Run npm run build:lib first: the MCP server is not built.');
  const outputDirectory = resolve(process.argv[2]);
  await mkdir(outputDirectory, { recursive: true });
  const recipe = threeCubeRecipe();
  const measured = {};
  const stillTimes = {};
  for (const [id, frames] of cubeFrames(recipe)) {
    const bounce = measureBounce(frames);
    measured[id] = { colorName: CUBES.find(cube => cube.id === id).colorName, ...CUBES.find(cube => cube.id === id).softBody, ...CUBES.find(cube => cube.id === id).sheet, contactStep: bounce.contact, deepestDentStep: bounce.deepestFrame, reboundTopStep: bounce.topFrame, dentMeters: Number(bounce.dent.toFixed(4)), reboundMeters: Number(bounce.reboundHeight.toFixed(4)) };
    Object.assign(measured[id], restAndShape(id, frames, bounce));
    stillTimes[`${id}-contact`] = bounce.contact / JELLY_FRAMES_PER_SECOND;
    stillTimes[`${id}-deepest-dent`] = bounce.deepestFrame / JELLY_FRAMES_PER_SECOND;
    stillTimes[`${id}-rebound-top`] = bounce.topFrame / JELLY_FRAMES_PER_SECOND;
  }
  const jobsDirectory = join(tmpdir(), `67js-jelly-bounce-${process.pid}`);
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry, '--jobs', jobsDirectory], stderr: 'ignore' });
  const client = new Client({ name: 'jelly-bounce', version: '1.0.0' });
  await client.connect(transport);
  try {
    const call = (name, toolArguments) => client.callTool({ name, arguments: toolArguments }, { timeout: 300000 });
    const created = await call('scene_create', { recipe });
    if (created.isError) throw new Error(created.content?.[0]?.text);
    const { sessionId } = created.structuredContent;
    const files = {};
    for (const [label, time] of Object.entries(stillTimes)) {
      const artifact = await renderJob(call, sessionId, { kind: 'image', width: PREVIEW.width, height: PREVIEW.height, motion: { start: time } });
      files[label] = `${label}.png`;
      await copyFile(artifact, join(outputDirectory, files[label]));
    }
    const video = await renderJob(call, sessionId, { kind: 'video', ...PREVIEW, duration: FRAME_COUNT / JELLY_FRAMES_PER_SECOND, motion: { start: 0 } });
    await copyFile(video, join(outputDirectory, 'jelly-bounce.mp4'));
    await call('scene_dispose', { sessionId });
    const summary = { preview: PREVIEW, drop: 'cube base 1.95 m above the floor', cubes: measured, stills: stillTimes, files: { video: 'jelly-bounce.mp4', ...files } };
    await writeFile(join(outputDirectory, 'jelly-bounce.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(measured, null, 2));
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
