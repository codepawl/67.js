import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from '../src/runtime.js';
import {
  NETCODE_LIMITS,
  createLoopbackNetwork,
  createNetcode,
  createPlanarMovement,
  createWebSocketTransport,
} from '../src/netcode.js';

const FRAME_MILLISECONDS = 20;
const FIXED_RATE = 50;
const PLAYER_SPEED = 5;

const idleScheduler = { request: () => 1, cancel: () => {} };

function createPeer(netcodeOptions) {
  const netcode = createNetcode(netcodeOptions);
  const runtime = createRuntime({ render() {} }, { mode: 'both', fixedRate: FIXED_RATE, scheduler: idleScheduler, systems: [netcode] });
  return { netcode, runtime };
}

// A scripted input for one player: a function of the frame number.
function scriptFor(pattern) {
  return frame => {
    const segment = pattern.find(entry => frame < entry.untilFrame);
    return segment ? { moveX: segment.moveX, moveZ: segment.moveZ } : { moveX: 0, moveZ: 0 };
  };
}

const SCRIPT_A = scriptFor([
  { untilFrame: 100, moveX: 1, moveZ: 0 },
  { untilFrame: 160, moveX: 0, moveZ: 1 },
  { untilFrame: 230, moveX: -1, moveZ: 0 },
  { untilFrame: 300, moveX: 0.5, moveZ: -0.5 },
]);
const SCRIPT_B = scriptFor([
  { untilFrame: 80, moveX: 0, moveZ: -1 },
  { untilFrame: 170, moveX: 1, moveZ: 0 },
  { untilFrame: 260, moveX: 0, moveZ: 1 },
]);

// Two clients and a server on a 100 ms, plus or minus 30 ms, 2 percent loss network, driven frame by frame.
function runSession({ seed = 11, frames = 520, lossRate = 0.02, onFrame, teleportAtFrame = null } = {}) {
  const network = createLoopbackNetwork({ seed, latencyMilliseconds: 100, jitterMilliseconds: 30, lossRate });
  const server = createPeer({ role: 'authority', authority: 'server', transport: network.createTransport('server') });
  server.netcode.addEntity('a', { owner: 'client-a', tag: 'player' });
  server.netcode.addEntity('b', { owner: 'client-b', tag: 'player' });
  server.netcode.addEntity('crate', { tag: 'prop', state: { position: [3, 1, 3], variables: { health: 10 } } });
  let frame = 0;
  const clientA = createPeer({ role: 'client', serverId: 'server', transport: network.createTransport('client-a'), localEntityId: 'a', readInput: () => SCRIPT_A(frame) });
  const clientB = createPeer({ role: 'client', serverId: 'server', transport: network.createTransport('client-b'), localEntityId: 'b', readInput: () => SCRIPT_B(frame) });
  const peers = [server, clientA, clientB];
  for (frame = 0; frame < frames; frame += 1) {
    network.advance(FRAME_MILLISECONDS);
    if (frame === teleportAtFrame) server.netcode.setEntityState('a', { position: [-20, 0, 15] });
    if (frame === 200) server.netcode.setEntityState('crate', { position: [4, 1, 3], variables: { health: 7 } });
    for (const peer of peers) peer.runtime.step(FRAME_MILLISECONDS);
    onFrame?.({ frame, server, clientA, clientB });
  }
  return { network, server, clientA, clientB };
}

function distance(first, second) {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

test('a predicted local player converges to the authority after reconciliation', () => {
  const { server, clientA, clientB } = runSession();
  for (const [client, id] of [[clientA, 'a'], [clientB, 'b']]) {
    const truth = server.netcode.getEntityState(id).position;
    const predicted = client.netcode.getEntityState(id).position;
    assert.ok(distance(truth, predicted) < 0.05, `${id}: predicted ${predicted} vs authority ${truth}`);
    assert.ok(client.netcode.stats.reconciliations > 50);
    assert.equal(client.netcode.pendingInputCount < NETCODE_LIMITS.maximumPendingInputs, true);
  }
  const moved = server.netcode.getEntityState('a').position;
  assert.ok(Math.abs(moved[0]) + Math.abs(moved[2]) > 1, 'the scripted input moved the player');
});

test('a correction from the authority pulls the prediction back within a bound', () => {
  const { server, clientA } = runSession({ teleportAtFrame: 300, frames: 520 });
  const truth = server.netcode.getEntityState('a').position;
  assert.ok(distance(truth, clientA.netcode.getEntityState('a').position) < 0.05);
  assert.ok(clientA.netcode.stats.maximumCorrection > 10, 'the teleport showed up as one large correction');
  assert.ok(truth[0] < -15, 'the authority state holds the teleport');
});

test('remote entities move without jumps above a bound', () => {
  let previous = null;
  let largestStep = 0;
  let frames = 0;
  runSession({
    onFrame({ frame, clientB }) {
      const seen = clientB.netcode.getEntityState('a');
      if (!seen || frame < 40) return;
      if (previous) largestStep = Math.max(largestStep, distance(previous, seen.position));
      previous = seen.position;
      frames += 1;
    },
  });
  const nominalStep = PLAYER_SPEED * (FRAME_MILLISECONDS / 1000);
  assert.ok(frames > 400);
  assert.ok(largestStep <= nominalStep * 1.6, `largest per-frame step ${largestStep} vs nominal ${nominalStep}`);
});

test('a remote view settles on the authority state and carries variables', () => {
  const { server, clientA, clientB } = runSession();
  const truth = server.netcode.getEntityState('a').position;
  assert.ok(distance(truth, clientB.netcode.getEntityState('a').position) < 0.05);
  const crate = clientA.netcode.getEntityState('crate');
  assert.ok(distance(crate.position, [4, 1, 3]) < 0.02);
  assert.ok(Math.abs(crate.variables.health - 7) < 0.02);
  assert.deepEqual(clientA.netcode.entityIds.sort(), ['a', 'b', 'crate']);
});

test('the same seed gives the same run and another seed gives another', () => {
  const trace = seed => {
    const positions = [];
    const { network, server } = runSession({
      seed,
      frames: 300,
      onFrame: ({ frame, clientB }) => {
        if (frame % 25 === 0) positions.push(clientB.netcode.getEntityState('a')?.position ?? null);
      },
    });
    return JSON.stringify({ positions, network: network.stats, bytes: server.netcode.stats.bytesSent });
  };
  assert.equal(trace(5), trace(5));
  assert.notEqual(trace(5), trace(6));
});

test('delta snapshots are mostly deltas and loss only costs a resend', () => {
  const { server } = runSession({ lossRate: 0.02 });
  const { snapshotsSent, fullSnapshotsSent } = server.netcode.stats;
  assert.ok(fullSnapshotsSent < snapshotsSent * 0.2, `${fullSnapshotsSent} full of ${snapshotsSent}`);
  const lossless = runSession({ lossRate: 0, frames: 300 });
  assert.ok(lossless.server.netcode.stats.fullSnapshotsSent <= 12);
});

test('a host also plays its own entity with no prediction', () => {
  const network = createLoopbackNetwork({ seed: 3, latencyMilliseconds: 40 });
  const host = createPeer({ role: 'authority', authority: 'host', transport: network.createTransport('host'), readInput: () => ({ moveX: 1 }) });
  host.netcode.addEntity('host-player', { owner: 'host' });
  const guest = createPeer({ role: 'client', serverId: 'host', transport: network.createTransport('guest'), localEntityId: 'guest-player', readInput: () => ({ moveZ: 1 }) });
  host.netcode.addEntity('guest-player', { owner: 'guest' });
  for (let frame = 0; frame < 150; frame += 1) {
    network.advance(FRAME_MILLISECONDS);
    host.runtime.step(FRAME_MILLISECONDS);
    guest.runtime.step(FRAME_MILLISECONDS);
  }
  const hostPosition = host.netcode.getEntityState('host-player').position;
  assert.ok(hostPosition[0] > 10);
  assert.ok(Math.abs(guest.netcode.getEntityState('host-player').position[0] - hostPosition[0]) < PLAYER_SPEED * 0.3);
});

test('custom simulation, removed entities and variables sync', () => {
  const network = createLoopbackNetwork({ seed: 2 });
  const jumper = (state, input, step) => ({
    ...state,
    variables: { ...state.variables, jumps: (state.variables.jumps ?? 0) + (input.jump ? 1 : 0) },
    position: [state.position[0] + step, 0, 0],
  });
  const server = createPeer({ role: 'authority', transport: network.createTransport('server'), simulate: jumper });
  const client = createPeer({ role: 'client', serverId: 'server', transport: network.createTransport('c'), simulate: jumper, localEntityId: 'p', readInput: () => ({ jump: true }) });
  server.netcode.addEntity('p', { owner: 'c' });
  server.netcode.addEntity('gone');
  for (let frame = 0; frame < 60; frame += 1) {
    network.advance(FRAME_MILLISECONDS);
    if (frame === 30) server.netcode.removeEntity('gone');
    server.runtime.step(FRAME_MILLISECONDS);
    client.runtime.step(FRAME_MILLISECONDS);
  }
  assert.deepEqual(client.netcode.entityIds, ['p']);
  assert.ok(client.netcode.getEntityState('p').variables.jumps > 30);
});

test('invalid options and calls throw errors that say what to pass', () => {
  const transport = createLoopbackNetwork().createTransport('t');
  assert.throws(() => createNetcode(), /options object/);
  assert.throws(() => createNetcode({ transport: {} }), /transport\.id/);
  assert.throws(() => createNetcode({ transport: { id: 'x' } }), /transport\.peers must be a function/);
  assert.throws(() => createNetcode({ transport, role: 'spectator' }), /role must be one of authority, client/);
  assert.throws(() => createNetcode({ transport, role: 'client' }), /serverId/);
  assert.throws(() => createNetcode({ transport, role: 'authority', authority: 'peer' }), /peer to peer\) is not supported yet/);
  assert.throws(() => createNetcode({ transport, role: 'authority', authority: 'cloud' }), /authority must be one of server, host/);
  assert.throws(() => createNetcode({ transport, role: 'authority', snapshotEveryTicks: 0 }), /snapshotEveryTicks/);
  assert.throws(() => createNetcode({ transport, role: 'authority', simulate: 3 }), /simulate must be a function/);
  const authority = createNetcode({ transport, role: 'authority' });
  assert.throws(() => authority.addEntity('', {}), /1 to 64 characters/);
  authority.addEntity('p', { owner: 'x', state: { position: [1, 2, 3] } });
  assert.throws(() => authority.addEntity('p'), /already exists/);
  assert.throws(() => authority.addEntity('q', { owner: 'x' }), /already owns/);
  assert.throws(() => authority.addEntity('q', { state: { position: [1, 2] } }), /array of 3 numbers/);
  assert.throws(() => authority.addEntity('q', { state: { position: [1e9, 0, 0] } }), /position\[0\] must be a number/);
  assert.throws(() => authority.addEntity('q', { state: { variables: { score: 'high' } } }), /score must be a number/);
  assert.throws(() => authority.setEntityState('nope', {}), /no entity named "nope"/);
  assert.throws(() => authority.removeEntity('nope'), /no entity named "nope"/);
  const client = createNetcode({ transport, role: 'client', serverId: 's' });
  assert.throws(() => client.addEntity('p'), /only for the authority/);
  assert.throws(() => createLoopbackNetwork({ lossRate: 2 }), /lossRate must be a number from 0 to 1/);
  assert.throws(() => createLoopbackNetwork().createTransport(''), /1 to 64 characters/);
  const network = createLoopbackNetwork();
  const first = network.createTransport('one');
  assert.throws(() => network.createTransport('one'), /already connected/);
  assert.throws(() => first.send('ghost', {}), /no transport named "ghost"/);
  assert.throws(() => createWebSocketTransport({}), /socket-like/);
});

test('bad network input is counted and ignored, and too many entities are refused', () => {
  const network = createLoopbackNetwork();
  const server = createPeer({ role: 'authority', transport: network.createTransport('server') });
  const rogue = network.createTransport('rogue');
  server.netcode.addEntity('p', { owner: 'rogue' });
  server.runtime.step(FRAME_MILLISECONDS);
  rogue.send('server', { type: 'input', inputs: 'nope' });
  rogue.send('server', { type: 'input', inputs: [{ sequence: 1, input: { moveX: 'fast' } }] });
  rogue.send('server', { type: 'input', inputs: [{ sequence: 1, input: { moveX: 1 } }, { sequence: 1, input: { moveX: -1 } }] });
  network.advance(1);
  server.runtime.step(FRAME_MILLISECONDS);
  assert.equal(server.netcode.stats.rejectedMessages, 2);
  assert.equal(server.netcode.stats.inputsProcessed, 1);
  assert.ok(server.netcode.getEntityState('p').position[0] > 0);

  const client = createPeer({ role: 'client', serverId: 'server', transport: network.createTransport('c') });
  client.runtime.step(FRAME_MILLISECONDS);
  const lookalike = network.createTransport('server-lookalike');
  lookalike.send('c', { type: 'snapshot', tick: 'x' });
  network.advance(1);
  assert.equal(client.netcode.stats.rejectedMessages, 0, 'a message from a peer that is not the server is ignored');
  const garbage = network.createTransport('garbage');
  garbage.send('server', 7);
  network.advance(1);
  assert.equal(server.netcode.stats.rejectedMessages, 3);
  for (let index = 0; index < NETCODE_LIMITS.maximumEntities - 1; index += 1) server.netcode.addEntity(`e${index}`);
  assert.throws(() => server.netcode.addEntity('overflow'), /at most 256 entities/);
});

test('a snapshot over the byte limit fails loudly instead of being cut', () => {
  const network = createLoopbackNetwork();
  const server = createPeer({ role: 'authority', transport: network.createTransport('server'), maximumMessageBytes: 300 });
  network.createTransport('c');
  for (let index = 0; index < 20; index += 1) server.netcode.addEntity(`entity-${index}`);
  server.runtime.step(FRAME_MILLISECONDS);
  assert.throws(() => server.runtime.step(FRAME_MILLISECONDS), /over maximumMessageBytes 300/);
});

test('planar movement turns input into a flat velocity', () => {
  const simulate = createPlanarMovement({ speed: 2 });
  const state = { position: [0, 1, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], variables: {} };
  const moved = simulate(state, { moveX: 5, moveZ: -1 }, 0.5);
  assert.deepEqual(moved.position, [1, 1, -1]);
  assert.deepEqual(moved.velocity, [2, 0, -2]);
  assert.throws(() => createPlanarMovement({ speed: -1 }), /speed must be a number/);
});

function createFakeSocket() {
  const listeners = new Map();
  return {
    readyState: 1,
    sent: [],
    send(text) { this.sent.push(text); },
    close() { this.readyState = 3; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    emit(type, event) { listeners.get(type)?.(event); },
  };
}

test('the WebSocket transport wraps a passed-in socket and opens nothing', () => {
  const socket = createFakeSocket();
  const transport = createWebSocketTransport(socket, { id: 'me', remoteId: 'host' });
  const received = [];
  const stop = transport.receive((peerId, message) => received.push([peerId, message]));
  assert.deepEqual(transport.peers(), ['host']);
  transport.send('host', { type: 'input', inputs: [] });
  assert.equal(socket.sent[0], '{"type":"input","inputs":[]}');
  socket.emit('message', { data: '{"type":"snapshot","tick":1}' });
  socket.emit('message', { data: 'not json' });
  socket.emit('message', { data: 42 });
  assert.deepEqual(received, [['host', { type: 'snapshot', tick: 1 }]]);
  assert.equal(transport.stats.rejected, 2);
  stop();
  socket.emit('message', { data: '{"a":1}' });
  assert.equal(received.length, 1);
  socket.readyState = 3;
  assert.deepEqual(transport.peers(), []);
  transport.send('host', {});
  assert.equal(socket.sent.length, 1);
  assert.throws(() => createWebSocketTransport(socket, { maximumMessageBytes: 10 }), /maximumMessageBytes must be/);
});

test('a multiplexed WebSocket transport addresses peers through a relay envelope', () => {
  const socket = createFakeSocket();
  const transport = createWebSocketTransport(socket, { id: 'server', multiplexed: true });
  const received = [];
  transport.receive((peerId, message) => received.push([peerId, message]));
  socket.emit('message', { data: '{"from":"alice","data":{"type":"input","inputs":[]}}' });
  socket.emit('message', { data: '{"from":"bob","data":{"type":"input","inputs":[]}}' });
  socket.emit('message', { data: '{"data":{}}' });
  assert.deepEqual(transport.peers(), ['alice', 'bob']);
  transport.send('alice', { type: 'snapshot' });
  assert.equal(socket.sent[0], '{"to":"alice","data":{"type":"snapshot"}}');
  socket.emit('message', { data: '{"from":"alice","left":true}' });
  assert.deepEqual(transport.peers(), ['bob']);
  assert.equal(received.length, 2);
  assert.equal(transport.stats.rejected, 1);
});

test('netcode over a WebSocket pair syncs a client to a host', () => {
  const clientSocket = createFakeSocket();
  const serverSocket = createFakeSocket();
  clientSocket.send = text => serverSocket.emit('message', { data: text });
  serverSocket.send = text => clientSocket.emit('message', { data: text });
  const server = createPeer({ role: 'authority', transport: createWebSocketTransport(serverSocket, { id: 'server', remoteId: 'client' }) });
  const client = createPeer({ role: 'client', serverId: 'server', localEntityId: 'p', transport: createWebSocketTransport(clientSocket, { id: 'client', remoteId: 'server' }), readInput: () => ({ moveX: 1 }) });
  server.netcode.addEntity('p', { owner: 'client' });
  for (let frame = 0; frame < 100; frame += 1) {
    server.runtime.step(FRAME_MILLISECONDS);
    client.runtime.step(FRAME_MILLISECONDS);
  }
  assert.ok(distance(server.netcode.getEntityState('p').position, client.netcode.getEntityState('p').position) < 0.3);
  assert.ok(server.netcode.getEntityState('p').position[0] > 5);
});
