// Starts the Vite dev server and headless Chrome for the tests that need a real WebGL context.
import { spawn } from 'node:child_process';
import { freePort } from './free-port.js';

const CHROME_ARGUMENTS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'];

async function startServer(port) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The dev server did not start.')), 30000);
    server.stdout.on('data', (data) => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`The dev server exited ${code}.`));
    });
  });
  return server;
}

// Playwright's own browser download is not installed on CI, so fall back to the Google Chrome the runner already has.
async function launchChrome(chromium) {
  try {
    return await chromium.launch({ headless: true, args: CHROME_ARGUMENTS });
  } catch {
    return chromium.launch({ headless: true, channel: 'chrome', args: CHROME_ARGUMENTS });
  }
}

/**
 * Runs `body(page)` on the dev server's page in headless Chrome and cleans up.
 * Where Chrome or playwright is missing the test skips on a developer machine and fails on CI, where Chrome is required.
 */
export async function withDevServerPage(testContext, body) {
  const skipOrThrow = (message) => {
    if (process.env.CI) throw new Error(message);
    testContext.skip(message);
  };
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    skipOrThrow('playwright is not installed');
    return;
  }
  const port = await freePort();
  const server = await startServer(port);
  let browser;
  try {
    try {
      browser = await launchChrome(chromium);
    } catch (error) {
      skipOrThrow(`Chrome did not start: ${error.message.split('\n')[0]}`);
      return;
    }
    const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    await body(page);
  } finally {
    await browser?.close();
    server.kill();
  }
}
