// Writes a copy of an exported scene with many small point lights spread through the room, for light tree measurements.
// trace-scene-many-lights.mjs (used by trace-native.mjs) builds a scene with more than 32 lights in chunks, because a trace
// scene itself takes at most 32 lights: each light owns a light-link bit.
//   node bench/cycles-parity/make-many-lights-scene.mjs <sceneJsonPath> <outputJsonPath> [--count 500] [--seed 7]
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function readFlagValue(argumentList, flagName, fallbackValue) {
  const flagIndex = argumentList.indexOf(flagName);
  return flagIndex === -1 ? fallbackValue : argumentList[flagIndex + 1];
}

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const argumentList = process.argv.slice(2);
if (argumentList.length < 2) {
  throw new RangeError('Usage: node bench/cycles-parity/make-many-lights-scene.mjs <sceneJsonPath> <outputJsonPath> [--count 500] [--seed 7]');
}
const lightCount = Number(readFlagValue(argumentList, '--count', 500));
const nextRandom = createRandom(Number(readFlagValue(argumentList, '--seed', 7)));
const description = JSON.parse(await readFile(resolve(argumentList[0]), 'utf8'));
const totalIntensity = 12;
description.id = `${description.id}-${lightCount}-lights`;
description.environment.pointLights = Array.from({ length: lightCount }, () => ({
  position: [(nextRandom() - 0.5) * 7.4, 0.3 + nextRandom() * 2.7, (nextRandom() - 0.5) * 7.4],
  color: [0.6 + 0.4 * nextRandom(), 0.6 + 0.4 * nextRandom(), 0.6 + 0.4 * nextRandom()],
  intensity: (totalIntensity / lightCount) * (0.25 + 1.5 * nextRandom()),
  radius: 0.03,
  castShadow: true,
}));
await writeFile(resolve(argumentList[1]), JSON.stringify(description));
console.log(JSON.stringify({ outputPath: resolve(argumentList[1]), lightCount }));
