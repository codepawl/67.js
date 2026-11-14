// Two real browser pages play the netcode sample together, once over BroadcastChannel and once over a WebSocket relay,
// each with 50 ms of injected latency per direction. The test checks that both pages converge and measures how long a
// move takes to show on the other page. It uses Playwright's browser or the installed Google Chrome, and skips with the reason printed when neither starts outside CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startNetcodeRelay } from '../scripts/netcode-relay.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVED_FOLDERS = ['/src/', '/scripts/netcode-sample.'];
const MIME_TYPES = { '.js': 'text/javascript', '.html': 'text/html' };
const INJECTED_LATENCY_MILLISECONDS = 50;
// About a pixel on the 30 px per unit sample canvas, so the clock stops at the first visible movement, not 50 ms into it.
const MOVE_DISTANCE = 0.05;
const CONVERGENCE_TOLERANCE = 0.05;
// What the netcode itself adds to a move, read from scripts/netcode-sample.js: the injected latency, up to one 20 ms fixed
// tick before the input is applied, one snapshot interval (every tick), the 40 ms interpolation delay and one drawn frame.
// Measured unloaded: 75 to 115 ms. The bound stays tight so an extra delay in the netcode path still fails.
const TICK_MILLISECONDS = 20;
const SNAPSHOT_INTERVAL_MILLISECONDS = 20;
const INTERPOLATION_DELAY_MILLISECONDS = 40;
const FRAME_MILLISECONDS = 17;
const MEASUREMENT_SLACK_MILLISECONDS = 15;
const MAXIMUM_NETCODE_LAG_MILLISECONDS = INJECTED_LATENCY_MILLISECONDS + TICK_MILLISECONDS + SNAPSHOT_INTERVAL_MILLISECONDS +
  INTERPOLATION_DELAY_MILLISECONDS + FRAME_MILLISECONDS + MEASUREMENT_SLACK_MILLISECONDS;
// A loaded runner delays page scheduling, not the netcode. Each lag is measured against a baseline taken in the same run
// between the same two pages, and only the part above that baseline is held to the bound. Lag noise only adds time, so the
// smallest excess of a few attempts is the netcode's own.
const BASELINE_PINGS = 5;
const LAG_ATTEMPTS = 3;

function startStaticServer() {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://local').pathname;
    const safe = normalize(path).replaceAll('\\', '/');
    if (!SERVED_FOLDERS.some(prefix => safe.startsWith(prefix)) || safe.includes('..')) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(join(REPOSITORY_ROOT, safe));
      response.writeHead(200, { 'content-type': MIME_TYPES[extname(safe)] ?? 'application/octet-stream' }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitUntil(condition, description, timeoutMilliseconds = 5000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await pause(10);
  }
}

async function measureLag(sender, receiver, movingId, input) {
  const watching = receiver.evaluateHandle(([id, distance]) => window.sample.whenEntityMoves(id, distance), [movingId, MOVE_DISTANCE]);
  await pause(50);
  const sentAt = await sender.evaluate(value => window.sample.setInput(value), input);
  const seenAt = await (await watching).jsonValue();
  await sender.evaluate(() => window.sample.setInput({ moveX: 0, moveZ: 0 }));
  await pause(700);
  return seenAt - sentAt;
}

// One-way time for a plain BroadcastChannel message between two pages to reach the receiver's next drawn frame, with no
// netcode and no injected latency: what the runner's load adds to any message between these pages. Returns the median.
async function measureBaseline(sender, receiver) {
  const samples = [];
  for (let ping = 0; ping < BASELINE_PINGS; ping += 1) {
    const arriving = receiver.evaluateHandle(() => new Promise(resolve => {
      const channel = new BroadcastChannel('crucible-netcode-baseline');
      channel.onmessage = event => requestAnimationFrame(() => {
        channel.close();
        resolve(Date.now() - event.data);
      });
    }));
    await pause(30);
    await sender.evaluate(() => {
      const channel = new BroadcastChannel('crucible-netcode-baseline');
      channel.postMessage(Date.now());
      setTimeout(() => channel.close(), 100);
    });
    samples.push(await (await arriving).jsonValue());
  }
  samples.sort((first, second) => first - second);
  return samples[Math.floor(samples.length / 2)];
}

// The lag above the runner's own scheduling baseline, smallest of several attempts.
async function measureNetcodeLag(sender, receiver, movingId, input) {
  let smallest = null;
  for (let attempt = 0; attempt < LAG_ATTEMPTS; attempt += 1) {
    const baseline = await measureBaseline(sender, receiver);
    // Alternate the direction so repeated attempts do not walk the player into the edge of the world.
    const direction = attempt % 2 === 0 ? 1 : -1;
    const lag = await measureLag(sender, receiver, movingId, { moveX: input.moveX * direction, moveZ: input.moveZ * direction });
    const excess = lag - baseline;
    if (smallest === null || excess < smallest.excess) smallest = { lag, baseline, excess };
  }
  return smallest;
}

async function playTogether(context, transport, relayUrl) {
  const query = `transport=${transport}&delay=${INJECTED_LATENCY_MILLISECONDS}${relayUrl ? `&relay=${encodeURIComponent(relayUrl)}` : ''}`;
  const hostPage = await context.newPage();
  const clientPage = await context.newPage();
  const base = context.baseUrl;
  await hostPage.goto(`${base}/scripts/netcode-sample.html?role=host&${query}`);
  await clientPage.goto(`${base}/scripts/netcode-sample.html?role=client&${query}`);
  await hostPage.evaluate(() => window.sampleReady);
  await clientPage.evaluate(() => window.sampleReady);
  await clientPage.waitForFunction(() => window.sample.netcode.stats.snapshotsReceived > 5, null, { timeout: 10000 });
  await pause(500);

  const hostToClientLag = await measureNetcodeLag(hostPage, clientPage, 'alice', { moveX: 1, moveZ: 0 });
  const clientToHostLag = await measureNetcodeLag(clientPage, hostPage, 'bob', { moveX: 0, moveZ: 1 });

  // Both players steer at once, then stop and let the last packets land.
  const turns = [{ moveX: 1, moveZ: 0.5 }, { moveX: -1, moveZ: 1 }, { moveX: 0, moveZ: -1 }];
  for (const turn of turns) {
    await hostPage.evaluate(value => window.sample.setInput(value), turn);
    await clientPage.evaluate(value => window.sample.setInput({ moveX: -value.moveX, moveZ: value.moveZ }), turn);
    await pause(400);
  }
  await hostPage.evaluate(() => window.sample.setInput({ moveX: 0, moveZ: 0 }));
  await clientPage.evaluate(() => window.sample.setInput({ moveX: 0, moveZ: 0 }));
  await pause(1200);

  const positions = {};
  for (const [name, page] of [['host', hostPage], ['client', clientPage]]) {
    positions[name] = await page.evaluate(() => ({ alice: window.sample.position('alice'), bob: window.sample.position('bob'), stats: window.sample.netcode.stats }));
  }
  return { hostToClientLag, clientToHostLag, positions };
}

// Playwright's own browser download is not installed on CI, so fall back to the Google Chrome the runner already has.
async function launchChrome(chromium) {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return chromium.launch({ headless: true, channel: 'chrome' });
  }
}

for (const transport of ['broadcast', 'websocket']) {
  test(`two browser pages converge and show a move within bounded lag over ${transport}`, async testContext => {
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch (error) {
      if (process.env.CI) {
        throw error;
      }
      testContext.skip('playwright is not installed');
      return;
    }
    const server = await startStaticServer();
    const relay = transport === 'websocket' ? await startNetcodeRelay({ port: 0 }) : null;
    let browser;
    try {
      try {
        browser = await launchChrome(chromium);
      } catch (error) {
        // On CI the runner ships Chrome, so a launch failure there is a real failure, not a reason to skip.
        if (process.env.CI) {
          throw error;
        }
        testContext.skip(`Chrome did not start: ${error.message.split('\n')[0]}`);
        return;
      }
      const context = await browser.newContext();
      context.baseUrl = `http://127.0.0.1:${server.address().port}`;
      const result = await playTogether(context, transport, relay ? `ws://127.0.0.1:${relay.port}/` : null);
      const { positions } = result;
      console.log(`netcode ${transport}: host to client ${result.hostToClientLag.lag} ms (baseline ${result.hostToClientLag.baseline}), client to host ${result.clientToHostLag.lag} ms (baseline ${result.clientToHostLag.baseline}), ` +
        `largest correction ${positions.client.stats.maximumCorrection.toFixed(4)}`);

      for (const id of ['alice', 'bob']) {
        for (let axis = 0; axis < 3; axis += 1) {
          const difference = Math.abs(positions.host[id][axis] - positions.client[id][axis]);
          assert.ok(difference <= CONVERGENCE_TOLERANCE, `${id} axis ${axis} differs by ${difference} between the pages`);
        }
      }
      assert.ok(Math.hypot(positions.host.alice[0] + 3, positions.host.alice[2]) > 0.3, 'the host player moved');
      for (const [label, measured] of [['host to client', result.hostToClientLag], ['client to host', result.clientToHostLag]]) {
        const description = `${label} lag ${measured.lag} ms with a ${measured.baseline} ms baseline`;
        assert.ok(measured.lag > INJECTED_LATENCY_MILLISECONDS, `${description} is below the injected latency`);
        assert.ok(measured.excess < MAXIMUM_NETCODE_LAG_MILLISECONDS, `${description}: ${measured.excess} ms of netcode lag, over the ${MAXIMUM_NETCODE_LAG_MILLISECONDS} ms bound`);
      }
      assert.equal(positions.host.stats.rejectedMessages, 0);
      assert.equal(positions.client.stats.rejectedMessages, 0);
    } finally {
      await browser?.close();
      await relay?.close();
      server.close();
    }
  });
}

test('the relay forwards to the named player, announces a leaver and refuses a repeated name', async () => {
  const relay = await startNetcodeRelay({ port: 0 });
  const open = id => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/?id=${id}`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
  const nextMessage = socket => new Promise(resolve => socket.once('message', data => resolve(JSON.parse(data.toString()))));
  try {
    const first = await open('first');
    const second = await open('second');
    const arrival = nextMessage(second);
    first.send(JSON.stringify({ to: 'second', data: { hello: 1 } }));
    assert.deepEqual(await arrival, { from: 'first', data: { hello: 1 } });

    const refused = new WebSocket(`ws://127.0.0.1:${relay.port}/?id=first`);
    const closeCode = await new Promise(resolve => refused.once('close', code => resolve(code)));
    assert.equal(closeCode, 1008);

    const departure = nextMessage(second);
    first.close();
    assert.deepEqual(await departure, { from: 'first', left: true });
    second.close();
  } finally {
    await relay.close();
  }
  await assert.rejects(startNetcodeRelay({ port: 70000 }), /port must be an integer/);
  await assert.rejects(startNetcodeRelay({ latencyMilliseconds: -1 }), /latencyMilliseconds/);
});

test('the relay survives an oversize frame and keeps forwarding for other players', async () => {
  const relay = await startNetcodeRelay({ port: 0 });
  const open = id => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/?id=${id}`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
  const nextMessageFrom = (socket, peerId) => new Promise(resolve => {
    const listener = data => {
      const message = JSON.parse(data.toString());
      if (message.from !== peerId) return;
      socket.off('message', listener);
      resolve(message);
    };
    socket.on('message', listener);
  });
  try {
    const sender = await open('sender');
    const receiver = await open('receiver');
    const offender = await open('offender');
    offender.on('error', () => {});
    const offenderClosed = new Promise(resolve => offender.once('close', () => resolve()));
    offender.send('x'.repeat(70000));
    await offenderClosed;

    // The relay also tells the receiver that the offender left, and that notice can land before the forwarded message.
    const arrival = nextMessageFrom(receiver, 'sender');
    sender.send(JSON.stringify({ to: 'receiver', data: { still: 'alive' } }));
    assert.deepEqual(await arrival, { from: 'sender', data: { still: 'alive' } });
    // The relay drops the offender when its own socket closes, which can land after the offender's side saw the close.
    await waitUntil(() => relay.peerIds.length === 2, 'the relay to drop the offender');
    assert.deepEqual(relay.peerIds.sort(), ['receiver', 'sender']);
    sender.close();
    receiver.close();
  } finally {
    await relay.close();
  }
});
