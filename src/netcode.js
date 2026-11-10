// Multiplayer state sync as a runtime system. One side is the authority (a dedicated server or a host player) and owns the
// truth. It applies every client's inputs, then sends bounded delta snapshots of its entities. A client predicts its own
// entity from its own input, corrects it when the authoritative state arrives (reconciliation) and draws the other entities
// a little in the past, between two snapshots (interpolation). The transport is a plugin: any object with
// { id, peers(), send(peerId, message), receive(callback) }. This file ships an in-memory loopback for tests and a wrapper
// for a socket-like object. Nothing here opens a connection or a timer. See docs/netcode.md.

export const NETCODE_AUTHORITIES = Object.freeze(['server', 'host']);
export const NETCODE_ROLES = Object.freeze(['authority', 'client']);

export const NETCODE_LIMITS = Object.freeze({
  maximumEntities: 256,
  maximumPeers: 32,
  maximumNameLength: 64,
  maximumVariablesPerEntity: 16,
  maximumInputKeys: 16,
  maximumInputsPerMessage: 8,
  maximumQueuedInputsPerPeer: 64,
  maximumPendingInputs: 128,
  maximumSnapshotHistory: 64,
  maximumSamplesPerEntity: 32,
  maximumInputRedundancy: 8,
  maximumInputsPerStep: 8,
  maximumCoordinate: 100000,
  maximumMessageBytes: 1048576,
  defaultMessageBytes: 65536,
});

const DEFAULTS = Object.freeze({
  snapshotEveryTicks: 2,
  inputRedundancy: 3,
  inputBufferSteps: 3,
  interpolationDelaySeconds: 0.1,
  maximumExtrapolationSeconds: 0.25,
  clockCorrectionRate: 0.1,
  positionStep: 0.01,
  rotationStep: 0.001,
  velocityStep: 0.01,
  variableStep: 0.01,
  movementSpeed: 5,
});

const VECTOR_FIELDS = Object.freeze([
  Object.freeze({ wire: 'p', name: 'position', length: 3, stepOption: 'positionStep' }),
  Object.freeze({ wire: 'r', name: 'rotation', length: 4, stepOption: 'rotationStep' }),
  Object.freeze({ wire: 'v', name: 'velocity', length: 3, stepOption: 'velocityStep' }),
]);

const MAXIMUM_WIRE_INTEGER = 1e12;

function describe(value) {
  return value === null ? 'null' : typeof value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireName(value, label) {
  if (typeof value !== 'string' || value === '' || value.length > NETCODE_LIMITS.maximumNameLength) {
    throw new TypeError(`${label} must be a string of 1 to ${NETCODE_LIMITS.maximumNameLength} characters, got ${typeof value === 'string' ? `${value.length} characters` : describe(value)}.`);
  }
  return value;
}

function boundedNumber(value, label, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a number from ${minimum} to ${maximum}, got ${String(value)}.`);
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}, got ${String(value)}.`);
  }
  return value;
}

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function validateTransport(transport, label) {
  if (!isPlainObject(transport)) {
    throw new TypeError(`${label} needs a transport: an object like { id, peers(), send(peerId, message), receive(callback) }, got ${describe(transport)}.`);
  }
  requireName(transport.id, `${label} transport.id`);
  for (const method of ['peers', 'send', 'receive']) {
    if (typeof transport[method] !== 'function') {
      throw new TypeError(`${label} transport.${method} must be a function. A transport is { id, peers(), send(peerId, message), receive(callback) }.`);
    }
  }
}

// ----- State: one entity is a position, a rotation, a velocity and a few named numbers -----

function readVector(value, length, label) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new TypeError(`${label} must be an array of ${length} numbers, got ${Array.isArray(value) ? `${value.length} entries` : describe(value)}.`);
  }
  return value.map((component, index) => boundedNumber(component, `${label}[${index}]`, -NETCODE_LIMITS.maximumCoordinate, NETCODE_LIMITS.maximumCoordinate));
}

function readVariables(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object of named numbers like { score: 3 }, got ${describe(value)}.`);
  const names = Object.keys(value);
  if (names.length > NETCODE_LIMITS.maximumVariablesPerEntity) {
    throw new RangeError(`${label} holds ${names.length} variables; at most ${NETCODE_LIMITS.maximumVariablesPerEntity} are synced per entity.`);
  }
  const variables = {};
  for (const name of names) {
    requireName(name, `${label} variable name`);
    variables[name] = boundedNumber(value[name], `${label}.${name}`, -NETCODE_LIMITS.maximumCoordinate, NETCODE_LIMITS.maximumCoordinate);
  }
  return variables;
}

// Fills the parts a caller left out. `base` supplies them when it is given, so a partial update keeps the rest.
function readState(candidate, label, base = null) {
  if (!isPlainObject(candidate)) throw new TypeError(`${label} must be an object like { position, rotation, velocity, variables }, got ${describe(candidate)}.`);
  const state = {
    position: candidate.position === undefined ? [...(base?.position ?? [0, 0, 0])] : readVector(candidate.position, 3, `${label}.position`),
    rotation: candidate.rotation === undefined ? [...(base?.rotation ?? [0, 0, 0, 1])] : readVector(candidate.rotation, 4, `${label}.rotation`),
    velocity: candidate.velocity === undefined ? [...(base?.velocity ?? [0, 0, 0])] : readVector(candidate.velocity, 3, `${label}.velocity`),
    variables: candidate.variables === undefined ? { ...(base?.variables ?? {}) } : readVariables(candidate.variables, `${label}.variables`),
  };
  return state;
}

function cloneState(state) {
  return {
    position: [...state.position],
    rotation: [...state.rotation],
    velocity: [...state.velocity],
    variables: { ...state.variables },
  };
}

function distanceBetween(first, second) {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

// ----- Inputs: a small object of numbers and booleans, checked on both ends -----

function readInput(candidate, label) {
  if (!isPlainObject(candidate)) throw new TypeError(`${label} must be an object of numbers and booleans like { moveX: 1, jump: true }, got ${describe(candidate)}.`);
  const names = Object.keys(candidate);
  if (names.length > NETCODE_LIMITS.maximumInputKeys) {
    throw new RangeError(`${label} has ${names.length} keys; at most ${NETCODE_LIMITS.maximumInputKeys} are sent per input.`);
  }
  const input = {};
  for (const name of names) {
    requireName(name, `${label} key`);
    const value = candidate[name];
    if (typeof value === 'boolean') {
      input[name] = value;
    } else {
      input[name] = boundedNumber(value, `${label}.${name}`, -NETCODE_LIMITS.maximumCoordinate, NETCODE_LIMITS.maximumCoordinate);
    }
  }
  return input;
}

// The default movement rule: input { moveX, moveZ } from -1 to 1 sets a flat velocity. Pass your own `simulate` for more.
export function createPlanarMovement(options = {}) {
  const speed = boundedNumber(options.speed ?? DEFAULTS.movementSpeed, 'createPlanarMovement speed', 0, 1000);
  return function planarMovement(state, input, stepSeconds) {
    const moveX = Math.max(-1, Math.min(1, Number(input.moveX) || 0));
    const moveZ = Math.max(-1, Math.min(1, Number(input.moveZ) || 0));
    const velocity = [moveX * speed, 0, moveZ * speed];
    const position = [
      state.position[0] + velocity[0] * stepSeconds,
      state.position[1],
      state.position[2] + velocity[2] * stepSeconds,
    ];
    return { ...state, position, velocity };
  };
}

// ----- Quantisation and deltas -----

function quantizeEntity(state, tag, steps) {
  const entity = {};
  if (tag !== null) entity.t = tag;
  for (const field of VECTOR_FIELDS) {
    const step = steps[field.stepOption];
    entity[field.wire] = state[field.name].map(component => Math.round(component / step));
  }
  entity.x = {};
  for (const [name, value] of Object.entries(state.variables)) entity.x[name] = Math.round(value / steps.variableStep);
  return entity;
}

function dequantizeEntity(entity, steps) {
  const state = {};
  for (const field of VECTOR_FIELDS) {
    const step = steps[field.stepOption];
    state[field.name] = entity[field.wire].map(integer => integer * step);
  }
  state.variables = {};
  for (const [name, integer] of Object.entries(entity.x)) state.variables[name] = integer * steps.variableStep;
  return state;
}

function sameNumbers(first, second) {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

// Only the parts of an entity that differ from `base`. Null when nothing differs; the whole entity when there is no base.
function diffEntity(base, current) {
  if (!base) return current;
  const delta = {};
  for (const field of VECTOR_FIELDS) {
    if (!sameNumbers(base[field.wire], current[field.wire])) delta[field.wire] = current[field.wire];
  }
  const changedVariables = {};
  for (const [name, value] of Object.entries(current.x)) {
    if (base.x[name] !== value) changedVariables[name] = value;
  }
  for (const name of Object.keys(base.x)) {
    if (!(name in current.x)) changedVariables[name] = null;
  }
  if (Object.keys(changedVariables).length > 0) delta.x = changedVariables;
  return Object.keys(delta).length > 0 ? delta : null;
}

function applyEntityDelta(base, delta) {
  const entity = { ...(base ?? {}) };
  if (delta.t !== undefined) entity.t = delta.t;
  for (const field of VECTOR_FIELDS) {
    if (delta[field.wire] !== undefined) entity[field.wire] = delta[field.wire];
  }
  const variables = { ...(base?.x ?? {}) };
  for (const [name, value] of Object.entries(delta.x ?? {})) {
    if (value === null) delete variables[name];
    else variables[name] = value;
  }
  entity.x = variables;
  return entity;
}

function readWireIntegers(value, length) {
  if (!Array.isArray(value) || value.length !== length) return null;
  for (const integer of value) {
    if (!Number.isSafeInteger(integer) || Math.abs(integer) > MAXIMUM_WIRE_INTEGER) return null;
  }
  return value;
}

// Network data is untrusted: returns the cleaned delta, or null when anything about it is wrong.
function readWireEntityDelta(raw, isNewEntity) {
  if (!isPlainObject(raw)) return null;
  const delta = {};
  if (raw.t !== undefined) {
    if (typeof raw.t !== 'string' || raw.t.length > NETCODE_LIMITS.maximumNameLength) return null;
    delta.t = raw.t;
  }
  for (const field of VECTOR_FIELDS) {
    if (raw[field.wire] === undefined) {
      if (isNewEntity) return null;
      continue;
    }
    const integers = readWireIntegers(raw[field.wire], field.length);
    if (!integers) return null;
    delta[field.wire] = integers;
  }
  if (raw.x !== undefined) {
    if (!isPlainObject(raw.x) || Object.keys(raw.x).length > NETCODE_LIMITS.maximumVariablesPerEntity) return null;
    delta.x = {};
    for (const [name, value] of Object.entries(raw.x)) {
      if (name.length > NETCODE_LIMITS.maximumNameLength) return null;
      if (value !== null && !(Number.isSafeInteger(value) && Math.abs(value) <= MAXIMUM_WIRE_INTEGER)) return null;
      delta.x[name] = value;
    }
  }
  return delta;
}

// ----- Interpolation -----

function blendVectors(first, second, fraction) {
  return first.map((component, index) => component + (second[index] - component) * fraction);
}

function normalizeQuaternion(quaternion) {
  const length = Math.hypot(...quaternion) || 1;
  return quaternion.map(component => component / length);
}

function blendRotations(first, second, fraction) {
  const sign = first[0] * second[0] + first[1] * second[1] + first[2] * second[2] + first[3] * second[3] < 0 ? -1 : 1;
  const flipped = second.map(component => component * sign);
  return normalizeQuaternion(blendVectors(first, flipped, fraction));
}

// The drawn state at `time`: between the two samples around it, or past the newest one moved on by its velocity for a short while.
function sampleAt(samples, time, maximumExtrapolationSeconds) {
  const first = samples[0];
  if (time <= first.time) return cloneState(first.state);
  const last = samples[samples.length - 1];
  if (time >= last.time) {
    const state = cloneState(last.state);
    const seconds = Math.min(time - last.time, maximumExtrapolationSeconds);
    state.position = state.position.map((component, index) => component + last.state.velocity[index] * seconds);
    return state;
  }
  let upperIndex = samples.length - 1;
  while (samples[upperIndex - 1].time > time) upperIndex -= 1;
  const before = samples[upperIndex - 1];
  const after = samples[upperIndex];
  const fraction = (time - before.time) / (after.time - before.time);
  return {
    position: blendVectors(before.state.position, after.state.position, fraction),
    rotation: blendRotations(before.state.rotation, after.state.rotation, fraction),
    velocity: blendVectors(before.state.velocity, after.state.velocity, fraction),
    variables: { ...before.state.variables },
  };
}

// ----- Options -----

function validateNetcodeOptions(options) {
  if (!isPlainObject(options)) throw new TypeError('createNetcode needs an options object like { role: "client", transport, serverId: "server" }.');
  validateTransport(options.transport, 'createNetcode');
  const role = options.role ?? 'client';
  if (!NETCODE_ROLES.includes(role)) {
    throw new RangeError(`createNetcode role must be one of ${NETCODE_ROLES.join(', ')}, got ${String(role)}.`);
  }
  const authority = options.authority ?? 'server';
  if (authority === 'peer') {
    throw new RangeError(`createNetcode authority "peer" (peer to peer) is not supported yet. Use one of ${NETCODE_AUTHORITIES.join(', ')}.`);
  }
  if (!NETCODE_AUTHORITIES.includes(authority)) {
    throw new RangeError(`createNetcode authority must be one of ${NETCODE_AUTHORITIES.join(', ')}, got ${String(authority)}.`);
  }
  if (role === 'client') requireName(options.serverId, 'createNetcode serverId');
  for (const name of ['simulate', 'readInput']) {
    if (options[name] !== undefined && typeof options[name] !== 'function') {
      throw new TypeError(`createNetcode ${name} must be a function or left out, got ${describe(options[name])}.`);
    }
  }
  if (role === 'client' && options.localEntityId !== undefined) requireName(options.localEntityId, 'createNetcode localEntityId');
  return {
    role,
    authority,
    transport: options.transport,
    serverId: options.serverId,
    localEntityId: options.localEntityId,
    simulate: options.simulate ?? createPlanarMovement(),
    readInput: options.readInput,
    maximumMessageBytes: boundedInteger(options.maximumMessageBytes ?? NETCODE_LIMITS.defaultMessageBytes, 'createNetcode maximumMessageBytes', 256, NETCODE_LIMITS.maximumMessageBytes),
    snapshotEveryTicks: boundedInteger(options.snapshotEveryTicks ?? DEFAULTS.snapshotEveryTicks, 'createNetcode snapshotEveryTicks', 1, 60),
    inputRedundancy: boundedInteger(options.inputRedundancy ?? DEFAULTS.inputRedundancy, 'createNetcode inputRedundancy', 1, NETCODE_LIMITS.maximumInputRedundancy),
    inputBufferSteps: boundedInteger(options.inputBufferSteps ?? DEFAULTS.inputBufferSteps, 'createNetcode inputBufferSteps', 0, 16),
    interpolationDelaySeconds: boundedNumber(options.interpolationDelaySeconds ?? DEFAULTS.interpolationDelaySeconds, 'createNetcode interpolationDelaySeconds', 0, 2),
    maximumExtrapolationSeconds: boundedNumber(options.maximumExtrapolationSeconds ?? DEFAULTS.maximumExtrapolationSeconds, 'createNetcode maximumExtrapolationSeconds', 0, 2),
    steps: {
      positionStep: boundedNumber(options.positionStep ?? DEFAULTS.positionStep, 'createNetcode positionStep', 1e-6, 1),
      rotationStep: boundedNumber(options.rotationStep ?? DEFAULTS.rotationStep, 'createNetcode rotationStep', 1e-6, 1),
      velocityStep: boundedNumber(options.velocityStep ?? DEFAULTS.velocityStep, 'createNetcode velocityStep', 1e-6, 1),
      variableStep: boundedNumber(options.variableStep ?? DEFAULTS.variableStep, 'createNetcode variableStep', 1e-6, 1),
    },
  };
}

// ----- The authority side -----

function createAuthority(settings, stats) {
  const { transport, steps } = settings;
  const entities = new Map(); // id -> { owner, tag, state }
  const peers = new Map(); // peer id -> { queue, lastQueuedSequence, lastProcessedSequence, acknowledgedTick }
  const history = new Map(); // tick -> Map(id -> quantised entity)
  let tick = 0;

  function peerRecord(peerId) {
    let record = peers.get(peerId);
    if (record) return record;
    if (peers.size >= NETCODE_LIMITS.maximumPeers) return null;
    record = { queue: [], lastQueuedSequence: 0, lastProcessedSequence: 0, acknowledgedTick: null };
    peers.set(peerId, record);
    return record;
  }

  function receiveMessage(peerId, message) {
    const record = peerRecord(peerId);
    const inputs = isPlainObject(message) && message.type === 'input' && Array.isArray(message.inputs) ? message.inputs : null;
    if (!record || !inputs || inputs.length > NETCODE_LIMITS.maximumInputsPerMessage) {
      stats.rejectedMessages += 1;
      return;
    }
    if (Number.isInteger(message.acknowledgedTick) && message.acknowledgedTick >= (record.acknowledgedTick ?? -1)) {
      record.acknowledgedTick = message.acknowledgedTick;
    }
    for (const entry of inputs) {
      try {
        const sequence = boundedInteger(entry?.sequence, 'input sequence', 1, Number.MAX_SAFE_INTEGER);
        if (sequence <= record.lastQueuedSequence) continue;
        record.queue.push({ sequence, input: readInput(entry.input, 'input') });
        record.lastQueuedSequence = sequence;
      } catch {
        stats.rejectedMessages += 1;
      }
    }
    while (record.queue.length > NETCODE_LIMITS.maximumQueuedInputsPerPeer) record.queue.shift();
  }

  function entityOwnedBy(peerId) {
    for (const entity of entities.values()) {
      if (entity.owner === peerId) return entity;
    }
    return null;
  }

  function applyInput(entity, input, stepSeconds) {
    entity.state = readState(settings.simulate(cloneState(entity.state), input, stepSeconds), 'simulate result', entity.state);
    stats.inputsProcessed += 1;
  }

  function processInputs(stepSeconds) {
    for (const [peerId, record] of peers) {
      if (record.queue.length === 0) continue;
      const backlog = record.queue.length - settings.inputBufferSteps;
      const count = Math.min(Math.max(1, backlog), NETCODE_LIMITS.maximumInputsPerStep, record.queue.length);
      const entity = entityOwnedBy(peerId);
      for (let index = 0; index < count; index += 1) {
        const { sequence, input } = record.queue.shift();
        if (entity) applyInput(entity, input, stepSeconds);
        record.lastProcessedSequence = sequence;
      }
    }
    if (settings.readInput) {
      const hostEntity = entityOwnedBy(transport.id);
      if (hostEntity) applyInput(hostEntity, readInput(settings.readInput(), 'readInput result'), stepSeconds);
    }
  }

  function dropDisconnectedPeers(currentPeers) {
    for (const peerId of peers.keys()) {
      if (!currentPeers.includes(peerId)) peers.delete(peerId);
    }
  }

  function buildSnapshot() {
    const snapshot = new Map();
    for (const [id, entity] of entities) snapshot.set(id, quantizeEntity(entity.state, entity.tag, steps));
    history.set(tick, snapshot);
    while (history.size > NETCODE_LIMITS.maximumSnapshotHistory) history.delete(history.keys().next().value);
    return snapshot;
  }

  function buildMessage(snapshot, record) {
    const base = record.acknowledgedTick !== null && history.has(record.acknowledgedTick) ? record.acknowledgedTick : null;
    const baseEntities = base === null ? null : history.get(base);
    const changed = {};
    for (const [id, entity] of snapshot) {
      const delta = diffEntity(baseEntities?.get(id) ?? null, entity);
      if (delta) changed[id] = delta;
    }
    const removed = baseEntities ? [...baseEntities.keys()].filter(id => !snapshot.has(id)) : [];
    return {
      type: 'snapshot',
      tick,
      base,
      lastProcessedInput: record.lastProcessedSequence,
      entities: changed,
      removed,
    };
  }

  function sendSnapshots() {
    const currentPeers = transport.peers();
    dropDisconnectedPeers(currentPeers);
    const snapshot = buildSnapshot();
    for (const peerId of currentPeers.slice(0, NETCODE_LIMITS.maximumPeers)) {
      const record = peerRecord(peerId);
      if (!record) continue;
      const message = buildMessage(snapshot, record);
      const bytes = JSON.stringify(message).length;
      if (bytes > settings.maximumMessageBytes) {
        throw new RangeError(`A netcode snapshot is ${bytes} bytes, over maximumMessageBytes ${settings.maximumMessageBytes}. Sync fewer entities or variables, or raise maximumMessageBytes (up to ${NETCODE_LIMITS.maximumMessageBytes}).`);
      }
      transport.send(peerId, message);
      stats.snapshotsSent += 1;
      stats.bytesSent += bytes;
      if (message.base === null) stats.fullSnapshotsSent += 1;
    }
  }

  return {
    receiveMessage,
    fixedUpdate(stepSeconds) {
      processInputs(stepSeconds);
      tick += 1;
      if (tick % settings.snapshotEveryTicks === 0) sendSnapshots();
    },
    addEntity(id, definition = {}) {
      requireName(id, 'addEntity id');
      if (entities.has(id)) throw new RangeError(`addEntity: an entity named "${id}" already exists. Use setEntityState to change it.`);
      if (entities.size >= NETCODE_LIMITS.maximumEntities) {
        throw new RangeError(`A netcode world syncs at most ${NETCODE_LIMITS.maximumEntities} entities. Remove some, or sync only what players see.`);
      }
      const owner = definition.owner === undefined ? null : requireName(definition.owner, 'addEntity owner');
      const tag = definition.tag === undefined ? null : requireName(definition.tag, 'addEntity tag');
      if (owner !== null && entityOwnedBy(owner)) {
        throw new RangeError(`addEntity: "${owner}" already owns an entity. A peer drives one entity.`);
      }
      entities.set(id, { owner, tag, state: readState(definition.state ?? {}, `addEntity "${id}" state`) });
    },
    removeEntity(id) {
      if (!entities.delete(id)) throw new RangeError(`removeEntity: no entity named "${String(id)}". Present: ${[...entities.keys()].join(', ') || 'none'}.`);
    },
    setEntityState(id, partialState) {
      const entity = entities.get(id);
      if (!entity) throw new RangeError(`setEntityState: no entity named "${String(id)}". Present: ${[...entities.keys()].join(', ') || 'none'}. Use addEntity first.`);
      entity.state = readState(partialState, `setEntityState "${id}" state`, entity.state);
    },
    getEntityState(id) {
      const entity = entities.get(id);
      return entity ? cloneState(entity.state) : null;
    },
    entityIds: () => [...entities.keys()],
    get tick() { return tick; },
  };
}

// ----- The client side -----

function createClient(settings, stats) {
  const { transport, steps } = settings;
  const localEntityId = settings.localEntityId ?? null;
  const receivedStates = new Map(); // tick -> Map(id -> quantised entity)
  const samples = new Map(); // id -> [{ time, state }]
  const pendingInputs = []; // { sequence, input }, not yet confirmed by a snapshot
  let stepSeconds = null;
  let latestTick = -1;
  let inputSequence = 0;
  let predicted = null;
  let renderTime = null;

  function reconcile(authoritativeState, lastProcessedInput) {
    while (pendingInputs.length > 0 && pendingInputs[0].sequence <= lastProcessedInput) pendingInputs.shift();
    const before = predicted;
    let corrected = authoritativeState;
    for (const { input } of pendingInputs) {
      corrected = readState(settings.simulate(cloneState(corrected), input, stepSeconds), 'simulate result', corrected);
    }
    predicted = corrected;
    stats.reconciliations += 1;
    if (before) {
      stats.lastCorrection = distanceBetween(before.position, predicted.position);
      stats.maximumCorrection = Math.max(stats.maximumCorrection, stats.lastCorrection);
    }
  }

  function readSnapshot(message) {
    if (!isPlainObject(message) || message.type !== 'snapshot' || !Number.isSafeInteger(message.tick) || message.tick < 0) return null;
    if (message.base !== null && !Number.isSafeInteger(message.base)) return null;
    if (!isPlainObject(message.entities) || Object.keys(message.entities).length > NETCODE_LIMITS.maximumEntities) return null;
    if (!Array.isArray(message.removed) || message.removed.length > NETCODE_LIMITS.maximumEntities) return null;
    if (!Number.isSafeInteger(message.lastProcessedInput) || message.lastProcessedInput < 0) return null;
    return message;
  }

  function receiveMessage(peerId, rawMessage) {
    if (peerId !== settings.serverId) return;
    const message = readSnapshot(rawMessage);
    if (!message) {
      stats.rejectedMessages += 1;
      return;
    }
    if (message.tick <= latestTick) {
      stats.staleSnapshots += 1;
      return;
    }
    const baseEntities = message.base === null ? new Map() : receivedStates.get(message.base);
    if (!baseEntities) {
      stats.missingBaseSnapshots += 1;
      return;
    }
    const full = new Map(baseEntities);
    for (const id of message.removed) full.delete(id);
    for (const [id, rawDelta] of Object.entries(message.entities)) {
      const delta = readWireEntityDelta(rawDelta, !full.has(id));
      if (!delta) {
        stats.rejectedMessages += 1;
        return;
      }
      full.set(id, applyEntityDelta(full.get(id) ?? null, delta));
    }
    if (full.size > NETCODE_LIMITS.maximumEntities) {
      stats.rejectedMessages += 1;
      return;
    }
    acceptSnapshot(message, full);
  }

  function acceptSnapshot(message, full) {
    latestTick = message.tick;
    stats.snapshotsReceived += 1;
    receivedStates.set(message.tick, full);
    while (receivedStates.size > NETCODE_LIMITS.maximumSnapshotHistory) receivedStates.delete(receivedStates.keys().next().value);
    const time = message.tick * stepSeconds;
    for (const id of samples.keys()) {
      if (!full.has(id)) samples.delete(id);
    }
    for (const [id, entity] of full) {
      const list = samples.get(id) ?? [];
      list.push({ time, state: dequantizeEntity(entity, steps) });
      while (list.length > NETCODE_LIMITS.maximumSamplesPerEntity) list.shift();
      samples.set(id, list);
    }
    if (renderTime === null) renderTime = time - settings.interpolationDelaySeconds;
    if (localEntityId !== null && full.has(localEntityId)) {
      reconcile(dequantizeEntity(full.get(localEntityId), steps), message.lastProcessedInput);
    }
  }

  function sendInput(context) {
    inputSequence += 1;
    const input = settings.readInput ? readInput(settings.readInput(context), 'readInput result') : {};
    if (settings.readInput) {
      pendingInputs.push({ sequence: inputSequence, input });
      while (pendingInputs.length > NETCODE_LIMITS.maximumPendingInputs) pendingInputs.shift();
      if (predicted) predicted = readState(settings.simulate(cloneState(predicted), input, stepSeconds), 'simulate result', predicted);
    }
    transport.send(settings.serverId, {
      type: 'input',
      acknowledgedTick: latestTick >= 0 ? latestTick : null,
      inputs: pendingInputs.slice(-settings.inputRedundancy).map(({ sequence, input: pending }) => ({ sequence, input: pending })),
    });
  }

  // Moves the drawing clock on with real time, nudged by at most a tenth toward "newest snapshot minus the delay".
  function advanceRenderTime(deltaSeconds) {
    if (renderTime === null) return;
    const target = latestTick * stepSeconds - settings.interpolationDelaySeconds;
    const error = target - renderTime;
    if (Math.abs(error) > 1) {
      renderTime = target;
      return;
    }
    const limit = deltaSeconds * DEFAULTS.clockCorrectionRate;
    renderTime += deltaSeconds + Math.max(-limit, Math.min(limit, error));
  }

  return {
    receiveMessage,
    setStep(seconds) { stepSeconds = seconds; },
    fixedUpdate(step, context) {
      stepSeconds = step;
      sendInput(context);
    },
    update(deltaSeconds) {
      advanceRenderTime(deltaSeconds);
    },
    getEntityState(id) {
      if (id === localEntityId && predicted) return cloneState(predicted);
      const list = samples.get(id);
      if (!list || renderTime === null) return null;
      return sampleAt(list, renderTime, settings.maximumExtrapolationSeconds);
    },
    entityIds: () => [...samples.keys()],
    get latestTick() { return latestTick; },
    get pendingInputCount() { return pendingInputs.length; },
  };
}

// ----- createNetcode: the runtime system -----

export function createNetcode(options) {
  const settings = validateNetcodeOptions(options);
  const stats = {
    snapshotsSent: 0,
    fullSnapshotsSent: 0,
    bytesSent: 0,
    inputsProcessed: 0,
    snapshotsReceived: 0,
    staleSnapshots: 0,
    missingBaseSnapshots: 0,
    reconciliations: 0,
    lastCorrection: 0,
    maximumCorrection: 0,
    rejectedMessages: 0,
  };
  const side = settings.role === 'authority' ? createAuthority(settings, stats) : createClient(settings, stats);
  let unsubscribe = null;

  function requireAuthority(action) {
    if (settings.role !== 'authority') throw new TypeError(`${action} is only for the authority. This netcode is a client; the authority owns the entities.`);
  }

  const netcode = {
    name: 'netcode',
    get role() { return settings.role; },
    get authority() { return settings.authority; },
    get stats() { return { ...stats }; },
    get tick() { return settings.role === 'authority' ? side.tick : side.latestTick; },
    get pendingInputCount() { return side.pendingInputCount ?? 0; },

    init(context) {
      side.setStep?.(context.fixedStepSeconds);
      unsubscribe = settings.transport.receive((peerId, message) => side.receiveMessage(peerId, message));
    },
    fixedUpdate(step, context) {
      side.fixedUpdate(step, context);
    },
    update(deltaSeconds) {
      side.update?.(deltaSeconds);
    },
    dispose() {
      if (typeof unsubscribe === 'function') unsubscribe();
      unsubscribe = null;
    },

    // Authority: add an entity peers can see. `owner` is the peer id whose inputs drive it; `tag` names its kind.
    addEntity(id, definition) {
      requireAuthority('addEntity');
      side.addEntity(id, definition);
      return netcode;
    },
    removeEntity(id) {
      requireAuthority('removeEntity');
      side.removeEntity(id);
      return netcode;
    },
    // Authority: write a state the game computed itself (a physics prop, a teleport). Parts left out keep their value.
    setEntityState(id, partialState) {
      requireAuthority('setEntityState');
      side.setEntityState(id, partialState);
      return netcode;
    },
    // The state to draw: the truth on the authority, the prediction for the local entity, the interpolation for the rest.
    getEntityState(id) {
      return side.getEntityState(id);
    },
    get entityIds() { return side.entityIds(); },
  };
  return netcode;
}

// ----- Transports -----

// An in-memory network for tests and local play. Time moves only when advance() is called, and latency, jitter and loss
// come from a seeded generator, so the same seed gives the same run. Messages are copied through JSON like a real wire.
export function createLoopbackNetwork(options = {}) {
  const seed = boundedInteger(options.seed ?? 1, 'createLoopbackNetwork seed', 0, 4294967295);
  const latencyMilliseconds = boundedNumber(options.latencyMilliseconds ?? 0, 'createLoopbackNetwork latencyMilliseconds', 0, 60000);
  const jitterMilliseconds = boundedNumber(options.jitterMilliseconds ?? 0, 'createLoopbackNetwork jitterMilliseconds', 0, 60000);
  const lossRate = boundedNumber(options.lossRate ?? 0, 'createLoopbackNetwork lossRate', 0, 1);
  const maximumMessageBytes = boundedInteger(options.maximumMessageBytes ?? NETCODE_LIMITS.maximumMessageBytes, 'createLoopbackNetwork maximumMessageBytes', 256, NETCODE_LIMITS.maximumMessageBytes);
  const maximumInFlight = boundedInteger(options.maximumInFlight ?? 4096, 'createLoopbackNetwork maximumInFlight', 1, 65536);
  const random = createSeededRandom(seed);
  const endpoints = new Map(); // id -> { listeners }
  const inFlight = [];
  const stats = { sent: 0, delivered: 0, dropped: 0 };
  let nowMilliseconds = 0;
  let sequence = 0;

  function send(fromId, toId, message) {
    if (!endpoints.has(toId)) throw new RangeError(`Loopback send: no transport named "${String(toId)}". Connected: ${[...endpoints.keys()].join(', ')}.`);
    const text = JSON.stringify(message);
    if (text === undefined || text.length > maximumMessageBytes) {
      throw new RangeError(`Loopback send: a message must be JSON of at most ${maximumMessageBytes} characters, got ${text === undefined ? 'a value JSON cannot hold' : text.length}.`);
    }
    stats.sent += 1;
    const lossDraw = random();
    const jitterDraw = random();
    if (lossDraw < lossRate || inFlight.length >= maximumInFlight) {
      stats.dropped += 1;
      return;
    }
    const delay = Math.max(0, latencyMilliseconds + (jitterDraw * 2 - 1) * jitterMilliseconds);
    sequence += 1;
    inFlight.push({ deliverAt: nowMilliseconds + delay, sequence, fromId, toId, text });
  }

  function deliverDue() {
    inFlight.sort((first, second) => first.deliverAt - second.deliverAt || first.sequence - second.sequence);
    while (inFlight.length > 0 && inFlight[0].deliverAt <= nowMilliseconds) {
      const packet = inFlight.shift();
      const endpoint = endpoints.get(packet.toId);
      if (!endpoint) continue;
      stats.delivered += 1;
      for (const listener of [...endpoint.listeners]) listener(packet.fromId, JSON.parse(packet.text));
    }
  }

  return {
    createTransport(id) {
      requireName(id, 'createTransport id');
      if (endpoints.has(id)) throw new RangeError(`createTransport: a transport named "${id}" is already connected.`);
      const endpoint = { listeners: new Set() };
      endpoints.set(id, endpoint);
      return {
        id,
        peers: () => [...endpoints.keys()].filter(other => other !== id),
        send: (peerId, message) => send(id, peerId, message),
        receive(callback) {
          if (typeof callback !== 'function') throw new TypeError('transport.receive needs a callback (peerId, message) => void.');
          endpoint.listeners.add(callback);
          return () => endpoint.listeners.delete(callback);
        },
        close() {
          endpoints.delete(id);
        },
      };
    },
    // Moves network time forward and delivers every message that is due.
    advance(milliseconds) {
      boundedNumber(milliseconds, 'advance milliseconds', 0, 60000);
      nowMilliseconds += milliseconds;
      deliverDue();
    },
    get stats() { return { ...stats, inFlight: inFlight.length }; },
    get nowMilliseconds() { return nowMilliseconds; },
  };
}

// Wraps a BroadcastChannel-like object ({ postMessage, addEventListener, close }) so tabs, windows and workers of one
// browser can play together with no server. Every peer hears the channel; a message names its sender and, when sent to one
// peer, its target. Peers find each other by a hello that the other side answers once, and leave with a goodbye on close().
export function createBroadcastChannelTransport(channel, options = {}) {
  if (channel === null || typeof channel !== 'object' || typeof channel.postMessage !== 'function' || typeof channel.addEventListener !== 'function') {
    throw new TypeError('createBroadcastChannelTransport needs a BroadcastChannel-like object with postMessage(value) and addEventListener(type, listener), such as new BroadcastChannel("my-game").');
  }
  const id = requireName(options.id, 'createBroadcastChannelTransport id');
  const maximumMessageBytes = boundedInteger(options.maximumMessageBytes ?? NETCODE_LIMITS.defaultMessageBytes, 'createBroadcastChannelTransport maximumMessageBytes', 256, NETCODE_LIMITS.maximumMessageBytes);
  const listeners = new Set();
  const knownPeers = new Set();
  const stats = { sent: 0, received: 0, rejected: 0 };

  function learnPeer(peerId) {
    if (knownPeers.has(peerId)) return true;
    if (knownPeers.size >= NETCODE_LIMITS.maximumPeers) return false;
    knownPeers.add(peerId);
    return true;
  }

  function onMessage(event) {
    const packet = event?.data;
    if (!isPlainObject(packet) || typeof packet.from !== 'string' || packet.from === '' || packet.from.length > NETCODE_LIMITS.maximumNameLength) {
      stats.rejected += 1;
      return;
    }
    const peerId = packet.from;
    const isForMe = packet.to === undefined || packet.to === id;
    if (peerId === id || !isForMe) return;
    if (packet.left === true) {
      knownPeers.delete(peerId);
      return;
    }
    const isNew = !knownPeers.has(peerId);
    if (!learnPeer(peerId)) {
      stats.rejected += 1;
      return;
    }
    if (packet.hello === true) {
      if (isNew && packet.to === undefined) channel.postMessage({ from: id, to: peerId, hello: true });
      return;
    }
    stats.received += 1;
    for (const listener of [...listeners]) listener(peerId, packet.data);
  }

  channel.addEventListener('message', onMessage);
  channel.postMessage({ from: id, hello: true });

  return {
    id,
    peers: () => [...knownPeers],
    send(peerId, message) {
      const text = JSON.stringify(message);
      if (text === undefined || text.length > maximumMessageBytes) {
        throw new RangeError(`BroadcastChannel transport send: a message must be JSON of at most ${maximumMessageBytes} characters, got ${text === undefined ? 'a value JSON cannot hold' : text.length}.`);
      }
      channel.postMessage({ from: id, to: peerId, data: JSON.parse(text) });
      stats.sent += 1;
    },
    receive(callback) {
      if (typeof callback !== 'function') throw new TypeError('transport.receive needs a callback (peerId, message) => void.');
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    close() {
      channel.postMessage({ from: id, left: true });
      channel.removeEventListener?.('message', onMessage);
      listeners.clear();
      knownPeers.clear();
      channel.close?.();
    },
    get stats() { return { ...stats }; },
  };
}

// Wraps a socket-like object ({ send(text), addEventListener, readyState, close }) and opens nothing itself.
// By default the socket is a line to one peer (`remoteId`). With `multiplexed: true` it talks through a relay that
// wraps each message as { to, data } going out and { from, data } coming in, so a server or host can hear many clients.
export function createWebSocketTransport(socket, options = {}) {
  if (socket === null || typeof socket !== 'object' || typeof socket.send !== 'function' || typeof socket.addEventListener !== 'function') {
    throw new TypeError('createWebSocketTransport needs a socket-like object with send(text) and addEventListener(type, listener), such as a WebSocket you opened.');
  }
  const id = requireName(options.id ?? 'local', 'createWebSocketTransport id');
  const remoteId = requireName(options.remoteId ?? 'server', 'createWebSocketTransport remoteId');
  const multiplexed = options.multiplexed === true;
  const maximumMessageBytes = boundedInteger(options.maximumMessageBytes ?? NETCODE_LIMITS.defaultMessageBytes, 'createWebSocketTransport maximumMessageBytes', 256, NETCODE_LIMITS.maximumMessageBytes);
  const openState = 1;
  const listeners = new Set();
  const relayPeers = new Set();
  const stats = { sent: 0, received: 0, rejected: 0 };

  function readPacket(text) {
    if (typeof text !== 'string' || text.length > maximumMessageBytes) return null;
    try {
      const parsed = JSON.parse(text);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function onMessage(event) {
    const packet = readPacket(event?.data);
    if (!packet) {
      stats.rejected += 1;
      return;
    }
    let peerId = remoteId;
    let message = packet;
    if (multiplexed) {
      if (typeof packet.from !== 'string' || packet.from === '' || packet.from.length > NETCODE_LIMITS.maximumNameLength) {
        stats.rejected += 1;
        return;
      }
      peerId = packet.from;
      if (packet.left === true) {
        relayPeers.delete(peerId);
        return;
      }
      if (relayPeers.size >= NETCODE_LIMITS.maximumPeers && !relayPeers.has(peerId)) {
        stats.rejected += 1;
        return;
      }
      relayPeers.add(peerId);
      message = packet.data;
    }
    stats.received += 1;
    for (const listener of [...listeners]) listener(peerId, message);
  }

  socket.addEventListener('message', onMessage);

  return {
    id,
    peers: () => multiplexed ? [...relayPeers] : socket.readyState === openState ? [remoteId] : [],
    send(peerId, message) {
      if (socket.readyState !== openState) return;
      const text = JSON.stringify(multiplexed ? { to: peerId, data: message } : message);
      if (text === undefined || text.length > maximumMessageBytes) {
        throw new RangeError(`WebSocket transport send: a message must be JSON of at most ${maximumMessageBytes} characters, got ${text === undefined ? 'a value JSON cannot hold' : text.length}.`);
      }
      socket.send(text);
      stats.sent += 1;
    },
    receive(callback) {
      if (typeof callback !== 'function') throw new TypeError('transport.receive needs a callback (peerId, message) => void.');
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    close() {
      socket.removeEventListener?.('message', onMessage);
      listeners.clear();
      socket.close?.();
    },
    get stats() { return { ...stats }; },
  };
}
