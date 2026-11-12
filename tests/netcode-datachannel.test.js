import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from '../src/runtime.js';
import { createDataChannelTransport, createNetcode } from '../src/netcode.js';

const FRAME_MILLISECONDS = 20;
const idleScheduler = { request: () => 1, cancel: () => {} };

// Two connected data-channel-like ends, as RTCDataChannel pairs behave: send on one is a message event on the other.
function createChannelPair() {
  // listeners holds message listeners; endListeners holds close and error listeners.
  const ends = [0, 1].map(() => ({ readyState: 'open', listeners: new Set(), endListeners: new Set(), closed: false }));
  ends.forEach((end, index) => {
    const other = ends[1 - index];
    const setFor = type => (type === 'message' ? end.listeners : end.endListeners);
    end.send = text => other.listeners.forEach(listener => listener({ data: text }));
    end.addEventListener = (type, listener) => setFor(type).add(listener);
    end.removeEventListener = (type, listener) => setFor(type).delete(listener);
    end.close = () => {
      end.closed = true;
      end.readyState = 'closed';
    };
    end.fireClose = () => {
      end.readyState = 'closed';
      [...end.endListeners].forEach(listener => listener({ type: 'close' }));
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
  for (const payload of ['null', '5', '[]', '"x"', 'true']) end.listeners.forEach(listener => listener({ data: payload }));
  end.listeners.forEach(listener => listener(undefined));
  assert.equal(transport.stats.rejected, 9);
  assert.equal(transport.stats.received, 0);
  for (let index = 0; index < 31; index += 1) transport.addChannel(`peer-${index}`, createChannelPair()[0]);
  assert.throws(() => transport.addChannel('one-too-many', createChannelPair()[0]), /at most 32 peers/);
  transport.addChannel('b', createChannelPair()[0]);
  transport.close();
  assert.deepEqual(transport.peers(), []);
  assert.equal(end.listeners.size, 0);
});

test('a closed or errored channel is evicted, so players can come and go past the peer limit', () => {
  const transport = createDataChannelTransport({ id: 'host' });
  const hostEnds = [];
  for (let index = 0; index < 32; index += 1) {
    const [hostEnd] = createChannelPair();
    hostEnds.push(hostEnd);
    transport.addChannel(`player-${index}`, hostEnd);
  }
  hostEnds.forEach(end => end.fireClose());
  assert.deepEqual(transport.peers(), []);
  hostEnds.forEach(end => {
    assert.equal(end.listeners.size, 0, 'the message listener is detached');
    assert.equal(end.endListeners.size, 0, 'the close listener is detached');
  });
  const [freshEnd] = createChannelPair();
  transport.addChannel('newcomer', freshEnd);
  assert.deepEqual(transport.peers(), ['newcomer']);

  // A channel that closes without an event is pruned when the cap is reached.
  const quietTransport = createDataChannelTransport({ id: 'quiet' });
  const quietEnds = [];
  for (let index = 0; index < 32; index += 1) {
    const [quietEnd] = createChannelPair();
    quietEnds.push(quietEnd);
    quietTransport.addChannel(`player-${index}`, quietEnd);
  }
  quietEnds.forEach(end => end.close());
  quietTransport.addChannel('newcomer', createChannelPair()[0]);
  assert.deepEqual(quietTransport.peers(), ['newcomer']);
  quietEnds.forEach(end => assert.equal(end.listeners.size, 0));

  // An error event evicts too.
  const [errorEnd] = createChannelPair();
  transport.addChannel('flaky', errorEnd);
  errorEnd.fireClose();
  assert.ok(!transport.peers().includes('flaky'));
});

test('adding a channel under an existing peer id replaces the old one, and a channel without close() is tolerated', () => {
  const transport = createDataChannelTransport({ id: 'host' });
  const heard = [];
  transport.receive((peerId, message) => heard.push([peerId, message]));
  const [oldEnd, oldRemote] = createChannelPair();
  const [newEnd, newRemote] = createChannelPair();
  transport.addChannel('player', oldEnd);
  transport.addChannel('player', newEnd);
  oldRemote.send('{"from":"old"}');
  newRemote.send('{"from":"new"}');
  assert.deepEqual(heard, [['player', { from: 'new' }]]);
  assert.equal(oldEnd.endListeners.size, 0);
  oldEnd.fireClose();
  assert.deepEqual(transport.peers(), ['player'], 'the replaced channel closing does not evict the new one');

  const bare = { readyState: 'open', send() {}, addEventListener() {} };
  transport.addChannel('bare', bare);
  transport.close();
  assert.deepEqual(transport.peers(), []);
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
