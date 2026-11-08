// Compiles the WGSL kernel on SwiftShader's Vulkan adapter (CPU only, no GPU queue) and prints every error with its line.
//   node bench/webgpu-tracer/validate.mjs
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/bench/webgpu-tracer/harness.html`);
  const messages = await page.evaluate(async () => {
    const { KERNEL_SOURCE } = await import('/bench/webgpu-tracer/kernel.js');
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const module = device.createShaderModule({ code: KERNEL_SOURCE });
    const info = await module.getCompilationInfo();
    return info.messages.map(message => `${message.type} ${message.lineNum}:${message.linePos} ${message.message}`);
  });
  console.log(messages.length === 0 ? 'WGSL ok' : messages.join('\n'));
} finally {
  await browser.close();
  await server.close();
}
