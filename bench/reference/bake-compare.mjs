// Bakes one reference scene on the CPU and on the GPU backend of the light bake and prints seconds and agreement.
//   node bench/reference/bake-compare.mjs <scene id> '<variants json>'
// The variants are named bake options; the first is the reference the others are compared with, for example
//   '{"cpu":{"backend":"cpu","samples":128},"gpu":{"backend":"gpu","samples":512}}'
// The backend is cpu, gpu, webgpu or native (the hardware ray query tracer Cook, @codepawlhq/cook, when its addon is built).
// Run it through a heavy GPU lock job (GPU_LOCK_WEIGHT=heavy) when the card is shared: the GPU bake takes the whole GPU for seconds.
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createNativeTracerLocator, traceTexelsNative } from '../../scripts/agent-native-trace.mjs';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [sceneId, variantsJson] = process.argv.slice(2);
const variants = JSON.parse(variantsJson);

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-webgl', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'] });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', error => console.log('PAGE ERROR', error.message));
  page.on('console', message => message.type() === 'error' && console.log('PAGE CONSOLE', message.text()));
  page.setDefaultTimeout(0);
  // The native backend traces in this process, the way the agent runtime serves a recipe bake.
  const nativeLocator = createNativeTracerLocator();
  await page.exposeFunction('__crucibleNativeBake', async request => {
    const found = await nativeLocator.find();
    if (request.action === 'probe') return { available: Boolean(found.tracer) };
    if (!found.tracer) return { error: found.reason };
    try {
      return traceTexelsNative({ tracer: found.tracer, request });
    } catch (error) {
      return { error: error.message };
    }
  });
  await page.goto(`${serverUrl}/bench/reference/harness.html`, { timeout: 180000 });
  await page.waitForFunction(() => window.compareBakeBackends, null, { timeout: 180000 });
  const results = await page.evaluate(([id, named]) => window.compareBakeBackends(id, named), [sceneId, variants]);
  console.log(JSON.stringify(results, null, 1));
} finally {
  await browser.close();
  await server.close();
}
