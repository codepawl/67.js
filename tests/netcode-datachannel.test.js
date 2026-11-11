import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from '../src/runtime.js';
import { createDataChannelTransport, createNetcode } from '../src/netcode.js';

const FRAME_MILLISECONDS = 20;
const idleScheduler = { request: () => 1, cancel: () => {} };

// Two connected data-channel-like ends, as RTCDataChannel pairs behave: send on one is a message event on the other.
function createChannelPair() {
  const ends = [0, 1].map(() => ({ readyState: 'open', listeners: new Set(), closed: false }));
  ends.forEach((end, index) => {
    const other = ends[1 - index];
    end.send = text => other.listeners.forEach(listener => listener({ data: text }));
    end.addEventListener = (type, listener) => end.listeners.add(listener);
    end.removeEventListener = (type, listener) => end.listeners.delete(listener);
    end.close = () => {
      end.closed = true;
      end.readyState = 'closed';
    };
  });
  return ends;
}

function createPeer(netcodeOptions) {
  const netcode = createNetcode(netcodeOptions);
  const runtime = createRuntime({ render() {} }, { mode: 'both', fixedRate: 50, scheduler: idleScheduler, systems: [netcode] });
  return { netcode, runtime };
}

test('a data channel transport lists open channels, delivers to the named peer and drops a closed one', () => {
  const [hostEnd, firstEnd] = createChannelPair();
  const [secondHostEnd, secondEnd] = createChannelPair();
  const host = createDataChannelTransport({ id: 'host' });
  host.addChannel('first', hostEnd);
  host.addChannel('second', secondHostEnd);
  const first = createDataChannelTransport({ id: 'first' });
  first.addChannel('host', firstEnd);
  const heard = [];
  host.receive((peerId, message) => heard.push([peerId, message]));
  const firstHeard = [];
  first.receive((peerId, message) => firstHeard.push([peerId, message]));

  assert.deepEqual(host.peers().sort(), ['first', 'second']);
  first.send('host', { type: 'input' });
  host.send('first', { type: 'snapshot' });
  assert.deepEqual(heard, [['first', { type: 'input' }]]);
  assert.deepEqual(firstHeard, [['host', { type: 'snapshot' }]]);

  secondEnd.close();
  secondHostEnd.readyState = 'closed';
  assert.deepEqual(host.peers(), ['first']);
  host.send('second', { ignored: true });
  assert.equal(host.stats.sent, 1, 'a closed channel is skipped without throwing');

  host.removeChannel('first');
  assert.deepEqual(host.peers(), []);
  first.send('host', { type: 'late' });
  assert.equal(heard.length, 1, 'a removed channel no longer delivers');
});

test('a data channel transport rejects bad options, channels, oversized and malformed messages', () => {
  assert.throws(() => createDataChannelTransport({}), /createDataChannelTransport id/);
  assert.throws(() => createDataChannelTransport({ id: 'a', maximumMessageBytes: 10 }), /maximumMessageBytes/);
  const transport = createDataChannelTransport({ id: 'a', maximumMessageBytes: 256 });
  const [end] = createChannelPair();
  assert.throws(() => transport.addChannel('', end), /addChannel peerId/);
  assert.throws(() => transport.addChannel('b', {}), /data-channel-like/);
  transport.addChannel('b', end);
  assert.throws(() => transport.send('b', { text: 'x'.repeat(300) }), /at most 256/);
  end.listeners.forEach(listener => listener({ data: 'not json' }));
  end.listeners.forEach(listener => listener({ data: 42 }));
  end.listeners.forEach(listener => listener({ data: 'x'.repeat(300) }));
  assert.equal(transport.stats.rejected, 3);
  for (let index = 0; index < 31; index += 1) transport.addChannel(`peer-${index}`, createChannelPair()[0]);
  assert.throws(() => transport.addChannel('one-too-many', createChannelPair()[0]), /at most 32 peers/);
  transport.addChannel('b', createChannelPair()[0]);
  transport.close();
  assert.deepEqual(transport.peers(), []);
  assert.equal(end.listeners.size, 0);
});

test('a host and two clients sync players and a driven prop over data channels', () => {
  const hostTransport = createDataChannelTransport({ id: 'host' });
  const host = createPeer({ role: 'authority', authority: 'host', transport: hostTransport, localEntityId: 'host' });
  const clients = ['bob', 'cara'].map(name => {
    const [hostEnd, clientEnd] = createChannelPair();
    hostTransport.addChannel(name, hostEnd);
    const transport = createDataChannelTransport({ id: name });
    transport.addChannel('host', clientEnd);
    host.netcode.addEntity(name, { owner: name, tag: 'player' });
    return createPeer({ role: 'client', serverId: 'host', localEntityId: name, transport, readInput: () => ({ moveX: name === 'bob' ? 1 : -1 }) });
  });
  host.netcode.addEntity('crate', { tag: 'prop', state: { position: [0, 1, 0] } });

  for (let frame = 0; frame < 100; frame += 1) {
    host.netcode.setEntityState('crate', { position: [frame * 0.05, 1, 0] });
    host.runtime.step(FRAME_MILLISECONDS);
    clients.forEach(client => client.runtime.step(FRAME_MILLISECONDS));
  }
  const [bob, cara] = clients;
  const hostCrate = host.netcode.getEntityState('crate').position[0];
  assert.ok(hostCrate > 4.9);
  for (const client of clients) {
    assert.ok(Math.abs(client.netcode.getEntityState('crate').position[0] - hostCrate) < 0.6, 'the prop follows the host');
    assert.equal(client.netcode.stats.rejectedMessages, 0);
  }
  assert.ok(bob.netcode.getEntityState('bob').position[0] > 5);
  assert.ok(cara.netcode.getEntityState('cara').position[0] < -5);
  assert.ok(Math.abs(bob.netcode.getEntityState('cara').position[0] - host.netcode.getEntityState('cara').position[0]) < 0.8);
});
