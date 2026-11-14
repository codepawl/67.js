import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setPriority, constants } from 'node:os';
import { existsSync } from 'node:fs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5191', '--strictPort'], { windowsHide:true, stdio:'pipe' });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Transport test server did not start.')), 15000);
    server.stdout.on('data', bytes => {
      if (bytes.toString().includes('127.0.0.1:5191')) { clearTimeout(timeout); resolve(); }
    });
    server.on('error', reject);
  });
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser = await chromium.launch({ headless:true, ...(existsSync(chrome) ? { executablePath:chrome } : {}) });
  const page = await browser.newPage();
  // Isolate transport races from GPU cost and intentionally delay media seeks.
  await page.route('**/src/renderer.js', route => route.fulfill({ contentType:'text/javascript', body:'export class CrucibleRenderer { render(){} dispose(){} resize(){} }' }));
  await page.route('**/src/film.js', route => route.fulfill({ contentType:'text/javascript', body:`export const FILM_DURATION=187; export function createFilmScenes(){return {test:{parts:[]}};} export function sampleFilm(time){return {scene:'test',camera:{},time,sceneTime:time,title:'',subtitle:'',titleOpacity:0,flash:0};}` }));
  await page.addInitScript(() => {
    window.Audio = class {
      constructor() { this.paused = true; this.readyState = 2; this.position = 0; this.seeking = false; this.deferSeek = false; }
      get currentTime() { return this.position; }
      set currentTime(value) { if (this.deferSeek) this.seeking = true; else this.position = value; }
      play() { this.paused = false; return Promise.resolve(); }
      pause() { this.paused = true; }
    };
  });
  await page.goto('http://127.0.0.1:5191/film.html');
  await page.waitForFunction(() => window.__filmReady);
  await page.getByRole('button', { name:'Play film', exact:true }).click();
  await page.evaluate(() => {
    const slider = document.querySelector('#film-time');
    slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, pointerId:1 }));
    slider.value = '137';
  });
  await page.waitForTimeout(80);
  assert.equal(await page.locator('#film-time').inputValue(), '137', 'Playback overwrote the held timeline');
  assert.equal(await page.evaluate(() => window.__film.score.paused), true);
  await page.evaluate(() => {
    const slider = document.querySelector('#film-time');
    for (const destination of [90, 140]) { slider.value = destination; slider.dispatchEvent(new Event('input', { bubbles:true })); }
  });
  await page.waitForFunction(() => window.__film.currentTime === 140);
  assert.equal(await page.locator('#film-time').inputValue(), '140');
  await page.evaluate(() => {
    window.__film.score.deferSeek = true;
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId:1 }));
  });
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.__film.currentTime), 140, 'Stale audio seek moved the film backwards');
  assert.equal(await page.evaluate(() => window.__film.playing), true);
  await page.evaluate(() => { window.__film.score.position = 140.1; window.__film.score.seeking = false; });
  await page.waitForFunction(() => window.__film.currentTime >= 140.1);
  await page.getByRole('button', { name:'Pause film', exact:true }).click();
  await page.locator('#film-time').fill('32');
  await page.waitForFunction(() => window.__film.currentTime === 32);
  assert.equal(await page.evaluate(() => window.__film.playing), false);
  await page.locator('#film-time').focus();
  await page.keyboard.press('ArrowRight');
  assert.ok(await page.evaluate(() => window.__film.currentTime) > 32);
  assert.equal(await page.evaluate(() => window.__film.scrubbing), false);
  console.log('Transport passed: held pointer, coalesced seeks, delayed audio, resume, paused seeks and keyboard.');
} finally {
  await browser?.close();
  server.kill();
}
