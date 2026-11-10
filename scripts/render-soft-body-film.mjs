// Renders a low-resolution preview MP4 of each soft body film, stills at contact and at the deepest dent, and one JSON of
// the measured numbers. Usage: node scripts/render-soft-body-film.mjs <output directory>
// Run it through gpu-lock on a shared machine. It needs `npm run build:lib` first.
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { FILM_FRAMES_PER_SECOND, axisRange, foldingFlagRecipe, jellyCubeRecipe, measureLanding, recordFilm } from './soft-body-film.mjs';

const PREVIEW = { width: 480, height: 270, fps: 30 };
const serverEntry = new URL('../bin/67js-mcp.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

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
  return { jobId, artifact: result.artifacts[0].path, metrics: result.metrics };
}

async function renderFilm(call, outputDirectory, { name, recipe, nodeId, frameCount, stillTimes, videoSeconds }) {
  const createResult = await call('scene_create', { recipe });
  if (createResult.isError) throw new Error(createResult.content?.[0]?.text);
  const created = createResult.structuredContent;
  const files = {};
  for (const [label, time] of Object.entries(stillTimes)) {
    const { artifact } = await renderJob(call, created.sessionId, { kind: 'image', width: PREVIEW.width, height: PREVIEW.height, motion: { start: time } });
    files[label] = `${name}-${label}.png`;
    await copyFile(artifact, join(outputDirectory, files[label]));
  }
  const video = await renderJob(call, created.sessionId, { kind: 'video', ...PREVIEW, duration: videoSeconds, motion: { start: 0 } });
  files.video = `${name}.mp4`;
  await copyFile(video.artifact, join(outputDirectory, files.video));
  const disposed = await call('scene_dispose', { sessionId: created.sessionId });
  if (disposed.isError) throw new Error(disposed.content?.[0]?.text);
  return { files, frameCount, nodeId };
}

function filmNumbers(film, nodeId, frameCount) {
  const record = recordFilm(film, nodeId, frameCount);
  const milliseconds = value => Number(value.toFixed(2));
  return {
    record,
    frameTimes: {
      stepsPerSecond: FILM_FRAMES_PER_SECOND,
      bakeMilliseconds: milliseconds(record.bakeMilliseconds),
      millisecondsPerStep: milliseconds(record.bakeMilliseconds / frameCount),
      playbackSampleMilliseconds: { mean: milliseconds(record.sampleMilliseconds.reduce((a, b) => a + b, 0) / record.sampleMilliseconds.length), max: milliseconds(Math.max(...record.sampleMilliseconds)) },
    },
  };
}

async function main() {
  if (!existsSync(new URL('../build/mcp/server.mjs', import.meta.url))) throw new Error('Run npm run build:lib first: the MCP server is not built.');
  const outputDirectory = resolve(process.argv[2] ?? '');
  if (!process.argv[2]) throw new Error('Pass the output directory: node scripts/render-soft-body-film.mjs <directory>');
  await mkdir(outputDirectory, { recursive: true });

  const jellyFrames = 120;
  const flagFrames = 150;
  const jelly = filmNumbers(jellyCubeRecipe(), 'cube', jellyFrames);
  const landing = measureLanding(jelly.record.frames, axisRange(jelly.record.frames[0], 1).extent);
  const flag = filmNumbers(foldingFlagRecipe(), 'flag', flagFrames);
  const flagHash = flag.record.hashes[flagFrames - 1];

  const jobsDirectory = join(tmpdir(), `67js-soft-body-film-${process.pid}`);
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry, '--jobs', jobsDirectory], stderr: 'ignore' });
  const client = new Client({ name: 'soft-body-film', version: '1.0.0' });
  await client.connect(transport);
  try {
    const call = (name, toolArguments) => client.callTool({ name, arguments: toolArguments }, { timeout: 300000 });
    const jellyFiles = await renderFilm(call, outputDirectory, {
      name: 'jelly-cube', recipe: jellyCubeRecipe(), nodeId: 'cube', frameCount: jellyFrames, videoSeconds: jellyFrames / FILM_FRAMES_PER_SECOND,
      stillTimes: { contact: landing.contact / FILM_FRAMES_PER_SECOND, 'max-dent': landing.maxDentFrame / FILM_FRAMES_PER_SECOND },
    });
    const flagFiles = await renderFilm(call, outputDirectory, {
      name: 'folding-flag', recipe: foldingFlagRecipe(), nodeId: 'flag', frameCount: flagFrames, videoSeconds: flagFrames / FILM_FRAMES_PER_SECOND,
      stillTimes: { folded: (flagFrames - 1) / FILM_FRAMES_PER_SECOND },
    });
    const summary = {
      preview: PREVIEW,
      jellyCube: { steps: jellyFrames, contactFrame: landing.contact, contactSeconds: landing.contact / FILM_FRAMES_PER_SECOND, maxDentFrame: landing.maxDentFrame, maxDentDepthMeters: Number(landing.maxDentDepth.toFixed(4)), restHeightMeters: Number(landing.restHeight.toFixed(4)), frameTimes: jelly.frameTimes, files: jellyFiles.files },
      foldingFlag: { steps: flagFrames, finalFrameSha256: flagHash, frameTimes: flag.frameTimes, files: flagFiles.files },
    };
    await writeFile(join(outputDirectory, 'soft-body-film.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
