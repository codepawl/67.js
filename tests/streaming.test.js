import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from '../src/runtime.js';
import { createGlbLoader, createStreaming, createWorkerLoader, selectDetailLevel } from '../src/streaming.js';

function fakeLoader() {
  const log = [];
  const disposed = [];
  return {
    log,
    disposed,
    async load({ id, level, source }) {
      log.push(`${id}#${level}`);
      return { asset: { id, level, source }, bytes: 100 };
    },
    dispose(asset) {
      disposed.push(`${asset.id}#${asset.level}`);
    },
  };
}

function tileDefinition(id, x, overrides = {}) {
  return { id, format: 'tile', source: `${id}.bin`, position: [x, 0, 0], loadDistance: 15, estimatedBytes: 100, ...overrides };
}

async function walkTo(streaming, point) {
  streaming.setFocus(point);
  streaming.update();
  await streaming.settled();
}

test('evicts the least recently used far asset to stay under the byte budget', async () => {
  const loader = fakeLoader();
  const streaming = createStreaming({ budgetBytes: 250, loaders: { tile: loader } });
  for (const [id, x] of [['a', 0], ['b', 100], ['c', 200]]) streaming.addAsset(tileDefinition(id, x));

  await walkTo(streaming, [0, 0, 0]);
  await walkTo(streaming, [100, 0, 0]);
  assert.equal(streaming.stats.bytesInUse, 200);
  await walkTo(streaming, [200, 0, 0]);

  assert.deepEqual(loader.disposed, ['a#0']);
  assert.equal(streaming.getState('a').state, 'evicted');
  assert.equal(streaming.getState('b').state, 'loaded');
  assert.equal(streaming.getState('c').state, 'loaded');
  assert.ok(streaming.stats.bytesInUse <= 250);
  assert.equal(streaming.getAsset('a'), null);
});

test('never evicts an asset the focus still wants', async () => {
  const streaming = createStreaming({ budgetBytes: 150, loaders: { tile: fakeLoader() } });
  streaming.addAsset(tileDefinition('near', 0));
  streaming.addAsset(tileDefinition('also-near', 5));
  await walkTo(streaming, [2, 0, 0]);
  assert.equal(streaming.getState('near').state, 'loaded');
  assert.equal(streaming.getState('also-near').state, 'idle');
  assert.equal(streaming.stats.bytesInUse, 100);
});

test('a pinned request survives budget pressure until it is released', async () => {
  const streaming = createStreaming({ budgetBytes: 100, loaders: { tile: fakeLoader() } });
  streaming.addAsset(tileDefinition('boss', 500, { loadDistance: 1 }));
  streaming.addAsset(tileDefinition('door', 0));
  streaming.request('boss');
  await walkTo(streaming, [500, 0, 0]);
  await walkTo(streaming, [0, 0, 0]);
  assert.equal(streaming.getState('boss').state, 'loaded');
  assert.equal(streaming.getState('door').state, 'idle');
  streaming.release('boss');
  await walkTo(streaming, [0, 0, 0]);
  assert.equal(streaming.getState('boss').state, 'evicted');
  assert.equal(streaming.getState('door').state, 'loaded');
});

test('hysteresis keeps a level while the distance wobbles around a boundary', () => {
  const ends = [50];
  let level = 0;
  const seen = [];
  for (const distance of [48, 51, 49, 52, 54, 50.5, 47, 46, 44.9, 51, 56]) {
    level = selectDetailLevel(ends, distance, level, 0.1);
    seen.push(level);
  }
  assert.deepEqual(seen, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(selectDetailLevel(ends, 46, 1, 0.1), 1);
  assert.equal(selectDetailLevel(ends, 44, 1, 0.1), 0);
  assert.equal(selectDetailLevel([10, 20, 30], 100, 0, 0), 3);
});

test('a streamed asset switches level once and does not reload while it wobbles at the boundary', async () => {
  const loader = fakeLoader();
  const streaming = createStreaming({ budgetBytes: 1000, loaders: { tile: loader } });
  streaming.addAsset({
    id: 'tree', format: 'tile', position: [0, 0, 0], loadDistance: 200,
    levels: [{ source: 'tree-high', estimatedBytes: 100, maximumDistance: 50 }, { source: 'tree-low', estimatedBytes: 20 }],
  });
  for (const distance of [40, 51, 49, 52, 55, 48, 45]) await walkTo(streaming, [distance, 0, 0]);
  assert.deepEqual(loader.log, ['tree#0']);
  for (const distance of [56, 49, 54]) await walkTo(streaming, [distance, 0, 0]);
  assert.deepEqual(loader.log, ['tree#0', 'tree#1']);
  assert.deepEqual(loader.disposed, ['tree#0']);
  assert.equal(streaming.getState('tree').level, 1);
  assert.equal(streaming.getAsset('tree').level, 1);
});

test('loader plugins register by format and reject bad input with a fix', () => {
  const streaming = createStreaming({ budgetBytes: 1000 });
  assert.deepEqual(streaming.loaders, ['glb']);
  streaming.registerLoader('splat-cloud', fakeLoader());
  assert.deepEqual(streaming.loaders, ['glb', 'splat-cloud']);
  assert.throws(() => streaming.registerLoader('glb', fakeLoader()), /already registered/);
  assert.throws(() => streaming.registerLoader('Bad Name', fakeLoader()), /lowercase name/);
  assert.throws(() => streaming.registerLoader('x', { load: 1 }), /must be an object/);
  assert.throws(() => streaming.registerLoader('y', { load() {}, dispose: 3 }), /dispose must be a function/);
  assert.throws(() => streaming.addAsset({ id: 'a', format: 'ktx', source: 'a', estimatedBytes: 1 }), /no loader.*registered: glb, splat-cloud/);
  assert.throws(() => createStreaming({}), /budgetBytes/);
  assert.throws(() => createStreaming({ budgetBytes: 10, maximumConcurrentLoads: 99 }), /maximumConcurrentLoads/);
  streaming.addAsset({ id: 'a', format: 'glb', source: 'a.glb', estimatedBytes: 10 });
  assert.throws(() => streaming.addAsset({ id: 'a', format: 'glb', source: 'a.glb', estimatedBytes: 10 }), /already exists/);
  assert.throws(() => streaming.addAsset({ id: 'b', format: 'glb', source: 'b.glb' }), /estimatedBytes/);
  assert.throws(() => streaming.addAsset({ id: 'b', format: 'glb', source: 'b.glb', estimatedBytes: 1, position: [0, 0] }), /three finite numbers/);
  assert.throws(() => streaming.request('missing'), /No streamed asset named "missing"/);
  assert.throws(() => streaming.setFocus('here'), /\[x, y, z\]/);
});

test('the GLB loader passes its bytes to the glTF parser', async () => {
  const loader = createGlbLoader({ fetchBytes: async () => new ArrayBuffer(64) });
  await assert.rejects(loader.load({ source: 'x.glb' }), /glTF|GLB|JSON|binary|header/i);
  assert.equal(typeof loader.dispose, 'function');
});

test('a failed load is reported in the state and can be requested again', async () => {
  let attempts = 0;
  const loader = {
    async load() {
      attempts += 1;
      if (attempts === 1) throw new Error('404 for broken.bin');
      return { asset: {}, bytes: 10 };
    },
  };
  const streaming = createStreaming({ budgetBytes: 100, loaders: { tile: loader } });
  streaming.addAsset(tileDefinition('broken', 0));
  await walkTo(streaming, [0, 0, 0]);
  assert.equal(streaming.getState('broken').state, 'failed');
  assert.match(streaming.getState('broken').failure, /404/);
  streaming.request('broken');
  await walkTo(streaming, [0, 0, 0]);
  assert.equal(streaming.getState('broken').state, 'loaded');
});

test('a scripted walk across a grid of tiles streams in the same order every run', async () => {
  async function run() {
    const loader = fakeLoader();
    const streaming = createStreaming({ budgetBytes: 450, loaders: { tile: loader }, maximumConcurrentLoads: 3 });
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        streaming.addAsset(tileDefinition(`tile-${row}-${column}`, 0, { position: [column * 100, 0, row * 100], loadDistance: 120 }));
      }
    }
    for (let step = 0; step <= 6; step += 1) await walkTo(streaming, [step * 50, 0, step * 40]);
    assert.ok(streaming.stats.bytesInUse <= 450);
    return { order: loader.log, evicted: loader.disposed, events: streaming.events.map(event => `${event.type}:${event.id}`) };
  }
  const first = await run();
  const second = await run();
  assert.deepEqual(first, second);
  assert.deepEqual(first.order.slice(0, 3), ['tile-0-0#0', 'tile-0-1#0', 'tile-1-0#0']);
  assert.ok(first.evicted.length > 0);
});

test('runs as a runtime system and disposes what it holds', async () => {
  const loader = fakeLoader();
  const streaming = createStreaming({ budgetBytes: 500, loaders: { tile: loader }, focus: () => [0, 0, 0] });
  streaming.addAsset(tileDefinition('home', 0));
  const runtime = createRuntime({ render() {} }, { mode: 'variable', systems: [streaming], scheduler: { request: () => 1, cancel() {} }, clock: () => 0 });
  runtime.start();
  runtime.step(16);
  await streaming.settled();
  assert.equal(streaming.getState('home').state, 'loaded');
  runtime.dispose();
  assert.deepEqual(loader.disposed, ['home#0']);
  assert.throws(() => streaming.addAsset(tileDefinition('late', 0)), /disposed/);
});

test('eviction frees low priority assets first, then the farthest, whatever the use order', async () => {
  const loader = fakeLoader();
  const streaming = createStreaming({ budgetBytes: 300, loaders: { tile: loader } });
  streaming.addAsset(tileDefinition('important', 0, { priority: 10 }));
  streaming.addAsset(tileDefinition('far-plain', 100));
  streaming.addAsset(tileDefinition('near-plain', 200));
  streaming.addAsset(tileDefinition('newcomer', 300));

  await walkTo(streaming, [0, 0, 0]);
  await walkTo(streaming, [100, 0, 0]);
  await walkTo(streaming, [200, 0, 0]);
  await walkTo(streaming, [300, 0, 0]);

  assert.deepEqual(loader.disposed, ['far-plain#0']);
});

// west is used first (least recent) and nearer to the final focus; east is used last and farther.
for (const [evictionOrder, expected] of [[undefined, 'west#0'], ['recency', 'west#0'], ['distance', 'east#0']]) {
  test(`eviction order ${evictionOrder ?? 'default'} frees ${expected} among equal priority assets`, async () => {
    const loader = fakeLoader();
    const streaming = createStreaming({ budgetBytes: 200, evictionOrder, loaders: { tile: loader } });
    streaming.addAsset(tileDefinition('west', -100));
    streaming.addAsset(tileDefinition('east', 100));
    streaming.addAsset(tileDefinition('north', 0, { position: [-100, 0, 300] }));
    await walkTo(streaming, [-100, 0, 0]);
    await walkTo(streaming, [100, 0, 0]);
    await walkTo(streaming, [-100, 0, 300]);
    assert.deepEqual(loader.disposed, [expected]);
  });
}

test('an unknown eviction order is rejected with the choices', () => {
  assert.throws(() => createStreaming({ budgetBytes: 100, evictionOrder: 'random' }), /evictionOrder must be "recency".*"distance"/);
});

test('a priority outside the range is rejected with the range', () => {
  const streaming = createStreaming({ budgetBytes: 100, loaders: { tile: fakeLoader() } });
  assert.throws(() => streaming.addAsset(tileDefinition('a', 0, { priority: 500 })), /priority must be a number from -100 to 100/);
});

function fakeWorkerFactory(behavior) {
  const workers = [];
  const createWorker = () => {
    const worker = {
      terminated: false,
      posted: [],
      postMessage(message) {
        worker.posted.push(message);
        queueMicrotask(() => behavior(worker, message));
      },
      terminate() {
        worker.terminated = true;
      },
    };
    workers.push(worker);
    return worker;
  };
  return { workers, createWorker };
}

test('the worker loader decodes in a worker and terminates it after each load', async () => {
  const { workers, createWorker } = fakeWorkerFactory((worker, message) => worker.onmessage({ data: { asset: { decoded: message.source }, bytes: 64 } }));
  const freed = [];
  const streaming = createStreaming({
    budgetBytes: 1000,
    loaders: { tile: createWorkerLoader({ createWorker, dispose: asset => freed.push(asset.decoded) }) },
  });
  streaming.addAsset(tileDefinition('a', 0));
  streaming.addAsset(tileDefinition('b', 5));
  await walkTo(streaming, [0, 0, 0]);

  assert.deepEqual(streaming.getAsset('a'), { decoded: 'a.bin' });
  assert.equal(streaming.getState('b').bytes, 64);
  assert.equal(workers.length, 2);
  assert.ok(workers.every(worker => worker.terminated));
  assert.deepEqual(workers[0].posted[0], { id: 'a', format: 'tile', source: 'a.bin', level: 0 });
  streaming.dispose();
  assert.deepEqual(freed.sort(), ['a.bin', 'b.bin']);
});

test('a worker error fails the load and a dispose aborts the worker in flight', async () => {
  const failing = fakeWorkerFactory(worker => worker.onmessage({ data: { error: 'bad tile' } }));
  const failingStreaming = createStreaming({ budgetBytes: 1000, loaders: { tile: createWorkerLoader({ createWorker: failing.createWorker }) } });
  failingStreaming.addAsset(tileDefinition('a', 0));
  await walkTo(failingStreaming, [0, 0, 0]);
  assert.equal(failingStreaming.getState('a').state, 'failed');
  assert.equal(failingStreaming.getState('a').failure, 'bad tile');
  assert.ok(failing.workers[0].terminated);

  const silent = fakeWorkerFactory(() => {});
  const silentStreaming = createStreaming({ budgetBytes: 1000, loaders: { tile: createWorkerLoader({ createWorker: silent.createWorker }) } });
  silentStreaming.addAsset(tileDefinition('a', 0));
  silentStreaming.update();
  await new Promise(resolve => setTimeout(resolve, 0));
  silentStreaming.dispose();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(silent.workers[0].terminated);
  assert.equal(silentStreaming.stats.activeLoads, 0);
});

test('createWorkerLoader says what to pass when createWorker is missing', () => {
  assert.throws(() => createWorkerLoader({}), /createWorker: a function/);
  assert.throws(() => createWorkerLoader({ createWorker: () => ({}), dispose: 3 }), /dispose must be a function/);
});

test('a postMessage that throws fails the load and terminates the worker', async () => {
  const { workers, createWorker } = fakeWorkerFactory(() => {});
  const throwing = () => {
    const worker = createWorker();
    worker.postMessage = () => {
      throw new Error('clone');
    };
    return worker;
  };
  const controller = new AbortController();
  const loader = createWorkerLoader({ createWorker: throwing });
  await assert.rejects(loader.load({ id: 'a', format: 'tile', source: 'a.bin', level: 0, signal: controller.signal }), /clone/);
  assert.ok(workers[0].terminated);
  controller.abort();
  assert.equal(workers.length, 1);
});

test('a createWorker that throws fails the load', async () => {
  const loader = createWorkerLoader({ createWorker: () => { throw new Error('no worker'); } });
  await assert.rejects(loader.load({ id: 'a', format: 'tile', source: 'a.bin', level: 0, signal: new AbortController().signal }), /no worker/);
});

test('a worker reply without an asset fails the load', async () => {
  const { workers, createWorker } = fakeWorkerFactory(worker => worker.onmessage({ data: { bytes: 64 } }));
  const loader = createWorkerLoader({ createWorker });
  await assert.rejects(loader.load({ id: 'a', format: 'tile', source: 'a.bin', level: 0, signal: new AbortController().signal }), /answered without an asset/);
  assert.ok(workers[0].terminated);
});

test('an unreadable worker reply fails the load and frees the slot', async () => {
  const { workers, createWorker } = fakeWorkerFactory(worker => worker.onmessageerror({}));
  const streaming = createStreaming({ budgetBytes: 1000, loaders: { tile: createWorkerLoader({ createWorker }) } });
  streaming.addAsset(tileDefinition('a', 0));
  await walkTo(streaming, [0, 0, 0]);
  assert.equal(streaming.getState('a').state, 'failed');
  assert.match(streaming.getState('a').failure, /"a" sent a reply that could not be read/);
  assert.ok(workers[0].terminated);
  assert.equal(streaming.stats.activeLoads, 0);
});
