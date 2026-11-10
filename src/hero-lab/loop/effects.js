// Small, cheap motion for the hero worlds, all of it a pure function of the scene time so a recorder can render exact frames:
//   blink   a set of emissive parts (signal lamps, status LEDs) pulses or flickers, each material variant on its own phase
//   drive   machines (forklifts, picker robots) slide to and fro along an aisle; the parts of one machine share a spot, so they move as one
//   carry   a small box (a tote) rides on every driving machine
//   gulls   a few birds circle over the quay: each is one extra part of two triangles
//   haze    one drifting volume of fog (dust in the sun, cold air in a hall) through the 67js volume fog addon
//   glare   the bloom strength breathes slowly
// Each world lists what it wants in EFFECTS; a world without an entry draws exactly as before.
// Only matrices and emission change. Movers cast into the shadow map, which is redrawn SHADOW_RATE times a second while they are on screen.

const TAU = Math.PI * 2;
const BLINK_VARIANTS = 3;
const MAXIMUM_MACHINE_PARTS = 40;
const SHADOW_RATE = 8;

const EFFECTS = {
  port: {
    blink: [{ materials: /^glow_/, period: 2.4, low: 0.25, high: 1 }],
    glare: { amount: 0.1, period: 9 },
    gulls: { count: 7, center: [10, 55, -125], radius: [16, 40], height: [-10, 12], speed: 7, wingspan: 6.5 },
  },
  datacenter: {
    blink: [{ materials: /status_green|status_blue/, period: 1.7, low: 0.1, high: 1.4 }],
    haze: { minimum: [-16, 0.2, -14], maximum: [16, 5.5, 12], density: 0.012, color: [0.45, 0.62, 0.9], ambient: [0.012, 0.02, 0.04], steps: 16, maxDistance: 70, drift: [0.15, 0, 0.05], noiseScale: 0.18, noiseAmount: 0.85, keyScattering: 0.6 },
  },
  warehouse: {
    blink: [{ names: /^doorLamp/, period: 2.2, low: 0.3, high: 1 }],
    drive: [{ materials: /forklift/, axis: 2, amplitude: 2.2, period: 14 }],
    haze: { minimum: [-27, 0.3, -22], maximum: [34, 11, 21], density: 0.006, color: [0.95, 0.88, 0.75], ambient: [0.02, 0.02, 0.02], steps: 16, maxDistance: 80, drift: [0.06, 0.01, 0.03], noiseScale: 0.25, noiseAmount: 0.9, keyScattering: 1.2 },
  },
  darkstore: {
    blink: [{ materials: /emissive_/, period: 2.6, low: 0.15, high: 1, flicker: true }],
    drive: [{ materials: /robot/, axis: 2, amplitude: 3.2, period: 12 }],
    carry: { size: [0.6, 0.32, 0.42], offset: [0, 0.7, 0], color: [0.95, 0.5, 0.08] },
  },
};

function matchesPart(rule, part) {
  const materialName = part.material?.name ?? '';
  return (rule.materials ? rule.materials.test(materialName) : false) || (rule.names ? rule.names.test(part.name ?? '') : false);
}

// A hash of an integer step to 0..1, so a flicker is the same on every visit to a time.
function hashUnit(step) {
  let value = Math.imul(step ^ 0x9e3779b1, 0x85ebca6b);
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

// Gives every matched part one of a few copies of its material so the copies can pulse out of step.
function prepareBlink(rule, parts) {
  const matched = parts.filter(part => matchesPart(rule, part));
  const variants = new Map();
  matched.forEach((part, index) => {
    const slot = index % BLINK_VARIANTS;
    const key = `${part.material.name ?? ''}#${slot}`;
    if (!variants.has(key)) variants.set(key, { material: { ...part.material }, base: part.material.emission || 1, slot, parts: [] });
    const variant = variants.get(key);
    part.material = variant.material;
    variant.parts.push(part);
  });
  return { rule, variants: [...variants.values()], parts: matched };
}

// Machines are told apart by where they stand: all parts of one forklift share a translation.
function prepareDrive(rule, parts) {
  const groups = new Map();
  for (const part of parts) {
    const key = `${part.matrix[12].toFixed(3)},${part.matrix[14].toFixed(3)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(part);
  }
  const machines = [];
  for (const members of groups.values()) {
    // A spot shared by dozens of parts is stock or shell with no offset of its own, not one machine.
    if (members.length > MAXIMUM_MACHINE_PARTS || !members.some(part => matchesPart(rule, part))) continue;
    machines.push({ parts: members, base: members.map(part => part.matrix[12 + rule.axis]), phase: machines.length * 1.7 });
  }
  return { rule, machines, parts: machines.flatMap(machine => machine.parts) };
}

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function boxGeometry([width, height, depth]) {
  const [x, y, z] = [width / 2, height / 2, depth / 2];
  const faces = [
    [[1, 0, 0], [[x, -y, -z], [x, y, -z], [x, y, z], [x, -y, z]]],
    [[-1, 0, 0], [[-x, -y, z], [-x, y, z], [-x, y, -z], [-x, -y, -z]]],
    [[0, 1, 0], [[-x, y, -z], [-x, y, z], [x, y, z], [x, y, -z]]],
    [[0, -1, 0], [[-x, -y, z], [-x, -y, -z], [x, -y, -z], [x, -y, z]]],
    [[0, 0, 1], [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]]],
    [[0, 0, -1], [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]]],
  ];
  const positions = [];
  const normals = [];
  const indices = [];
  faces.forEach(([normal, corners], face) => {
    corners.forEach(corner => { positions.push(...corner); normals.push(...normal); });
    indices.push(face * 4, face * 4 + 1, face * 4 + 2, face * 4, face * 4 + 2, face * 4 + 3);
  });
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

// A bird as a flat arrowhead: nose, two wing tips and a tail. Wingspan in metres.
function gullGeometry(wingspan) {
  const half = wingspan / 2;
  const positions = new Float32Array([0, 0, 0.22 * wingspan, -half, 0.3 * half, -0.06 * wingspan, 0, 0, -0.2 * wingspan, half, 0.3 * half, -0.06 * wingspan]);
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
  return { positions, normals, indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
}

function plainMaterial(name, color, roughness, doubleSided) {
  return { tag: 'gltf', name, color, metallic: 0, roughness, emission: 0, emissiveColor: [0, 0, 0], normalScale: [1, 1], occlusionStrength: 1, alphaMode: 'opaque', alphaCutoff: 0.5, opacity: 1, doubleSided };
}

function prepareGulls(settings) {
  const material = plainMaterial('gull', [0.07, 0.075, 0.09], 0.9, true);
  const geometry = gullGeometry(settings.wingspan);
  const birds = Array.from({ length: settings.count }, (_, index) => {
    const spread = hashUnit(index * 7 + 1);
    return {
      part: { name: `gull-${index}`, geometry, material, matrix: identity(), castShadow: false },
      radius: settings.radius[0] + (settings.radius[1] - settings.radius[0]) * spread,
      height: settings.height[0] + (settings.height[1] - settings.height[0]) * hashUnit(index * 7 + 2),
      angle: TAU * hashUnit(index * 7 + 3),
      direction: index % 2 ? 1 : -1,
      flap: 1.4 + hashUnit(index * 7 + 4),
    };
  });
  return { settings, birds };
}

function placeGull(settings, bird, seconds) {
  const omega = (bird.direction * settings.speed) / bird.radius;
  const theta = bird.angle + omega * seconds;
  const yaw = Math.atan2(-bird.direction * Math.sin(theta), bird.direction * Math.cos(theta));
  const roll = bird.direction * 0.4 + 0.12 * Math.sin(TAU * bird.flap * seconds);
  const [cosYaw, sinYaw, cosRoll, sinRoll] = [Math.cos(yaw), Math.sin(yaw), Math.cos(roll), Math.sin(roll)];
  const matrix = bird.part.matrix;
  // The wing tips sit above the body plane; scaling the up axis by a sine beats them up and down. A negative beat alone would
  // mirror the bird, and the renderer packs every part again each time a part changes handedness (thousands of times a minute),
  // so the side axis flips with it: the bird is left-right symmetric, and the picture is the same.
  const beat = Math.sin(TAU * bird.flap * seconds * 1.3 + bird.angle);
  const side = beat < 0 ? -1 : 1;
  matrix[0] = side * cosYaw * cosRoll; matrix[1] = side * sinRoll; matrix[2] = -side * sinYaw * cosRoll;
  matrix[4] = -cosYaw * sinRoll * beat; matrix[5] = cosRoll * beat; matrix[6] = sinYaw * sinRoll * beat;
  matrix[8] = sinYaw; matrix[9] = 0; matrix[10] = cosYaw;
  matrix[12] = settings.center[0] + bird.radius * Math.cos(theta);
  matrix[13] = settings.center[1] + bird.height + 0.8 * Math.sin(TAU * 0.3 * seconds + bird.angle);
  matrix[14] = settings.center[2] + bird.radius * Math.sin(theta);
}

export function prepareEffects(worldId, parts) {
  const config = EFFECTS[worldId];
  if (!config) return null;
  const blinks = (config.blink ?? []).map(rule => prepareBlink(rule, parts));
  const drives = (config.drive ?? []).map(rule => prepareDrive(rule, parts));
  const gulls = config.gulls ? prepareGulls(config.gulls) : null;
  const totes = [];
  if (config.carry) {
    const geometry = boxGeometry(config.carry.size);
    const material = plainMaterial('tote', config.carry.color, 0.6, false);
    drives.forEach(({ machines }) => machines.forEach(machine => totes.push({ machine, part: { name: 'tote', geometry, material, matrix: identity(), castShadow: true } })));
  }
  const extraParts = [...(gulls?.birds.map(bird => bird.part) ?? []), ...totes.map(tote => tote.part)];
  const moving = [...blinks.flatMap(entry => entry.parts), ...drives.flatMap(entry => entry.parts), ...extraParts];
  const shadowsMove = drives.length > 0;
  let shadowStep = -1;
  return {
    // Added to the renderer options: the haze needs a depth buffer.
    rendererOptions: config.haze ? { depth: true } : {},
    volumeFog: config.haze ?? null,
    needsFogAddon: Boolean(config.haze),
    // Parts that exist only for the effects; the world adds them to its own.
    extraParts,
    // Called before each draw with the scene time; returns the extra frame fields and updates the renderer's parts.
    apply(renderer, seconds, frame) {
      for (const { rule, variants } of blinks) {
        for (const variant of variants) {
          const phase = seconds / rule.period + variant.slot / BLINK_VARIANTS;
          // A flicker holds high, then drops out for a few hundredths of a second at hashed moments.
          const wave = rule.flicker ? (hashUnit(Math.floor(phase * 9) + variant.slot * 131) > 0.72 ? 0 : 1) : 0.5 + 0.5 * Math.sin(TAU * phase);
          variant.material.emission = variant.base * (rule.low + (rule.high - rule.low) * wave);
        }
      }
      for (const { rule, machines } of drives) {
        for (const machine of machines) {
          const offset = rule.amplitude * Math.sin(TAU * seconds / rule.period + machine.phase);
          machine.parts.forEach((part, index) => { part.matrix[12 + rule.axis] = machine.base[index] + offset; });
        }
      }
      if (gulls) gulls.birds.forEach(bird => placeGull(gulls.settings, bird, seconds));
      for (const { machine, part } of totes) {
        const lead = machine.parts[0].matrix;
        part.matrix[12] = lead[12] + config.carry.offset[0];
        part.matrix[13] = lead[13] + config.carry.offset[1];
        part.matrix[14] = lead[14] + config.carry.offset[2];
      }
      const step = Math.floor(seconds * SHADOW_RATE);
      const refreshShadows = shadowsMove && step !== shadowStep;
      shadowStep = step;
      if (moving.length) renderer.updateParts(moving, { shadows: refreshShadows, checks: false });
      if (!config.glare || !frame.effects?.bloom) return frame;
      const bloom = { ...frame.effects.bloom, strength: frame.effects.bloom.strength * (1 + config.glare.amount * Math.sin(TAU * seconds / config.glare.period)) };
      return { ...frame, effects: { ...frame.effects, bloom } };
    },
  };
}
