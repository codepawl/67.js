// Small, cheap motion for the hero worlds, all of it a pure function of the scene time so a recorder can render exact frames:
//   blink   a set of emissive parts (signal lamps, status LEDs) pulses, each material variant on its own phase
//   drive   machines (forklifts, picker robots) slide to and fro along an aisle; the parts of one machine share a spot, so they move as one
//   haze    one drifting volume of fog (dust in the sun, cold air in a hall) through the 67js volume fog addon
//   glare   the bloom strength breathes slowly
// Each world lists what it wants in EFFECTS; a world without an entry draws exactly as before.
// Parts keep their geometry and shadows: only matrices and emission change, and the shadow map is not redrawn for them.

const TAU = Math.PI * 2;
const BLINK_VARIANTS = 3;
const MAXIMUM_MACHINE_PARTS = 40;

const EFFECTS = {
  port: {
    blink: [{ materials: /^glow_/, period: 2.4, low: 0.25, high: 1 }],
    glare: { amount: 0.1, period: 9 },
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
    drive: [{ materials: /robot/, axis: 2, amplitude: 3.2, period: 12 }],
  },
};

function matchesPart(rule, part) {
  const materialName = part.material?.name ?? '';
  return (rule.materials ? rule.materials.test(materialName) : false) || (rule.names ? rule.names.test(part.name ?? '') : false);
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

export function prepareEffects(worldId, parts) {
  const config = EFFECTS[worldId];
  if (!config) return null;
  const blinks = (config.blink ?? []).map(rule => prepareBlink(rule, parts));
  const drives = (config.drive ?? []).map(rule => prepareDrive(rule, parts));
  const moving = [...blinks.flatMap(entry => entry.parts), ...drives.flatMap(entry => entry.parts)];
  return {
    // Added to the renderer options: the haze needs a depth buffer.
    rendererOptions: config.haze ? { depth: true } : {},
    volumeFog: config.haze ?? null,
    needsFogAddon: Boolean(config.haze),
    // Called before each draw with the scene time; returns the extra frame fields and updates the renderer's parts.
    apply(renderer, seconds, frame) {
      for (const { rule, variants } of blinks) {
        for (const variant of variants) {
          const wave = 0.5 + 0.5 * Math.sin(TAU * (seconds / rule.period + variant.slot / BLINK_VARIANTS));
          variant.material.emission = variant.base * (rule.low + (rule.high - rule.low) * wave);
        }
      }
      for (const { rule, machines } of drives) {
        for (const machine of machines) {
          const offset = rule.amplitude * Math.sin(TAU * seconds / rule.period + machine.phase);
          machine.parts.forEach((part, index) => { part.matrix[12 + rule.axis] = machine.base[index] + offset; });
        }
      }
      if (moving.length) renderer.updateParts(moving, { shadows: false, checks: false });
      if (!config.glare || !frame.effects?.bloom) return frame;
      const bloom = { ...frame.effects.bloom, strength: frame.effects.bloom.strength * (1 + config.glare.amount * Math.sin(TAU * seconds / config.glare.period)) };
      return { ...frame, effects: { ...frame.effects, bloom } };
    },
  };
}
