# Netcode: multiplayer state sync

`67js/addons/netcode` is a [runtime](runtime.md) system for multiplayer. One side is the authority and owns the truth. It applies every client's input and sends bounded delta snapshots. A client predicts its own entity, corrects it when a snapshot arrives and draws the other entities slightly in the past, between two snapshots. It loads only when imported, adds no dependency and opens no connection or timer.

```js
import { createRuntime } from '67js/addons/runtime';
import { createNetcode, createWebSocketTransport } from '67js/addons/netcode';

// Server (or host): owns the truth.
const server = createNetcode({ role: 'authority', authority: 'server', transport: serverTransport });
server.addEntity('alice', { owner: 'alice', tag: 'player' });
server.addEntity('crate', { tag: 'prop', state: { position: [3, 1, 3], variables: { health: 10 } } });

// Client: predicts 'alice', interpolates the rest.
const client = createNetcode({
  role: 'client',
  serverId: 'server',
  localEntityId: 'alice',
  transport: createWebSocketTransport(socket, { id: 'alice', remoteId: 'server' }),
  readInput: () => ({ moveX: keys.right - keys.left, moveZ: keys.down - keys.up }),
});
createRuntime(renderer, { fixedRate: 50, systems: [client] }).start();
// each frame: client.getEntityState('crate') -> { position, rotation, velocity, variables }
```

## Authority

`authority: 'server'` is a dedicated authority with no player. `authority: 'host'` is a player who also runs the world: give it `readInput` and an entity it owns (`owner` is its own transport id) and it plays with no prediction. `'peer'` (peer to peer) is reserved and throws until it exists.

The authority methods are `addEntity(id, { owner, tag, state })`, `removeEntity(id)` and `setEntityState(id, partialState)`. `owner` is the transport peer id whose input drives the entity (one entity per peer). An entity without an owner is driven by game code: a physics prop, a door, a score. Write its state with `setEntityState` each step. Parts left out keep their value.

An entity state is `{ position: [x, y, z], rotation: [x, y, z, w], velocity: [x, y, z], variables: { name: number } }`. Parts you leave out start at zero, identity rotation and no variables.

## Simulation and input

Client and authority run the same pure function `simulate(state, input, stepSeconds) -> state` for each input, so the client can predict. The default is `createPlanarMovement({ speed: 5 })`: input `{ moveX, moveZ }` from -1 to 1 sets a flat velocity. Pass your own `simulate` for jumping, collisions or anything else, and keep it deterministic. An input is an object of at most 16 numbers and booleans.

Each fixed step the client samples `readInput`, applies it to its predicted entity at once and sends it with a sequence number, the last `inputRedundancy` unconfirmed inputs together so one lost packet costs nothing. The authority applies each sequence once, in order. It holds a small jitter buffer (`inputBufferSteps`) so remote movement stays even, and catches up when a backlog builds.

## Snapshots

Every `snapshotEveryTicks` fixed steps (default 2) the authority builds one snapshot of all entities, quantised to integers (`positionStep` 0.01, `rotationStep` 0.001, `velocityStep` 0.01, `variableStep` 0.01) and sends each peer a delta against the last snapshot that peer acknowledged. A peer that has acknowledged nothing, or whose base is too old, gets a full snapshot. A lost snapshot is repaired by the next one, since the delta base only moves forward on acknowledgement. Stale and out-of-order snapshots are dropped.

## Prediction, reconciliation and interpolation

When a snapshot arrives the client takes the authoritative state of its entity, drops the inputs the authority has already applied (`lastProcessedInput`) and replays the rest through `simulate`. If the prediction was right the result does not move; if not, the entity is corrected in one step (`stats.lastCorrection`, `stats.maximumCorrection`). Smooth a big correction in your drawing code if the look needs it.

Other entities are drawn `interpolationDelaySeconds` (default 0.1) behind the newest snapshot, blended between the two samples around that time. Past the newest sample the entity carries on at its velocity for at most `maximumExtrapolationSeconds` (0.25). The drawing clock follows real time and is nudged by at most 10 percent toward the target, so a late packet slows the clock instead of jumping the entity. Raise the delay on a jittery connection.

`getEntityState(id)` returns the state to draw: the truth on the authority, the prediction for `localEntityId`, the interpolation for the rest.

## Transports

A transport is a plain object `{ id, peers(), send(peerId, message), receive(callback) }`. `peers()` returns the connected peer ids, `send` takes a JSON-compatible object and must not throw for a transient failure, and `receive(callback)` registers `callback(peerId, message)` and returns a function that unregisters it. Write your own for WebRTC or WebTransport.

- `createLoopbackNetwork({ seed, latencyMilliseconds, jitterMilliseconds, lossRate })` is an in-memory network for tests. `network.createTransport(id)` adds a peer; `network.advance(milliseconds)` moves time and delivers what is due. Latency, jitter and loss come from the seeded generator, so a seed repeats a run exactly. Messages are copied through JSON and may arrive out of order.
- `createBroadcastChannelTransport(channel, { id })` wraps a `BroadcastChannel` so tabs, windows and workers of one browser play together with no server. Peers find each other with a hello the other side answers once, and a message to one peer reaches only that peer.
- `createWebSocketTransport(socket, { id, remoteId, multiplexed, maximumMessageBytes })` wraps a socket-like object you opened (`send(text)`, `addEventListener`, `readyState`, `close()`). By default it is a line to one peer, `remoteId`. With `multiplexed: true` it speaks to a relay that wraps messages as `{ to, data }` going out and `{ from, data }` coming in (and `{ from, left: true }` when a peer leaves), so a server or host can hear many clients.

## Options and bounds

| Option | Default | Meaning |
| --- | --- | --- |
| `role` | `'client'` | `'authority'` or `'client'` |
| `authority` | `'server'` | `'server'` or `'host'` |
| `transport` | required | The transport above |
| `serverId` | required for a client | Peer id of the authority |
| `localEntityId` | none | The entity a client predicts |
| `simulate`, `readInput` | planar movement, none | See above |
| `snapshotEveryTicks` | 2 | 1 to 60 |
| `inputRedundancy`, `inputBufferSteps` | 3, 3 | Inputs resent per message (1 to 8), authority jitter buffer (0 to 16) |
| `interpolationDelaySeconds`, `maximumExtrapolationSeconds` | 0.1, 0.25 | 0 to 2 |
| `maximumMessageBytes` | 65536 | A snapshot over this throws; up to 1 MB |

`NETCODE_LIMITS` holds the hard bounds: 256 entities, 32 peers, 16 variables per entity, names up to 64 characters, 8 inputs per message, 64 queued inputs per peer, 64 snapshots of history. Network input is untrusted: a bad message is counted in `stats.rejectedMessages` and ignored, never thrown. Option and call errors say what to pass.

`stats` reports `snapshotsSent`, `fullSnapshotsSent`, `bytesSent`, `inputsProcessed`, `snapshotsReceived`, `staleSnapshots`, `missingBaseSnapshots`, `reconciliations`, `lastCorrection`, `maximumCorrection` and `rejectedMessages`.

## Sample game and relay

`scripts/netcode-sample.html` is a two-player sample: one page is the host (`?role=host`, plays `alice`, owns the truth) and the other is a client (`?role=client`, plays `bob` with prediction and reconciliation). Move with the arrow keys or WASD. `?transport=broadcast` (default) uses two tabs of one browser; `?transport=websocket&relay=ws://127.0.0.1:8787/` uses the relay. `?delay=50` adds that many milliseconds to everything a page sends. Serve the repository root (for example with `npx vite`) and open both URLs.

`node scripts/netcode-relay.mjs --port 8787 [--host 0.0.0.0] [--latency 50]` is a reference relay of about 80 lines. Players connect to `/?id=<name>`; it forwards `{ to, data }` as `{ from, data }`, announces `{ from, left: true }`, refuses a repeated name and keeps no game state, so it runs on any free Node host. It needs the `ws` package, a dev dependency of this repository only; the library itself gains no dependency.

`tests/netcode-two-browsers.test.js` opens the host and client in two headless Chrome pages over each transport with 50 ms injected per direction. It asserts that both pages end within 0.05 units of each other and that a move shows on the other page in under 450 ms. Measured on a loaded machine: a host move shows on the client after about 200 to 230 ms and a client move shows on the host after about 130 to 150 ms, the same over both transports. The client's own player never waits, since it is predicted, and the largest correction was 0. The host-to-client figure holds the 50 ms line, up to one snapshot interval (40 ms) and the 100 ms interpolation delay.

## Not yet

WebRTC and WebTransport transports, peer-to-peer authority and a physics-prop sample come in later slices of #778. Use the same `fixedRate` on the authority and every client.
