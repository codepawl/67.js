// Draws the air distortion clip (a flash and a shock ring at t=0, heat haze after) and a before/after still pair.
// node bench/post/air-distortion.mjs [--out=<folder>] [--size=WIDTHxHEIGHT] [--seconds=N] [--fps=N] [--still=SECONDS]
// Environment: CHROME_PATH (a Chrome executable), CHROME_ARGS (extra flags separated by spaces, such as
// "--use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist --no-sandbox" on a Linux GPU box).
// Writes frames/, before.png, after.png, before-after.png and, when ffmpeg is installed, air-distortion.mp4.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const argumentValue = (name, fallback) => process.argv.find(argument => argument.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const outputFolder = resolve(argumentValue('out', 'artifacts/air-distortion'));
const [width, height] = argumentValue('size', '640x360').split('x').map(Number);
const seconds = Number(argumentValue('seconds', 4));
const framesPerSecond = Number(argumentValue('fps', 24));
const stillTime = Number(argumentValue('still', 0.55));
const chromeArguments = (process.env.CHROME_ARGS ?? '--enable-webgl --ignore-gpu-blocklist --use-angle=d3d11 --enable-gpu').split(' ').filter(Boolean);

const server = await createServer({ root: resolve('.'), server: { host: '127.0.0.1', port: 0, fs: { strict: false } }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true, args: chromeArguments });
try {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/bench/post/air-distortion.html`, { timeout: 60000 });
  await page.waitForFunction(() => window.drawAt, null, { timeout: 60000 });
  await mkdir(resolve(outputFolder, 'frames'), { recursive: true });
  const draw = async (time, withAir) => {
    const result = await page.evaluate(([at, on]) => window.drawAt(at, on), [time, withAir]);
    if (result.glError !== 0) throw new Error(`GL error ${result.glError} at ${time}s`);
    return Buffer.from(result.image, 'base64');
  };
  const frameCount = Math.round(seconds * framesPerSecond);
  for (let index = 0; index < frameCount; index++) {
    await writeFile(resolve(outputFolder, 'frames', `${String(index).padStart(4, '0')}.png`), await draw(index / framesPerSecond, true));
  }
  await writeFile(resolve(outputFolder, 'before.png'), await draw(stillTime, false));
  await writeFile(resolve(outputFolder, 'after.png'), await draw(stillTime, true));
  const encoded = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(framesPerSecond), '-i', resolve(outputFolder, 'frames', '%04d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', resolve(outputFolder, 'air-distortion.mp4')], { encoding: 'utf8' });
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', resolve(outputFolder, 'before.png'), '-i', resolve(outputFolder, 'after.png'),
    '-filter_complex', 'hstack=inputs=2', resolve(outputFolder, 'before-after.png')], { encoding: 'utf8' });
  console.log(JSON.stringify({ size: [width, height], frames: frameCount, stillTime, ffmpegStatus: encoded.status, ffmpegError: encoded.error?.message ?? null }));
} finally {
  await browser.close();
  await server.close();
}
