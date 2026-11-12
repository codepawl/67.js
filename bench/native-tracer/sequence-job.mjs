// Runs real multi-frame native stills jobs through the MCP server, once with sessions and once with JS67_NATIVE_SESSIONS=off, and checks
// that every frame of the two runs has the same bytes and that the frames after the first took the route the sequence calls for.
//   node bench/native-tracer/sequence-job.mjs <output directory> [--browser <chrome path>] [--runtime-backend gpu|cpu] [--samples 8] [--width 480] [--height 270]
// Variants (the demo room with its motion edited and, except "particles", its particle systems removed, since sparks and swaying hair rebuild the
// triangles and the emissive list at every time and a session is only reused when the exported tables are equal): camera (camera tracks only,
// every later frame `reused`), material (plus a roughness track: `updated`), light (plus a point light intensity track: `updated`), transform
// (the recipe's own tracks, where a pendant swings: the job exports shared geometry as instances, so the swing is an instance transform: `updated`, or `reused` when it has returned to an earlier pose) and particles (camera tracks
// with the sparks left in: a new session per frame, as costly as a one-shot trace).
// A run with sessions off carries no `nativeSession` in its reports, so its route list is empty by design.
// Prints one SEQUENCE_JOB line of JSON and exits 1 when a frame differs or a route is not the expected one.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const argumentList = process.argv.slice(2);
const outputDirectory = resolve(argumentList[0]);
const flag = (name, fallback) => (argumentList.includes(name) ? argumentList[argumentList.indexOf(name) + 1] : fallback);
const width = Number(flag('--width', 480));
const height = Number(flag('--height', 270));
const samples = Number(flag('--samples', 8));
const browserPath = flag('--browser', '');
// "cpu" runs the page on SwiftShader, which is how a box whose headless Chrome cannot get a hardware renderer still traces on the native GPU tracer.
const runtimeBackend = flag('--runtime-backend', 'gpu');
const STILLS_PER_JOB = 8;
const MOTION_SECONDS = 6;
const RECIPE_MOTION_SECONDS = 12;

function keyframes(first, last) {
  return [{ time: 0, value: first }, { time: RECIPE_MOTION_SECONDS, value: last }];
}

function buildVariants(recipe) {
  const cameraTracks = recipe.motion.tracks.filter(track => track.kind === 'camera');
  const materialId = recipe.nodes.find(node => node.id === 'left-wall').material;
  const withoutParticles = Object.fromEntries(Object.entries(recipe).filter(([key]) => key !== 'particles'));
  const withMotion = tracks => ({ ...withoutParticles, motion: { ...recipe.motion, tracks } });
  return {
    camera: { recipe: withMotion(cameraTracks), expectedLaterRoute: 'reused' },
    material: { recipe: withMotion([...cameraTracks, { kind: 'material', id: materialId, property: 'roughness', interpolation: 'LINEAR', keyframes: keyframes(0.9, 0.2) }]), expectedLaterRoute: 'updated' },
    light: { recipe: withMotion([...cameraTracks, { kind: 'light', id: 'point:0', property: 'intensity', interpolation: 'LINEAR', keyframes: keyframes(14, 4) }]), expectedLaterRoute: 'updated' },
    transform: { recipe: withMotion(recipe.motion.tracks), expectedLaterRoute: 'updated', allowedRoutes: ['updated', 'reused'] },
    particles: { recipe: { ...recipe, motion: { ...recipe.motion, tracks: cameraTracks } }, expectedLaterRoute: 'new-session' },
  };
}

async function runJob(variantRecipe, sessions) {
  const workDirectory = await mkdtemp(join(tmpdir(), '67js-sequence-job-'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('bin/67js-mcp.mjs'), '--backend', runtimeBackend, '--memory', '384', '--jobs', join(workDirectory, 'jobs'), ...(browserPath ? ['--browser', browserPath] : [])],
    cwd: workDirectory, stderr: 'pipe', env: { ...process.env, JS67_NATIVE_SESSIONS: sessions ? 'on' : 'off' } });
  let diagnostics = '';
  transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-4096); });
  const client = new Client({ name: '67js-sequence-job', version: '1' });
  const call = (name, toolArguments) => client.callTool({ name, arguments: toolArguments }, { timeout: 600000 });
  try {
    await client.connect(transport);
    const createResult = await call('scene_create', { recipe: variantRecipe });
    const created = createResult.structuredContent;
    if (!created) throw new Error(`scene_create failed: ${createResult.content?.[0]?.text}`);
    const settings = { kind: 'stills', duration: MOTION_SECONDS, motion: { start: 0 }, width, height,
      renderer: { type: 'pathTracer', backend: 'native', samples, bounces: 6, denoise: false, maxSeconds: 120, seed: 3 } };
    const submitted = await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: 0, settings });
    if (submitted.isError) throw new Error(submitted.content?.[0]?.text);
    const { jobId } = submitted.structuredContent;
    let record;
    for (;;) {
      record = (await call('scene_render_status', { jobId })).structuredContent;
      if (['completed', 'cancelled', 'failed'].includes(record.state)) break;
      await delay(100);
    }
    if (record.state !== 'completed') throw new Error(`job ${record.state}: ${JSON.stringify(record.reason ?? record.error)}`);
    const result = (await call('scene_render_result', { jobId })).structuredContent;
    const frameHashes = [];
    for (const artifact of result.artifacts) frameHashes.push(createHash('sha256').update(await readFile(artifact.path)).digest('hex'));
    const metrics = result.metrics;
    await call('scene_render_release', { jobId });
    return { frameHashes, routes: metrics.nativeSessionRoutes ?? [], backend: metrics.pathTracer?.backend, backendNote: metrics.pathTracer?.backendNote, lastSession: metrics.pathTracer?.nativeSession };
  } catch (error) {
    console.error(diagnostics);
    throw error;
  } finally {
    await client.close();
  }
}

await mkdir(outputDirectory, { recursive: true });
const variants = buildVariants(JSON.parse(await readFile('tests/fixtures/demo-room.recipe.json', 'utf8')));
const report = { width, height, samples, frames: STILLS_PER_JOB, variants: {} };
let failed = false;
for (const [name, { recipe, expectedLaterRoute, allowedRoutes = [expectedLaterRoute] }] of Object.entries(variants)) {
  let withSessions;
  let withoutSessions;
  try {
    withSessions = await runJob(recipe, true);
    withoutSessions = await runJob(recipe, false);
  } catch (error) {
    report.variants[name] = { error: error.message };
    failed = true;
    continue;
  }
  const identical = withSessions.frameHashes.length === STILLS_PER_JOB && withSessions.frameHashes.every((hash, index) => hash === withoutSessions.frameHashes[index]);
  const laterRoutes = withSessions.routes.slice(1);
  const routesAsExpected = withSessions.routes[0] === 'new-session' && withSessions.routes.length === STILLS_PER_JOB && laterRoutes.every(route => allowedRoutes.includes(route)) && laterRoutes.includes(expectedLaterRoute);
  const sessionsOffRoutes = withoutSessions.routes;
  report.variants[name] = { identical, frameHashes: withSessions.frameHashes, routes: withSessions.routes, routesAsExpected, sessionsOffRoutes, backend: withSessions.backend, backendNote: withSessions.backendNote, lastFrameSession: withSessions.lastSession };
  if (!identical || !routesAsExpected || sessionsOffRoutes.length > 0) failed = true;
}
await writeFile(join(outputDirectory, 'sequence-job.json'), JSON.stringify(report, null, 1));
console.log(`SEQUENCE_JOB ${JSON.stringify(report)}`);
process.exit(failed ? 1 : 0);
