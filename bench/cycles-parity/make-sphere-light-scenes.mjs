// Writes the scenes that isolate a sphere light (a point light with a radius) from an exported `lit-interior` scene (#1040):
// a bare room with one lamp, and the same lamp inside a small open-bottomed shade, with the shade seen or hidden by shadow rays.
//   node bench/cycles-parity/make-sphere-light-scenes.mjs <exportedSceneJson> <outputDirectory>
// Run it with --grey-diffuse on both renderers so only the light differs. A shade part carries `rayVisibility: { shadow: false }`
// when hidden from shadow rays; trace-native.mjs needs --instancing to read it.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOM_PART_COUNT = 5;
const LAMP_POSITION = [0, 1.6, -0.5];
const LAMP_INTENSITY = 8;
const SHADE_WALL_THICKNESS = 0.02;
const SHADE_CLEARANCE_BELOW_LAMP = 0.25;
const SHADE_CLEARANCE_ABOVE_LAMP = 0.25;

function createBoxPart(name, center, size, materialIndex, rayVisibility) {
  const part = {
    name,
    geometry: 0,
    matrix: [size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1],
    material: materialIndex,
  };
  if (rayVisibility) {
    part.rayVisibility = rayVisibility;
  }
  return part;
}

// Four walls and a lid, open at the bottom, centred on the lamp.
function createShadeParts(halfWidth, rayVisibility) {
  const [lampX, lampY, lampZ] = LAMP_POSITION;
  const bottom = lampY - SHADE_CLEARANCE_BELOW_LAMP;
  const top = lampY + SHADE_CLEARANCE_ABOVE_LAMP;
  const height = top - bottom;
  const middleY = (top + bottom) / 2;
  const span = 2 * halfWidth + 2 * SHADE_WALL_THICKNESS;
  return [
    createBoxPart('shade-lid', [lampX, top + SHADE_WALL_THICKNESS / 2, lampZ], [span, SHADE_WALL_THICKNESS, span], 0, rayVisibility),
    createBoxPart('shade-left', [lampX - halfWidth - SHADE_WALL_THICKNESS / 2, middleY, lampZ], [SHADE_WALL_THICKNESS, height, span], 0, rayVisibility),
    createBoxPart('shade-right', [lampX + halfWidth + SHADE_WALL_THICKNESS / 2, middleY, lampZ], [SHADE_WALL_THICKNESS, height, span], 0, rayVisibility),
    createBoxPart('shade-back', [lampX, middleY, lampZ - halfWidth - SHADE_WALL_THICKNESS / 2], [span, height, SHADE_WALL_THICKNESS], 0, rayVisibility),
    createBoxPart('shade-front', [lampX, middleY, lampZ + halfWidth + SHADE_WALL_THICKNESS / 2], [span, height, SHADE_WALL_THICKNESS], 0, rayVisibility),
  ];
}

function createVariant(baseDescription, id, lampRadius, shade) {
  const roomParts = baseDescription.parts.slice(0, ROOM_PART_COUNT);
  const shadeParts = shade ? createShadeParts(shade.halfWidth, shade.hiddenFromShadowRays ? { shadow: false } : undefined) : [];
  return {
    ...baseDescription,
    id,
    parts: [...roomParts, ...shadeParts],
    environment: {
      ...baseDescription.environment,
      pointLights: [{ position: LAMP_POSITION, color: [1, 1, 1], intensity: LAMP_INTENSITY, radius: lampRadius, castShadow: true }],
      spotLights: [],
      areaLights: [],
    },
  };
}

function listVariants() {
  const variants = [];
  for (const radius of [0, 0.05, 0.18, 0.5]) {
    variants.push({ id: `bare-r${radius}`, radius, shade: null });
  }
  for (const radius of [0, 0.18]) {
    variants.push({ id: `enclosed-r${radius}`, radius, shade: { halfWidth: 0.3, hiddenFromShadowRays: false } });
    variants.push({ id: `enclosed-hidden-r${radius}`, radius, shade: { halfWidth: 0.3, hiddenFromShadowRays: true } });
  }
  variants.push({ id: 'poking-r0.18', radius: 0.18, shade: { halfWidth: 0.12, hiddenFromShadowRays: false } });
  variants.push({ id: 'poking-hidden-r0.18', radius: 0.18, shade: { halfWidth: 0.12, hiddenFromShadowRays: true } });
  return variants;
}

const argumentList = process.argv.slice(2);
if (argumentList.length < 2) {
  throw new RangeError('Usage: node bench/cycles-parity/make-sphere-light-scenes.mjs <exportedSceneJson> <outputDirectory>');
}
const baseDescription = JSON.parse(await readFile(resolve(argumentList[0]), 'utf8'));
const scenesDirectory = join(resolve(argumentList[1]), 'scenes');
await mkdir(scenesDirectory, { recursive: true });
for (const variant of listVariants()) {
  const description = createVariant(baseDescription, variant.id, variant.radius, variant.shade);
  await writeFile(join(scenesDirectory, `${variant.id}.json`), JSON.stringify(description));
  console.log(variant.id);
}
