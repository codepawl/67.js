// The pure parts of scripts/render-file-native.mjs (arguments, usage, the missing-addon message, the list of frame effects the
// traced picture does not get), kept apart so a test can import them without starting Chrome.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const USAGE = `Path trace a GLB file scene (scene.json) with Cook, the native tracer.

Usage: node scripts/render-file-native.mjs --config <scene.json> --out <prefix> [options]

  --config <scene.json>     the file scene (GLB + HDRI + camera), as scripts/render-media.mjs --scene file reads it
  --out <prefix>            writes <prefix>.png, <prefix>.linear.f32 and <prefix>.json
  --width <n>, --height <n> picture size in pixels, 16 to 8192 (default 800 x 450)
  --samples <n>             paths per pixel, 1 to 100000 (default 128)
  --bounces <n>             bounces per path, 1 to 16 (default 8)
  --seed <n>                noise seed, 0 to 2147483647 (default 1)
  --max-seconds <n>         wall-clock limit of the trace, 1 to 86400 (default 600)
  --denoise oidn|atrous|none  (default oidn, which falls back to atrous when OIDN is missing)
  --write-raw               also write <prefix>.raw.png and <prefix>.raw.linear.f32 before denoising
  --camera <camera.json>    eye, target and verticalFovDegrees (or fov) replace the camera of the scene description
  --instancing              keep repeated geometry as instances
  --chrome <path>           Chrome or Chromium executable for the loader page
  --software-gl             load the page on SwiftShader
  --list-parts <regex>      write <prefix>.parts.json for the parts whose name or "material:<name>" matches
  --hide-parts <regex>      leave the matching parts out of the picture
  --patch-materials "<regex>={json}"  change the matching materials before packing (repeatable)
  --help                    print this text

Exit code 2 means the native addon is not built; 1 is any other failure.`;

const VALUE_FLAGS = new Set(['--config', '--out', '--width', '--height', '--samples', '--bounces', '--seed', '--max-seconds', '--denoise',
  '--camera', '--chrome', '--list-parts', '--hide-parts', '--patch-materials']);
const SWITCH_FLAGS = new Set(['--instancing', '--software-gl', '--write-raw', '--help', '-h']);
const DENOISERS = ['oidn', 'atrous', 'none'];

/** Thrown when the render-native package or its built addon is missing; the command exits with code 2 for it. */
export class MissingAddonError extends Error {
  constructor(message = missingAddonMessage()) {
    super(message);
    this.name = 'MissingAddonError';
  }
}

/** The one message for a missing package or addon: what is missing and the command that builds it. */
export function missingAddonMessage() {
  return 'Cook needs the render-native addon, and it is not built. Run "node build.mjs" in packages/render-native (it needs the Rust toolchain), then run this command again.';
}

function readOption(argumentList, flagName, fallbackValue) {
  const flagIndex = argumentList.indexOf(flagName);
  if (flagIndex === -1) return fallbackValue;
  const value = argumentList[flagIndex + 1];
  if (value === undefined || value.startsWith('--')) throw new RangeError(`Flag ${flagName} requires a value.`);
  return value;
}

function readIntegerOption(argumentList, flagName, fallbackValue, minimum, maximum) {
  const text = readOption(argumentList, flagName, String(fallbackValue));
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`Option ${flagName} must be a whole number from ${minimum} to ${maximum}, got "${text}".`);
  }
  return parsed;
}

function assertKnownFlags(argumentList) {
  for (let index = 0; index < argumentList.length; index++) {
    const argument = argumentList[index];
    if (VALUE_FLAGS.has(argument)) {
      index += 1;
    } else if (!SWITCH_FLAGS.has(argument)) {
      throw new RangeError(`Unknown argument "${argument}". Run with --help to see the options.`);
    }
  }
}

// Part patterns are tested against "<part name> material:<material name>".
// --patch-materials '<part name regex>=<json material fields>' (repeatable) changes loaded materials before packing, to test a scene fix.
function parsePatchMaterials(argumentList) {
  const patches = [];
  argumentList.forEach((argument, index) => {
    if (argument !== '--patch-materials') return;
    const value = argumentList[index + 1] ?? '';
    const separator = value.lastIndexOf('={');
    if (separator === -1) throw new RangeError(`Option --patch-materials needs "<part regex>={json}", got "${value}".`);
    let patch;
    try {
      patch = JSON.parse(value.slice(separator + 1));
    } catch (error) {
      throw new RangeError(`Option --patch-materials has JSON that does not parse (${error.message}): "${value}".`);
    }
    patches.push({ pattern: value.slice(0, separator), patch });
  });
  return patches;
}

function assertVector(value, fieldName, filePath) {
  const isVector = Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
  if (!isVector) throw new RangeError(`Camera file ${filePath} needs "${fieldName}" as [x, y, z] with three numbers.`);
}

/** Reads a camera file: eye, target and verticalFovDegrees (or fov), and returns { eye, target, fov } for the tracer. */
export function readCameraFile(cameraPath) {
  const filePath = resolve(cameraPath);
  let camera;
  try {
    camera = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new RangeError(`Option --camera could not read ${filePath} as JSON (${error.message}). Pass a file like {"eye":[0,1,5],"target":[0,1,0],"verticalFovDegrees":40}.`);
  }
  assertVector(camera?.eye, 'eye', filePath);
  assertVector(camera.target, 'target', filePath);
  const fov = camera.verticalFovDegrees ?? camera.fov;
  if (typeof fov !== 'number' || !(fov > 1 && fov < 170)) {
    throw new RangeError(`Camera file ${filePath} needs "verticalFovDegrees" (or "fov") as a number of degrees between 1 and 170, got ${JSON.stringify(fov)}.`);
  }
  return { eye: camera.eye, target: camera.target, fov };
}

/** Parses the command line. `{ help: true }` means print USAGE and stop. Throws a RangeError that says what to pass. */
export function parseArguments(argumentList) {
  assertKnownFlags(argumentList);
  if (argumentList.includes('--help') || argumentList.includes('-h')) return { help: true };
  const config = readOption(argumentList, '--config');
  const outputPrefix = readOption(argumentList, '--out');
  if (!config || !outputPrefix) throw new RangeError('Pass --config <scene.json> and --out <prefix>. Run with --help to see the options.');
  const denoise = readOption(argumentList, '--denoise', 'oidn');
  if (!DENOISERS.includes(denoise)) throw new RangeError(`Option --denoise must be oidn, atrous or none, got "${denoise}".`);
  const cameraPath = readOption(argumentList, '--camera');
  return {
    help: false,
    config: resolve(config),
    outputPrefix: resolve(outputPrefix),
    width: readIntegerOption(argumentList, '--width', 800, 16, 8192),
    height: readIntegerOption(argumentList, '--height', 450, 16, 8192),
    samples: readIntegerOption(argumentList, '--samples', 128, 1, 100000),
    bounces: readIntegerOption(argumentList, '--bounces', 8, 1, 16),
    seed: readIntegerOption(argumentList, '--seed', 1, 0, 2147483647),
    maxSeconds: readIntegerOption(argumentList, '--max-seconds', 600, 1, 86400),
    denoise,
    writeRaw: argumentList.includes('--write-raw'),
    camera: cameraPath === undefined ? null : readCameraFile(cameraPath),
    instancing: argumentList.includes('--instancing'),
    chrome: readOption(argumentList, '--chrome'),
    softwareGl: argumentList.includes('--software-gl'),
    listParts: readOption(argumentList, '--list-parts'),
    hideParts: readOption(argumentList, '--hide-parts'),
    patchMaterials: parsePatchMaterials(argumentList),
  };
}

/**
 * Frame effects of the scene description that the traced picture does not get: the page applies them in its raster post step,
 * and the path traced picture is only tone mapped (ACES and gamma). Returns the names that are set to a non-default value.
 */
export function listIgnoredFrameEffects(description) {
  const frame = description?.frame ?? {};
  const effects = frame.effects ?? {};
  const ignored = [];
  const exposure = frame.exposure ?? description?.exposure ?? 1;
  if (exposure !== 1) ignored.push('exposure');
  for (const [name, neutral] of [['saturation', 1], ['contrast', 1], ['temperature', 0], ['vignette', 0], ['grain', 0], ['ambientOcclusion', 0]]) {
    if (effects[name] !== undefined && effects[name] !== neutral) ignored.push(name);
  }
  if (effects.bloom?.strength > 0) ignored.push('bloom');
  for (const name of ['monochrome', 'fade']) {
    if (frame[name]) ignored.push(name);
  }
  if (frame.cinematic) ignored.push('cinematic');
  return ignored;
}
