import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRuntime } from '../src/runtime.js';
import { createStreaming } from '../src/streaming.js';
import { createCrossingWorld, createPathPlayer, estimatedTileBytes, generateTile, parseTileSource, requirePlayerSpeed, tileBytes, tileId } from '../bench/streaming-crossing/world.js';

const FRAME_SECONDS = 1 / 30;

function digest(geometry) {
  return [geometry.positions, geometry.normals, geometry.indices].map(array => Buffer.from(array.buffer).toString('base64').length + Buffer.from(array.buffer).reduce((sum, value, index) => (sum + value * (index % 251 + 1)) % 1000003, 0));
}

// A tile loader that is asynchronous the way a worker is: the work finishes after the calling frame, never inside it.
function createTileLoader(world, frameState) {
  const loader = {
    loadsStartedInsideAFrame: 0,
    loaded: 0,
    disposed: 0,
    async load({ source }) {
      if (frameState.insideFrame) loader.loadsStartedInsideAFrame += 1;
      await new Promise(resolve => setImmediate(resolve));
      const geometry = generateTile(parseTileSource(source));
      loader.loaded += 1;
      return { asset: geometry, bytes: tileBytes(geometry) };
    },
    dispose() {
      loader.disposed += 1;
    },
  };
  return loader;
}

test('the crossing world is a seeded grid of 400 or more tiles with the same bytes every time', () => {
  const first = createCrossingWorld();
  const second = createCrossingWorld();
  assert.ok(first.assets.length >= 400, `got ${first.assets.length} tiles`);
  assert.deepEqual(first.assets, second.assets);
  assert.equal(new Set(first.assets.map(asset => asset.id)).size, first.assets.length);

  const source = parseTileSource(first.assets[100].levels[2].source);
  assert.deepEqual(digest(generateTile(source)), digest(generateTile(source)));
  assert.notDeepEqual(digest(generateTile(source)), digest(generateTile({ ...source, seed: source.seed + 1 })));
  assert.equal(tileBytes(generateTile(source)), estimatedTileBytes(source.resolution));
});

test('tile borders agree between neighbours, so streamed levels leave no gaps at the same detail', () => {
  const world = createCrossingWorld();
  const left = generateTile({ seed: 7, column: 3, row: 4, tilesPerSide: 24, tileSize: 20, resolution: 24 });
  const right = generateTile({ seed: 7, column: 4, row: 4, tilesPerSide: 24, tileSize: 20, resolution: 24 });
  const side = 25;
  for (let row = 0; row < side; row += 1) {
    const leftEdge = (row * side + 24) * 3;
    const rightEdge = (row * side) * 3;
    assert.equal(left.positions[leftEdge + 1], right.positions[rightEdge + 1]);
    assert.equal(left.normals[leftEdge + 1], right.normals[rightEdge + 1]);
  }
  assert.equal(world.settings.tilesPerSide, 24);
});

test('bad world input says what to pass', () => {
  assert.throws(() => createCrossingWorld({ tilesPerSide: 1 }), /tilesPerSide must be a whole number from 2 to 64/);
  assert.throws(() => createCrossingWorld({ levelDistances: [10] }), /one distance fewer/);
  assert.throws(() => createCrossingWorld({ seed: 1.5 }), /seed must be a whole number/);
  assert.throws(() => generateTile({ seed: 1, column: 0, row: 0, tilesPerSide: 4, tileSize: 20, resolution: 0 }), /resolution must be a whole number/);
  assert.throws(() => parseTileSource('mesh:1:2:3:4'), /Tile source must look like/);
  for (const speed of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 5000, '30']) {
    assert.throws(() => createCrossingWorld({ playerSpeed: speed }), /playerSpeed must be a number above 0/);
    assert.throws(() => requirePlayerSpeed(speed, '--speed'), /--speed must be a number above 0 and at most 1000/);
  }
});

test('the benchmark rejects a bad --speed before it starts a browser', () => {
  for (const value of [['--speed'], ['--speed', 'fast'], ['--speed', '0'], ['--speed', '--cpu']]) {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../bench/streaming-crossing/run.mjs', import.meta.url)), ...value], { encoding: 'utf8', timeout: 60000 });
    assert.notEqual(run.status, 0, `${value.join(' ')} was accepted`);
    assert.match(run.stderr, /--speed .*must be a number above 0 and at most 1000/);
  }
});

test('crossing the world through the runtime stays under the byte budget and never loads inside a frame', async () => {
  // Smaller tiles and a proportionally smaller budget keep the test fast; the benchmark uses the full size.
  const world = createCrossingWorld({ levelResolutions: [32, 16, 8], playerSpeed: 60, budgetBytes: 1.9 * 1024 * 1024 });
  const frameState = { insideFrame: false };
  const loader = createTileLoader(world, frameState);
  const budgetBytes = world.settings.budgetBytes;
  const evictionReasons = {};
  const player = createPathPlayer({ waypoints: world.path, seed: world.settings.seed, speed: world.settings.playerSpeed, eyeHeight: world.settings.eyeHeight });
  const streaming = createStreaming({ budgetBytes, maximumConcurrentLoads: 4, loaders: { 'terrain-tile': loader }, assets: world.assets, onEvent: event => { if (event.type === 'evict') evictionReasons[event.reason] = (evictionReasons[event.reason] ?? 0) + 1; }, focus: () => player.state.position });
  const runtime = createRuntime({ render() {} }, {
    mode: 'variable',
    systems: [player, streaming],
    scheduler: { request: () => 1, cancel() {} },
    clock: () => 0,
  });
  // Like the benchmark's loading screen: play starts after the tiles around the start are in, so every frame is checked.
  for (let round = 0; round < 200; round += 1) {
    const eventsBefore = streaming.events.length;
    streaming.update();
    await streaming.settled();
    if (streaming.stats.activeLoads === 0 && streaming.events.length === eventsBefore) break;
  }
  runtime.start();

  const half = world.settings.tilesPerSide / 2;
  const tileIndexUnder = coordinate => Math.min(world.settings.tilesPerSide - 1, Math.max(0, Math.floor(coordinate / world.settings.tileSize + half)));
  let peakBytes = 0;
  let framesWithoutGround = 0;
  let frames = 0;
  while (!player.state.finished) {
    frameState.insideFrame = true;
    runtime.step(FRAME_SECONDS * 1000);
    frameState.insideFrame = false;
    frames += 1;
    peakBytes = Math.max(peakBytes, streaming.stats.bytesInUse);
    assert.ok(streaming.stats.bytesInUse <= budgetBytes, `frame ${frames}: ${streaming.stats.bytesInUse} bytes in use exceeds the budget of ${budgetBytes}`);
    await new Promise(resolve => setImmediate(resolve));
    const tileUnderPlayer = tileId(tileIndexUnder(player.state.position[0]), tileIndexUnder(player.state.position[2]));
    if (streaming.getAsset(tileUnderPlayer) === null) framesWithoutGround += 1;
  }
  await streaming.settled();

  assert.equal(loader.loadsStartedInsideAFrame, 0, 'a load ran its work inside a frame');
  assert.ok(loader.loaded > 100, `only ${loader.loaded} tiles were loaded`);
  assert.ok(evictionReasons.budget > 0, 'the budget never forced a tile out, so the test proves nothing about eviction');
  assert.equal(loader.disposed, (evictionReasons.budget ?? 0) + (evictionReasons['level-switch'] ?? 0));
  assert.ok(peakBytes <= budgetBytes);
  assert.ok(peakBytes > budgetBytes * 0.3, `peak ${peakBytes} bytes says the budget was never close`);
  assert.equal(framesWithoutGround, 0, 'the tile under the player had not streamed in');
  assert.equal(streaming.stats.failed, 0);
  runtime.dispose();
});
