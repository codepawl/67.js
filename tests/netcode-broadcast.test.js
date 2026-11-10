import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from '../src/runtime.js';
import { createBroadcastChannelTransport, createNetcode } from '../src/netcode.js';

const FRAME_MILLISECONDS = 20;
const idleScheduler = { request: () => 1, cancel: () => {} };

// A shared bus that behaves like BroadcastChannel: a posted value reaches every other channel, never the sender.
function createFakeBroadcastBus() {
  const channels = [];
  return () => {
    const listeners = new Set();
    const channel = {
      postMessage: value => {
        for (const other of channels) if (other !== channel) other.deliver(JSON.parse(JSON.stringify(value)));
      },
      addEventListener: (type, listener) => listeners.add(listener),
      removeEventListener: (type, listener) => listeners.delete(listener),
      deliver: data => listeners.forEach(listener => listener({ data })),
      close: () => channels.splice(channels.indexOf(channel), 1),
    };
    channels.push(channel);
    return channel;
  };
}

function createPeer(netcodeOptions) {
  const netcode = createNetcode(netcodeOptions);
  const runtime = createRuntime({ render() {} }, { mode: 'both', fixedRate: 50, scheduler: idleScheduler, systems: [netcode] });
  return { netcode, runtime };
}

test('a BroadcastChannel transport finds peers, delivers to the named peer only and forgets a leaver', () => {
  const openChannel = createFakeBroadcastBus();
  const host = createBroadcastChannelTransport(openChannel(), { id: 'host' });
  const first = createBroadcastChannelTransport(openChannel(), { id: 'first' });
  const second = createBroadcastChannelTransport(openChannel(), { id: 'second' });
  assert.deepEqual(host.peers().sort(), ['first', 'second']);
  assert.deepEqual(first.peers().sort(), ['host', 'second']);
  const heard = { host: [], first: [], second: [] };
  host.receive((peerId, message) => heard.host.push([peerId, message]));
  first.receive((peerId, message) => heard.first.push([peerId, message]));
  second.receive((peerId, message) => heard.second.push([peerId, message]));
  host.send('first', { type: 'snapshot' });
  first.send('host', { type: 'input' });
  assert.deepEqual(heard, { host: [['first', { type: 'input' }]], first: [['host', { type: 'snapshot' }]], second: [] });
  second.close();
  assert.deepEqual(host.peers().sort(), ['first']);
  assert.equal(host.stats.received, 1);
});

test('a BroadcastChannel transport rejects bad channels, ids, oversized messages and malformed packets', () => {
  const openChannel = createFakeBroadcastBus();
  assert.throws(() => createBroadcastChannelTransport({}, { id: 'a' }), /BroadcastChannel-like/);
  assert.throws(() => createBroadcastChannelTransport(openChannel(), {}), /createBroadcastChannelTransport id/);
  assert.throws(() => createBroadcastChannelTransport(openChannel(), { id: 'a', maximumMessageBytes: 10 }), /maximumMessageBytes/);
  const channel = openChannel();
  const transport = createBroadcastChannelTransport(channel, { id: 'a', maximumMessageBytes: 256 });
  assert.throws(() => transport.send('b', { text: 'x'.repeat(300) }), /at most 256/);
  channel.deliver('not an object');
  channel.deliver({ data: {} });
  assert.equal(transport.stats.rejected, 2);
  assert.deepEqual(transport.peers(), []);
});

test('netcode over BroadcastChannel transports syncs a client to a host', () => {
  const openChannel = createFakeBroadcastBus();
  const host = createPeer({ role: 'authority', transport: createBroadcastChannelTransport(openChannel(), { id: 'host' }) });
  const client = createPeer({
    role: 'client',
    serverId: 'host',
    localEntityId: 'p',
    transport: createBroadcastChannelTransport(openChannel(), { id: 'client' }),
    readInput: () => ({ moveX: 1 }),
  });
  host.netcode.addEntity('p', { owner: 'client' });
  for (let frame = 0; frame < 100; frame += 1) {
    host.runtime.step(FRAME_MILLISECONDS);
    client.runtime.step(FRAME_MILLISECONDS);
  }
  const hostPosition = host.netcode.getEntityState('p').position;
  const clientPosition = client.netcode.getEntityState('p').position;
  assert.ok(Math.abs(hostPosition[0] - clientPosition[0]) < 0.3);
  assert.ok(hostPosition[0] > 5);
});
