// A two-player sample for 67js/addons/netcode. One page hosts (it owns the truth and plays "alice"), the other is a client
// that predicts "bob". Each player moves a square with the arrow keys or WASD; both pages draw both squares.
// Open scripts/netcode-sample.html?role=host and scripts/netcode-sample.html?role=client in two tabs; see docs/netcode.md.
import { createRuntime } from '../src/runtime.js';
import {
  createBroadcastChannelTransport,
  createNetcode,
  createWebSocketTransport,
} from '../src/netcode.js';

const HOST_ID = 'alice';
const CLIENT_ID = 'bob';
const WORLD_HALF_SIZE = 8;
const FIXED_RATE = 50;
const KEY_DIRECTIONS = {
  ArrowLeft: [-1, 0], KeyA: [-1, 0],
  ArrowRight: [1, 0], KeyD: [1, 0],
  ArrowUp: [0, -1], KeyW: [0, -1],
  ArrowDown: [0, 1], KeyS: [0, 1],
};

function openWebSocket(relayUrl, playerId) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${relayUrl}?id=${encodeURIComponent(playerId)}`);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error(`Could not reach the relay at ${relayUrl}. Start it with: node scripts/netcode-relay.mjs`)), { once: true });
  });
}

// Delays what a transport sends, to feel a slow connection on one machine.
function withInjectedLatency(transport, delayMilliseconds) {
  if (delayMilliseconds <= 0) return transport;
  return { ...transport, send: (peerId, message) => { setTimeout(() => transport.send(peerId, message), delayMilliseconds); } };
}

async function createSampleTransport(options, playerId, remoteId) {
  if (options.transport === 'broadcast') {
    return createBroadcastChannelTransport(new BroadcastChannel('67js-netcode-sample'), { id: playerId });
  }
  if (options.transport === 'websocket') {
    const socket = await openWebSocket(options.relayUrl, playerId);
    return createWebSocketTransport(socket, { id: playerId, remoteId, multiplexed: true });
  }
  throw new RangeError(`Sample transport must be "broadcast" or "websocket", got ${JSON.stringify(options.transport)}.`);
}

function readKeyboard(pressedKeys) {
  let moveX = 0;
  let moveZ = 0;
  for (const code of pressedKeys) {
    moveX += KEY_DIRECTIONS[code][0];
    moveZ += KEY_DIRECTIONS[code][1];
  }
  return { moveX: Math.sign(moveX), moveZ: Math.sign(moveZ) };
}

function drawPlayers(canvas, netcode, localId) {
  const context = canvas.getContext('2d');
  const scale = canvas.width / (WORLD_HALF_SIZE * 2);
  context.fillStyle = '#14161a';
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (const [id, color] of [[HOST_ID, '#f0b429'], [CLIENT_ID, '#4fc3f7']]) {
    const state = netcode.getEntityState(id);
    if (!state) continue;
    const x = (state.position[0] + WORLD_HALF_SIZE) * scale;
    const y = (state.position[2] + WORLD_HALF_SIZE) * scale;
    context.fillStyle = color;
    context.fillRect(x - 10, y - 10, 20, 20);
    if (id === localId) {
      context.strokeStyle = '#ffffff';
      context.strokeRect(x - 12, y - 12, 24, 24);
    }
  }
}

// options: { role: 'host' | 'client', transport: 'broadcast' | 'websocket', relayUrl, delayMilliseconds, canvas }
export async function startSample(options) {
  const isHost = options.role === 'host';
  const playerId = isHost ? HOST_ID : CLIENT_ID;
  const remoteId = isHost ? CLIENT_ID : HOST_ID;
  const transport = withInjectedLatency(await createSampleTransport(options, playerId, remoteId), options.delayMilliseconds ?? 0);

  const pressedKeys = new Set();
  let scriptedInput = null;
  const readInput = () => scriptedInput ?? readKeyboard(pressedKeys);
  window.addEventListener('keydown', event => { if (event.code in KEY_DIRECTIONS) pressedKeys.add(event.code); });
  window.addEventListener('keyup', event => pressedKeys.delete(event.code));

  const netcode = createNetcode(isHost
    ? { role: 'authority', authority: 'host', transport, readInput }
    : { role: 'client', serverId: HOST_ID, localEntityId: CLIENT_ID, transport, readInput });
  if (isHost) {
    netcode.addEntity(HOST_ID, { owner: HOST_ID, tag: 'player', state: { position: [-3, 0, 0] } });
    netcode.addEntity(CLIENT_ID, { owner: CLIENT_ID, tag: 'player', state: { position: [3, 0, 0] } });
  }
  const runtime = createRuntime({ render() {} }, { fixedRate: FIXED_RATE, pauseWhenHidden: false, systems: [netcode] });
  runtime.start();

  const draw = () => {
    if (options.canvas) drawPlayers(options.canvas, netcode, playerId);
    requestAnimationFrame(draw);
  };
  draw();

  // Resolves with the wall-clock time at which an entity drawn on this page has moved `distance` away from where it is now.
  function whenEntityMoves(entityId, distance) {
    const start = netcode.getEntityState(entityId).position;
    return new Promise(resolve => {
      const check = () => {
        const position = netcode.getEntityState(entityId).position;
        if (Math.hypot(position[0] - start[0], position[2] - start[2]) >= distance) resolve(Date.now());
        else requestAnimationFrame(check);
      };
      check();
    });
  }

  return {
    playerId,
    netcode,
    runtime,
    // Replaces the keyboard with a fixed input (or null to go back to the keyboard); used by tests and demos.
    setInput(input) {
      scriptedInput = input;
      return Date.now();
    },
    position(entityId) {
      return netcode.getEntityState(entityId)?.position ?? null;
    },
    whenEntityMoves,
  };
}
