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
// Measured on a loaded 28-thread machine: about 95 ms each way on both transports. The bound leaves room for load.
const MAXIMUM_LAG_MILLISECONDS = 250;

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

async function measureLag(sender, receiver, movingId, input) {
  const watching = receiver.evaluateHandle(([id, distance]) => window.sample.whenEntityMoves(id, distance), [movingId, MOVE_DISTANCE]);
  await pause(50);
  const sentAt = await sender.evaluate(value => window.sample.setInput(value), input);
  const seenAt = await (await watching).jsonValue();
  await sender.evaluate(() => window.sample.setInput({ moveX: 0, moveZ: 0 }));
  await pause(700);
  return seenAt - sentAt;
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

  const hostToClientLag = await measureLag(hostPage, clientPage, 'alice', { moveX: 1, moveZ: 0 });
  const clientToHostLag = await measureLag(clientPage, hostPage, 'bob', { moveX: 0, moveZ: 1 });

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
      console.log(`netcode ${transport}: host to client ${result.hostToClientLag} ms, client to host ${result.clientToHostLag} ms, ` +
        `largest correction ${positions.client.stats.maximumCorrection.toFixed(4)}`);

      for (const id of ['alice', 'bob']) {
        for (let axis = 0; axis < 3; axis += 1) {
          const difference = Math.abs(positions.host[id][axis] - positions.client[id][axis]);
          assert.ok(difference <= CONVERGENCE_TOLERANCE, `${id} axis ${axis} differs by ${difference} between the pages`);
        }
      }
      assert.ok(Math.hypot(positions.host.alice[0] + 3, positions.host.alice[2]) > 0.3, 'the host player moved');
      assert.ok(result.hostToClientLag > INJECTED_LATENCY_MILLISECONDS && result.hostToClientLag < MAXIMUM_LAG_MILLISECONDS, `host to client lag ${result.hostToClientLag} ms`);
      assert.ok(result.clientToHostLag > INJECTED_LATENCY_MILLISECONDS && result.clientToHostLag < MAXIMUM_LAG_MILLISECONDS, `client to host lag ${result.clientToHostLag} ms`);
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
  const nextMessage = socket => new Promise(resolve => socket.once('message', data => resolve(JSON.parse(data.toString()))));
  try {
    const sender = await open('sender');
    const receiver = await open('receiver');
    const offender = await open('offender');
    offender.on('error', () => {});
    const offenderClosed = new Promise(resolve => offender.once('close', () => resolve()));
    offender.send('x'.repeat(70000));
    await offenderClosed;

    const arrival = nextMessage(receiver);
    sender.send(JSON.stringify({ to: 'receiver', data: { still: 'alive' } }));
    assert.deepEqual(await arrival, { from: 'sender', data: { still: 'alive' } });
    assert.deepEqual(relay.peerIds.sort(), ['receiver', 'sender']);
    sender.close();
    receiver.close();
  } finally {
    await relay.close();
  }
});
