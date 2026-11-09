import { invalidField } from './field-error.js';

// Shape checks for the `drive` entry of an asset recipe's motion and of a placed asset. Pure validation with no vehicle
// code, so the recipe normalizers and the MCP server can use it without loading the drive (agent-drive.js).

export const DRIVE_LIMITS = Object.freeze({ maxPathPoints: 512, maxLegs: 32, maxWheels: 8, maxNodeReferences: 64, maxLights: 16 });

const DRIVE_FIELDS = [
  'path', 'legs', 'speed', 'cruiseSpeed', 'acceleration', 'braking', 'startSpeed', 'endSpeed', 'maxLateralAcceleration',
  'startTime', 'steering', 'maxSteerAngle', 'fullBrakeDeceleration', 'rollGain', 'pitchGain',
  'wheels', 'body', 'forwardAxis', 'wheelbase', 'lights',
];
const NUMBER_OPTIONS = DRIVE_FIELDS.slice(2, 9).concat(['startTime', 'maxSteerAngle', 'fullBrakeDeceleration', 'rollGain', 'pitchGain', 'wheelbase']);
const WHEEL_FIELDS = ['id', 'node', 'nodes', 'side', 'axle', 'radius', 'center', 'steerable', 'spinSign'];
const LIGHT_FIELDS = ['headlights', 'tailLights'];
const HEADLIGHT_FIELDS = ['id', 'position', 'direction'];
const TAIL_LIGHT_FIELDS = ['id', 'material', 'signal', 'off', 'on'];
const CAMERA_PATH_FIELDS = ['duration', 'loop', 'eye'];

function knownKeys(value, allowed, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidField(path, value, 'an object, such as {}', TypeError);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalidField(`${path}.${key}`, value[key], `no such field; use one of ${allowed.join(', ')}`, TypeError);
  }
}

function vector(value, path) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(component => !Number.isFinite(component))) {
    throw invalidField(path, value, 'an array of 3 finite numbers, such as [0, 0, 1]', TypeError);
  }
  return [...value];
}

function nodeReference(value, path) {
  if (typeof value !== 'string' || !value || value.length > 256) throw invalidField(path, value, 'a node label or id of 1 to 256 characters, such as "wheel-front-left"', TypeError);
  return value;
}

function normalizePath(path, label) {
  if (Array.isArray(path)) {
    if (path.length < 2 || path.length > DRIVE_LIMITS.maxPathPoints) {
      throw invalidField(label, `${path.length} points`, `2 to ${DRIVE_LIMITS.maxPathPoints} points, such as [[0, 0, 0], [0, 0, 10]]`);
    }
    return path.map((point, index) => vector(point, `${label}[${index}]`));
  }
  knownKeys(path, CAMERA_PATH_FIELDS, label);
  if (!path.eye || !Array.isArray(path.eye.keyframes) || path.eye.keyframes.length > DRIVE_LIMITS.maxPathPoints) {
    throw invalidField(label, path, 'an array of [x, y, z] points, such as [[0, 0, 0], [0, 0, 10]], or a camera path such as { "duration": 5, "eye": { "keyframes": [] } }', TypeError);
  }
  return structuredClone(path);
}

function normalizeWheels(wheels, path) {
  if (wheels === 'auto') return wheels;
  if (!Array.isArray(wheels) || wheels.length < 2 || wheels.length > DRIVE_LIMITS.maxWheels) {
    throw invalidField(path, Array.isArray(wheels) ? `${wheels.length} wheels` : wheels, `"auto", or a list of 2 to ${DRIVE_LIMITS.maxWheels} wheels, such as "auto"`);
  }
  return wheels.map((wheel, index) => {
    const wheelPath = `${path}[${index}]`;
    knownKeys(wheel, WHEEL_FIELDS, wheelPath);
    const references = wheel.nodes ?? [wheel.node];
    if (!Array.isArray(references) || !references.length || references.length > DRIVE_LIMITS.maxNodeReferences) {
      throw invalidField(`${wheelPath}.${wheel.nodes === undefined ? 'node' : 'nodes'}`, wheel.nodes ?? wheel.node, 'a node, or nodes listing tire, hub and bolts, such as "wheel-0"', TypeError);
    }
    references.forEach((reference, referenceIndex) => nodeReference(reference, wheel.nodes === undefined ? `${wheelPath}.node` : `${wheelPath}.nodes[${referenceIndex}]`));
    return structuredClone(wheel);
  });
}

function normalizeLights(lights, path) {
  knownKeys(lights, LIGHT_FIELDS, path);
  const result = {};
  if (lights.headlights !== undefined) {
    if (!Array.isArray(lights.headlights) || lights.headlights.length > DRIVE_LIMITS.maxLights) {
      throw invalidField(`${path}.headlights`, Array.isArray(lights.headlights) ? `${lights.headlights.length} lamps` : lights.headlights, `a list of at most ${DRIVE_LIMITS.maxLights} lamps, such as [{ "position": [0.5, 0.6, 2] }]`);
    }
    result.headlights = lights.headlights.map((light, index) => {
      const lampPath = `${path}.headlights[${index}]`;
      knownKeys(light, HEADLIGHT_FIELDS, lampPath);
      const lamp = { position: vector(light.position, `${lampPath}.position`) };
      if (light.id !== undefined) lamp.id = String(light.id);
      if (light.direction !== undefined) lamp.direction = vector(light.direction, `${lampPath}.direction`);
      return lamp;
    });
  }
  if (lights.tailLights !== undefined) {
    if (!Array.isArray(lights.tailLights) || lights.tailLights.length > DRIVE_LIMITS.maxLights) {
      throw invalidField(`${path}.tailLights`, Array.isArray(lights.tailLights) ? `${lights.tailLights.length} lamps` : lights.tailLights, `a list of at most ${DRIVE_LIMITS.maxLights} lamps, such as [{ "material": "tail", "signal": "brake" }]`);
    }
    result.tailLights = lights.tailLights.map((light, index) => {
      const lampPath = `${path}.tailLights[${index}]`;
      knownKeys(light, TAIL_LIGHT_FIELDS, lampPath);
      if (typeof light.material !== 'string' || !light.material) throw invalidField(`${lampPath}.material`, light.material, 'the id of the material whose emission the lamp drives, such as "tail"', TypeError);
      if (light.signal !== 'brake' && light.signal !== 'reverse') throw invalidField(`${lampPath}.signal`, light.signal, 'one of brake, reverse');
      return structuredClone(light);
    });
  }
  return result;
}

/** Validate the shape of a drive entry and return its canonical JSON. Numbers are checked when the drive is built. `path` is where the entry sits in the recipe. */
export function normalizeDrive(input, path = 'drive') {
  knownKeys(input, DRIVE_FIELDS, path);
  if ((input.path === undefined) === (input.legs === undefined)) {
    throw invalidField(`${path}.${input.path === undefined ? 'path' : 'legs'}`, input.path ?? input.legs, 'exactly one of path or legs, such as a path [[0, 0, 0], [0, 0, 10]]', TypeError);
  }
  const result = {};
  if (input.path !== undefined) result.path = normalizePath(input.path, `${path}.path`);
  if (input.legs !== undefined) {
    if (!Array.isArray(input.legs) || !input.legs.length || input.legs.length > DRIVE_LIMITS.maxLegs) {
      throw invalidField(`${path}.legs`, Array.isArray(input.legs) ? `${input.legs.length} legs` : input.legs, `1 to ${DRIVE_LIMITS.maxLegs} legs, such as [{ "path": [[0, 0, 0], [0, 0, 10]] }]`);
    }
    result.legs = input.legs.map((leg, index) => {
      const legPath = `${path}.legs[${index}]`;
      knownKeys(leg, ['path', 'direction', 'pause'], legPath);
      if (leg.direction !== undefined && leg.direction !== 'forward' && leg.direction !== 'reverse') throw invalidField(`${legPath}.direction`, leg.direction, 'one of forward, reverse');
      return { ...structuredClone(leg), path: normalizePath(leg.path, `${legPath}.path`) };
    });
  }
  for (const field of NUMBER_OPTIONS) {
    if (input[field] !== undefined) {
      if (!Number.isFinite(input[field])) throw invalidField(`${path}.${field}`, input[field], 'a finite number, such as 5', TypeError);
      result[field] = input[field];
    }
  }
  if (input.steering !== undefined) {
    if (input.steering !== 'ackermann' && input.steering !== 'shared') throw invalidField(`${path}.steering`, input.steering, 'one of ackermann, shared');
    result.steering = input.steering;
  }
  if (input.forwardAxis !== undefined) {
    if (!['+x', '-x', '+z', '-z'].includes(input.forwardAxis)) throw invalidField(`${path}.forwardAxis`, input.forwardAxis, 'one of +x, -x, +z, -z');
    result.forwardAxis = input.forwardAxis;
  }
  if (input.wheels !== undefined) result.wheels = normalizeWheels(input.wheels, `${path}.wheels`);
  if (input.body !== undefined) {
    if (!Array.isArray(input.body) || !input.body.length || input.body.length > DRIVE_LIMITS.maxNodeReferences) {
      throw invalidField(`${path}.body`, Array.isArray(input.body) ? `${input.body.length} nodes` : input.body, `a list of 1 to ${DRIVE_LIMITS.maxNodeReferences} nodes, such as ["body"]`);
    }
    result.body = input.body.map((reference, index) => nodeReference(reference, `${path}.body[${index}]`));
  }
  if (input.lights !== undefined) result.lights = normalizeLights(input.lights, `${path}.lights`);
  return result;
}
