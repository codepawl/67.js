// Renders a preview MP4 of each soft body film (960 by 540, 60 fps, one video frame per simulation step), stills at contact
// and at the deepest dent, a side-by-side still of the two with the measured size drawn on it, and one JSON of the numbers. Usage: node scripts/render-soft-body-film.mjs <output directory> [--flag-only] [--fine]
// --fine renders the 64 by 64 flag with dihedral bending (4 s) and implies --flag-only.
// Run it through gpu-lock on a shared machine. It needs `npm run build:lib` first.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentScene } from '../src/agent-scene.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { FILM_FRAMES_PER_SECOND, FINE_FLAG_FILM_SECONDS, FLAG_FILM_SECONDS, axisRange, foldingFlagRecipe, jellyCubeRecipe, measureLanding, normalSpread, recordFilm, unjoinedMinimumDistance } from './soft-body-film.mjs';

const PREVIEW = { width: 960, height: 540, fps: FILM_FRAMES_PER_SECOND };
const FONT_FILE = 'C\\:/Windows/Fonts/arial.ttf';
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

const meters = value => Number(value.toFixed(4));

/** Height above the floor of the highest vertex and of the median and 90th percentile vertex: a thin layer with folds has a low median and a higher tail. */
function restHeights(vertices) {
  const heights = [];
  for (let index = 1; index < vertices.length; index += 3) heights.push(vertices[index]);
  heights.sort((low, high) => low - high);
  const at = share => meters(heights[Math.floor(share * (heights.length - 1))]);
  return { highest: meters(heights[heights.length - 1]), median: at(0.5), percentile90: at(0.9) };
}
const seconds = step => Number((step / FILM_FRAMES_PER_SECOND).toFixed(4));

/** Size of the cube in one frame: width along x (what the side camera sees) and height. */
function cubeSize(frame) {
  return { widthMeters: meters(axisRange(frame, 0).extent), heightMeters: meters(axisRange(frame, 1).extent) };
}

/** Joins the contact and max dent stills left and right, each captioned with its step, time and measured size. */
function writeComparisonStill(outputDirectory, files, captions) {
  const captionDirectory = mkdtempSync(join(tmpdir(), '67js-captions-'));
  const inputs = [];
  const filters = [];
  Object.keys(captions).forEach((label, index) => {
    inputs.push('-i', join(outputDirectory, files[label]));
    const captionFile = join(captionDirectory, `caption-${index}.txt`);
    writeFileSync(captionFile, captions[label]);
    const escapedCaption = captionFile.replaceAll('\\', '/').replace(':', '\\:');
    filters.push(`[${index}:v]drawbox=x=0:y=0:w=iw:h=124:color=black@0.65:t=fill,drawtext=fontfile='${FONT_FILE}':textfile='${escapedCaption}':fontcolor=white:fontsize=28:line_spacing=8:x=20:y=12[caption${index}]`);
  });
  const filterGraph = `${filters.join(';')};[caption0][caption1]hstack=inputs=2`;
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filterGraph, '-frames:v', '1', join(outputDirectory, 'jelly-cube-compare.png')]);
  } finally {
    rmSync(captionDirectory, { recursive: true, force: true });
  }
}

/** The jelly cube half of the summary: sizes at rest, contact and the deepest dent, plus the side by side still. */
function summarizeJelly(outputDirectory, jelly, jellyFiles, landing, jellyFrames) {
  const atContact = cubeSize(jelly.record.frames[landing.contact]);
  const atMaxDent = cubeSize(jelly.record.frames[landing.maxDentFrame]);
  writeComparisonStill(outputDirectory, jellyFiles.files, {
    contact: `contact: step ${landing.contact} (${seconds(landing.contact).toFixed(3)} s)
width ${atContact.widthMeters.toFixed(4)} m, height ${atContact.heightMeters.toFixed(4)} m`,
    'max-dent': `max dent: step ${landing.maxDentFrame} (${seconds(landing.maxDentFrame).toFixed(3)} s)
width ${atMaxDent.widthMeters.toFixed(4)} m, height ${atMaxDent.heightMeters.toFixed(4)} m
dent ${landing.maxDentDepth.toFixed(4)} m`,
  });
  jellyFiles.files.compare = 'jelly-cube-compare.png';
  return {
    simulationSteps: jellyFrames,
    restSize: { widthMeters: meters(axisRange(jelly.record.frames[0], 0).extent), heightMeters: meters(landing.restHeight) },
    contact: { step: landing.contact, timeSeconds: seconds(landing.contact), ...atContact },
    maxDent: { step: landing.maxDentFrame, timeSeconds: seconds(landing.maxDentFrame), depthMeters: meters(landing.maxDentDepth), ...atMaxDent },
    frameTimes: jelly.frameTimes,
    files: jellyFiles.files,
  };
}

async function main() {
  if (!existsSync(new URL('../build/mcp/server.mjs', import.meta.url))) throw new Error('Run npm run build:lib first: the MCP server is not built.');
  const fine = process.argv.includes('--fine');
  const flagOnly = fine || process.argv.includes('--flag-only');
  const flagRecipe = options => foldingFlagRecipe({ ...options, fine });
  const directoryArgument = process.argv.slice(2).find(argument => !argument.startsWith('--'));
  const outputDirectory = resolve(directoryArgument ?? '');
  if (!directoryArgument) throw new Error('Pass the output directory: node scripts/render-soft-body-film.mjs <directory>');
  await mkdir(outputDirectory, { recursive: true });

  const jellyFrames = 120;
  const flagFrames = (fine ? FINE_FLAG_FILM_SECONDS : FLAG_FILM_SECONDS) * FILM_FRAMES_PER_SECOND;
  const jelly = flagOnly ? null : filmNumbers(jellyCubeRecipe(), 'cube', jellyFrames);
  const landing = flagOnly ? null : measureLanding(jelly.record.frames, axisRange(jelly.record.frames[0], 1).extent);
  const flag = filmNumbers(flagRecipe(), 'flag', flagFrames);
  const flagTouch = measureLanding(flag.record.frames, axisRange(flag.record.frames[0], 1).extent).contact;
  const flagMidFall = Math.round(flagTouch * 0.7);
  const flagSettling = Math.round(flagTouch * 2);
  const flagHash = flag.record.hashes[flagFrames - 1];

  const jobsDirectory = join(tmpdir(), `67js-soft-body-film-${process.pid}`);
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry, '--jobs', jobsDirectory], stderr: 'ignore' });
  const client = new Client({ name: 'soft-body-film', version: '1.0.0' });
  await client.connect(transport);
  try {
    const call = (name, toolArguments) => client.callTool({ name, arguments: toolArguments }, { timeout: 300000 });
    const jellyFiles = flagOnly ? null : await renderFilm(call, outputDirectory, {
      name: 'jelly-cube', recipe: jellyCubeRecipe(), nodeId: 'cube', frameCount: jellyFrames, videoSeconds: jellyFrames / FILM_FRAMES_PER_SECOND,
      stillTimes: { contact: landing.contact / FILM_FRAMES_PER_SECOND, 'max-dent': landing.maxDentFrame / FILM_FRAMES_PER_SECOND },
    });
    const flagFiles = await renderFilm(call, outputDirectory, {
      name: fine ? 'folding-flag-fine' : 'folding-flag', recipe: flagRecipe(), nodeId: 'flag', frameCount: flagFrames, videoSeconds: flagFrames / FILM_FRAMES_PER_SECOND,
      stillTimes: { start: 0, 'mid-fall': flagMidFall / FILM_FRAMES_PER_SECOND, 'first-touch': flagTouch / FILM_FRAMES_PER_SECOND, settling: flagSettling / FILM_FRAMES_PER_SECOND, 'final-rest': (flagFrames - 1) / FILM_FRAMES_PER_SECOND },
    });
    const withoutSelfCollision = recordFilm(flagRecipe({ selfCollision: false }), 'flag', flagFrames);
    const flagIndices = createAgentScene(flagRecipe()).parts.find(part => part.name === 'flag').geometry.indices;
    const lastFlagStep = flagFrames - 1;
    const jellyCube = flagOnly ? undefined : summarizeJelly(outputDirectory, jelly, jellyFiles, landing, jellyFrames);
    const flagStart = flag.record.frames[0];
    const flagIndicesForSpread = flagIndices;
    const summary = {
      preview: { ...PREVIEW, videoFrameToStep: 'one video frame is one simulation step: frame N is step N, at N / 60 s' },
      jellyCube,
      foldingFlag: {
        simulationSteps: flagFrames,
        finalStep: lastFlagStep,
        finalTimeSeconds: seconds(lastFlagStep),
        restHeightMeters: meters(axisRange(flag.record.frames[0], 1).extent),
        midFallStep: flagMidFall,
        firstTouchStep: flagTouch,
        pileHeightMeters: meters(axisRange(flag.record.frames[lastFlagStep], 1).extent),
        restHeightsMeters: restHeights(flag.record.frames[lastFlagStep]),
        normalSpread: {
          start: meters(normalSpread(flagStart, flagIndicesForSpread)),
          midFall: meters(normalSpread(flag.record.frames[flagMidFall], flagIndicesForSpread)),
          settling: meters(normalSpread(flag.record.frames[flagSettling], flagIndicesForSpread)),
          rest: meters(normalSpread(flag.record.frames[lastFlagStep], flagIndicesForSpread)),
        },
        midFallDepthMeters: meters(axisRange(flag.record.frames[flagMidFall], 2).extent),
        settlingStep: flagSettling,
        closestUnjoinedGapMeters: {
          atStep: lastFlagStep,
          withSelfCollision: meters(unjoinedMinimumDistance(flag.record.frames[lastFlagStep], flagIndices)),
          withoutSelfCollision: meters(unjoinedMinimumDistance(withoutSelfCollision.frames[lastFlagStep], flagIndices)),
        },
        finalFrameSha256: flagHash,
        frameTimes: flag.frameTimes,
        files: flagFiles.files,
      },
    };
    await writeFile(join(outputDirectory, fine ? 'soft-body-film-fine.json' : 'soft-body-film.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
