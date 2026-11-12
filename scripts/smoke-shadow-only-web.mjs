// Proves shadow-only parts on the browser path tracers with real pixels: the WebGL2 tracer, the WebGPU megakernel and wavefront
// kernels and the real-time WebGPU tracer each draw a floor three ways (no caster, a visible caster, a shadowOnly caster).
// The shadow-only frame must not show the caster and the floor under it must be darker than the bare floor; every shader must
// compile with no console error. Needs Chrome with a GPU (CHROME_PATH) and writes artifacts/973-web/ (pictures and result.json).
// WebGPU may be missing on a runner; that backend is then reported as "unavailable" and the others still decide the exit code.
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(process.argv[2] ?? join(root, 'artifacts', '973-web'));
const MIME = { '.js': 'application/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
const SIZE = 48;

const server = createServer(async (request, response) => {
  const relative = normalize(decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
  const file = join(root, relative === '/' || relative === '\\' ? 'scripts/smoke-shadow-only-web.html' : relative);
  if (!file.startsWith(root) || !(await stat(file).then(info => info.isFile(), () => false))) {
    response.statusCode = 404;
    response.end('not found');
    return;
  }
  response.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(response);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://localhost:${server.address().port}`;

await mkdir(outputDirectory, { recursive: true });
const GPU_FLAGS = ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU,UnsafeWebGPU', '--disable-vulkan-surface', '--enable-webgl'];
// WebGL2 is tried on each ANGLE backend in turn until the tracer's float render targets exist; the first that draws decides.
const LAUNCHES = [
  { label: 'angle-vulkan', args: ['--use-angle=vulkan'], backends: ['gpu', 'webgpu-megakernel', 'webgpu-wavefront', 'webgpu-realtime'] },
  { label: 'angle-gl', args: ['--use-angle=gl'], backends: ['gpu'], onlyIfMissing: 'gpu' },
  { label: 'angle-swiftshader', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], backends: ['gpu'], onlyIfMissing: 'gpu' },
];

async function runLaunch(launch) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH, args: [...GPU_FLAGS, ...launch.args] });
  const page = await browser.newPage();
  const consoleProblems = [];
  page.on('console', message => {
    const text = message.text();
    // ReadPixels stall notes are driver performance hints, not shader errors.
    if (['error', 'warning'].includes(message.type()) && !/GPU stall due to ReadPixels|CONTEXT_LOST_WEBGL: loseContext/.test(text)) consoleProblems.push(message.type() + ': ' + text);
  });
  page.on('pageerror', error => consoleProblems.push('pageerror: ' + error.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.shadowOnlyProof !== undefined, null, { timeout: 15000 }).catch(error => {
    console.error(consoleProblems.join('\n'));
    throw error;
  });
  const environment = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return { webgpu: Boolean(navigator.gpu), webglRenderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null, userAgent: navigator.userAgent };
  });
  const launchResults = [];
  for (const backend of launch.backends) {
    const problemsBefore = consoleProblems.length;
    const result = await page.evaluate(([name, size]) => window.shadowOnlyProof(name, size), [backend, SIZE]).catch(error => ({ backend, error: error.message }));
    result.launch = launch.label;
    result.consoleProblems = consoleProblems.slice(problemsBefore);
    launchResults.push(result);
    if (result.montage) {
      await writeFile(join(outputDirectory, backend + '.png'), Buffer.from(result.montage.split(',')[1], 'base64'));
      delete result.montage;
    }
  }
  await browser.close();
  return { environment, launchResults };
}

const results = [];
const environments = {};
for (const launch of LAUNCHES) {
  if (launch.onlyIfMissing && results.some(result => result.backend === launch.onlyIfMissing && result.status === 'pass')) continue;
  const { environment, launchResults } = await runLaunch(launch);
  environments[launch.label] = environment;
  results.push(...launchResults);
}
server.close();

await writeFile(join(outputDirectory, 'result.json'), JSON.stringify({ environments, results }, null, 2));
console.log(JSON.stringify({ environments, results }, null, 2));
// A backend that failed on one ANGLE backend but passed on a later one is reported, not counted as a failure of the proof.
const passed = new Set(results.filter(result => result.status === 'pass').map(result => result.backend));
const failed = results.filter(result => !passed.has(result.backend) && !result.unavailable)
  .concat(results.filter(result => result.status === 'pass' && result.consoleProblems.length > 0));
if (failed.length > 0 || passed.size === 0) {
  console.error('shadow-only web proof failed: ' + (failed.map(result => result.backend).join(', ') || 'nothing ran'));
  process.exit(1);
}
console.log('shadow-only web proof passed on ' + [...passed].join(', '));
