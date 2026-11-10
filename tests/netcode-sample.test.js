import assert from 'node:assert/strict';
import test from 'node:test';
import { withInjectedLatency } from '../scripts/netcode-sample.js';

function createFakeTransport() {
  const sent = [];
  const counters = { sent: 0 };
  const state = { closed: false };
  const transport = {
    id: 'fake',
    peers: () => ['other'],
    send(peerId, message) {
      sent.push([peerId, message]);
      counters.sent += 1;
    },
    receive: () => () => {},
    close() { state.closed = true; },
    get stats() { return { ...counters }; },
  };
  return { sent, state, transport };
}

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('withInjectedLatency delays sends and keeps stats and peers live', async () => {
  const fake = createFakeTransport();
  const delayed = withInjectedLatency(fake.transport, 30);
  assert.equal(delayed.id, 'fake');
  assert.deepEqual(delayed.peers(), ['other']);
  assert.equal(delayed.stats.sent, 0);

  delayed.send('other', { n: 1 });
  assert.equal(fake.sent.length, 0, 'nothing leaves before the delay');
  await pause(80);
  assert.deepEqual(fake.sent, [['other', { n: 1 }]]);
  assert.equal(delayed.stats.sent, 1, 'the stats getter follows the real transport');
});

test('withInjectedLatency drops sends still waiting when the transport closes, and passes through at zero delay', async () => {
  const fake = createFakeTransport();
  const delayed = withInjectedLatency(fake.transport, 30);
  delayed.send('other', { n: 1 });
  delayed.close();
  await pause(80);
  assert.equal(fake.state.closed, true);
  assert.equal(fake.sent.length, 0);
  assert.equal(withInjectedLatency(fake.transport, 0), fake.transport);
});
