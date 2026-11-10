// A reference WebSocket relay for 67js/addons/netcode. Players connect to ws://host:port/?id=<peerId>; the relay forwards
// { to, data } from one player to { from, data } on another and tells the rest { from, left: true } when a player leaves.
// It keeps no game state, so the authority (a host player or a server process) stays one of the connected peers.
//
//   node scripts/netcode-relay.mjs --port 8787 [--host 0.0.0.0] [--latency 50]
//
// Needs the `ws` package. `latency` delays every forwarded message, to test how a game feels on a slow line.
import { WebSocketServer } from 'ws';
import { pathToFileURL } from 'node:url';

const MAXIMUM_PEERS = 32;
const MAXIMUM_NAME_LENGTH = 64;
const MAXIMUM_MESSAGE_BYTES = 65536 + 256;
const POLICY_VIOLATION = 1008;

export async function startNetcodeRelay(options = {}) {
  const port = options.port ?? 8787;
  const host = options.host ?? '127.0.0.1';
  const latencyMilliseconds = options.latencyMilliseconds ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`startNetcodeRelay port must be an integer from 0 to 65535, got ${port}.`);
  if (typeof latencyMilliseconds !== 'number' || !(latencyMilliseconds >= 0 && latencyMilliseconds <= 5000)) {
    throw new RangeError(`startNetcodeRelay latencyMilliseconds must be a number from 0 to 5000, got ${latencyMilliseconds}.`);
  }
  const clients = new Map(); // peer id -> socket
  const server = new WebSocketServer({ port, host, maxPayload: MAXIMUM_MESSAGE_BYTES });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  function deliver(socket, text) {
    const send = () => {
      if (socket.readyState === socket.OPEN) socket.send(text);
    };
    if (latencyMilliseconds === 0) send();
    else setTimeout(send, latencyMilliseconds);
  }

  server.on('error', () => {});

  server.on('connection', (socket, request) => {
    socket.on('error', () => socket.terminate());
    const peerId = new URL(request.url ?? '/', 'http://relay').searchParams.get('id');
    const validId = typeof peerId === 'string' && peerId !== '' && peerId.length <= MAXIMUM_NAME_LENGTH;
    if (!validId || clients.has(peerId) || clients.size >= MAXIMUM_PEERS) {
      socket.close(POLICY_VIOLATION, 'Connect to /?id=<name> with a unique name of 1 to 64 characters, at most 32 players.');
      return;
    }
    clients.set(peerId, socket);
    socket.on('message', raw => {
      let packet;
      try {
        packet = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const target = clients.get(packet?.to);
      if (!target || target === socket || packet.data === undefined) return;
      deliver(target, JSON.stringify({ from: peerId, data: packet.data }));
    });
    socket.on('close', () => {
      if (clients.get(peerId) !== socket) return;
      clients.delete(peerId);
      for (const other of clients.values()) deliver(other, JSON.stringify({ from: peerId, left: true }));
    });
  });

  return {
    get port() { return server.address().port; },
    get peerIds() { return [...clients.keys()]; },
    close() {
      for (const socket of clients.values()) socket.terminate();
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

function readFlag(argumentsList, name, fallback) {
  const index = argumentsList.indexOf(`--${name}`);
  return index === -1 ? fallback : argumentsList[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argumentsList = process.argv.slice(2);
  const relay = await startNetcodeRelay({
    port: Number(readFlag(argumentsList, 'port', 8787)),
    host: readFlag(argumentsList, 'host', '127.0.0.1'),
    latencyMilliseconds: Number(readFlag(argumentsList, 'latency', 0)),
  });
  console.log(`netcode relay on ws://${readFlag(argumentsList, 'host', '127.0.0.1')}:${relay.port}/?id=<name>`);
}
