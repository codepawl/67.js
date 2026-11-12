import test from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { ANNOTATE_LIMITS, validateMarks, isBoundedPng, pixelRay, describeMarks } from '../src/agent-annotate.js';
import { runAnnotateSession } from '../scripts/annotate-session.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const view = { width: 400, height: 200 };
const camera = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 60, near: 0.1, far: 100 };

test('validateMarks keeps pixel positions and trims notes', () => {
  const marks = validateMarks([{ x: 10.04, y: 20, note: '  warmer  ' }, { x: 400, y: 0 }], view);
  assert.deepEqual(marks, [{ x: 10, y: 20, note: 'warmer' }, { x: 400, y: 0, note: '' }]);
});

test('validateMarks rejects too many marks, off-view pixels, long notes and non-arrays', () => {
  const mark = { x: 1, y: 1, note: 'a' };
  assert.throws(() => validateMarks(Array(ANNOTATE_LIMITS.maxMarks + 1).fill(mark), view), /at most 16 marks/);
  assert.throws(() => validateMarks([{ x: 401, y: 0 }], view), /mark 1 x/);
  assert.throws(() => validateMarks([{ x: 0, y: -1 }], view), /mark 1 y/);
  assert.throws(() => validateMarks([{ x: 0, y: 0, note: 'x'.repeat(281) }], view), /280 characters/);
  assert.throws(() => validateMarks({}, view), /array/);
  assert.throws(() => validateMarks([null], view), /object/);
});

test('isBoundedPng accepts a PNG and refuses other bytes or an oversize picture', () => {
  assert.equal(isBoundedPng(PNG), true);
  assert.equal(isBoundedPng(Buffer.from('not a picture').toString('base64')), false);
  assert.equal(isBoundedPng('***'), false);
  const oversize = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(ANNOTATE_LIMITS.maxImageBytes)]).toString('base64');
  assert.equal(isBoundedPng(oversize), false);
});

test('pixelRay sends the centre pixel straight along the view and the corner pixels outward', () => {
  const centre = pixelRay(camera, 200, 100, view.width, view.height);
  assert.ok(Math.abs(centre.direction[0]) < 1e-6 && Math.abs(centre.direction[1]) < 1e-6);
  assert.ok(centre.direction[2] < -0.999);
  const right = pixelRay(camera, 400, 100, view.width, view.height);
  const top = pixelRay(camera, 200, 0, view.width, view.height);
  assert.ok(right.direction[0] > 0.3);
  assert.ok(top.direction[1] > 0.3);
  // A 60 degree vertical field: the top edge ray leaves at 30 degrees from the axis.
  assert.ok(Math.abs(Math.atan(top.direction[1] / -top.direction[2]) - Math.PI / 6) < 1e-4);
});

test('describeMarks numbers marks and fills hit data, or nulls on sky', () => {
  const rays = [];
  const raycast = ray => {
    rays.push(ray);
    return rays.length === 1 ? { id: 'lamp', point: [0.12345, 1, 2], normal: [0, 1, 0], distance: 9.87654, material: 'brass' } : null;
  };
  const marks = describeMarks([{ x: 200, y: 100, note: 'dull' }, { x: 5, y: 5, note: '' }], camera, { ...view, raycast });
  assert.deepEqual(marks[0], { number: 1, pixel: [200, 100], note: 'dull', partId: 'lamp', point: [0.123, 1, 2], normal: [0, 1, 0], distance: 9.877, material: 'brass' });
  assert.deepEqual(marks[1], { number: 2, pixel: [5, 5], note: '', partId: null, point: null, normal: null, distance: null, material: null });
});

async function startSession(options, whenOpen) {
  const opened = Promise.withResolvers();
  const session = runAnnotateSession({ png: PNG, width: view.width, height: view.height, waitMs: 5000, ...options,
    open: async url => { opened.resolve(url); await whenOpen?.(url); } });
  return { url: await opened.promise, session };
}

function statusWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const call = request(url, { headers: { Host: host } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    call.on('error', reject);
    call.end();
  });
}

function post(url, route, body) {
  return fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('the annotate page serves the picture and returns validated marks on Send', async () => {
  const { url, session } = await startSession({ prompt: 'Pin <b>it</b>' });
  const page = await (await fetch(url)).text();
  assert.match(page, /Pin &lt;b&gt;it&lt;\/b&gt;/);
  assert.equal((await fetch(`${url}frame.png`)).headers.get('content-type'), 'image/png');
  assert.match(await (await fetch(`${url}app.js`)).text(), /limits/);
  const sent = await post(url, 'send', { marks: [{ x: 10, y: 20, note: 'more red' }], image: PNG });
  assert.equal(sent.status, 200);
  const result = await session;
  assert.equal(result.outcome, 'sent');
  assert.deepEqual(result.marks, [{ x: 10, y: 20, note: 'more red' }]);
  assert.equal(result.image, PNG);
});

test('the annotate page refuses bad marks, an empty list, a bad picture and a wrong path', async () => {
  const { url, session } = await startSession({ maxMarks: 2 });
  assert.equal((await post(url, 'send', { marks: [], image: PNG })).status, 400);
  assert.equal((await post(url, 'send', { marks: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], image: PNG })).status, 400);
  assert.equal((await post(url, 'send', { marks: [{ x: 1, y: 1 }], image: 'AAAA' })).status, 400);
  assert.equal((await fetch(url.replace(/[a-f0-9]+\/$/, 'wrong/'))).status, 404);
  assert.equal(await statusWithHost(url, 'example.test'), 404);
  await post(url, 'cancel', {});
  assert.equal((await session).outcome, 'cancelled');
});

test('the annotate session returns timeout when nobody presses Send', async () => {
  const { session } = await startSession({ waitMs: 50 });
  const result = await session;
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.marks, undefined);
});

test('a browser that cannot open rejects with the page address', async () => {
  await assert.rejects(
    runAnnotateSession({ png: PNG, width: 400, height: 200, waitMs: 50, open: async () => { throw new Error('no browser'); } }),
    /no browser\). The annotate page was http:\/\/127\.0\.0\.1:\d+\//,
  );
});
