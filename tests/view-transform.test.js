import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { toneMapToRgba8 } from '../src/path-tracer.js';
import { normalizeAgentLook } from '../src/agent-look.js';
import '../src/liquid-shader.js';
import { fragmentShader, liquidFragmentSource, viewTransformShader } from '../src/shaders.js';
import { environmentBackgroundFragment } from '../src/environment.js';
import { postFragment } from '../src/post.js';
import {
  acesChannel, AGX_CONSTANTS, applyViewTransform, displayColor, namedLook, neutralColor, NEUTRAL_CONSTANTS, parseCube, sampleLook,
} from '../src/view-transform.js';
import { LOOK_NAMES } from '../src/view-transform-names.js';

// The liquid pass is an addon since #281; importing it above registers its shader.
const liquidFragmentShader = liquidFragmentSource();
import '../src/view-transform-shader.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/blender/view-transform-golden.json', import.meta.url), 'utf8'));

// Blender writes sRGB-encoded 16-bit values; the curves return linear values, so both sides meet in sRGB encoding.
const srgbEncode = value => (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055);

// Tolerance per channel in sRGB-encoded units (0 to 1), measured on this ramp against Blender 5.2.2: neutral 0.0079 at most
// (mean 0.0013), as Blender runs the Khronos formula. agx 0.0247 at most (mean 0.0026) since it is a fit of Blender's
// AgX_Base_sRGB.cube (the Filament polynomial it replaced was 0.0885 at most, 0.501 at grey 0.18 against Blender's 0.461).
// The grey patches are within 0.0012; what is left is saturated colour (2.0, 0.8, 0.1 is the worst patch), which a
// per-channel sigmoid and two matrices cannot follow exactly. The bounds sit just above the measured error so a regression shows.
const TOLERANCE = { agx: 0.026, neutral: 0.01 };
const MID_GREY_TOLERANCE = 0.005;

for (const name of ['agx', 'neutral']) {
  test(`${name} matches Blender ${golden.blenderVersion} on the colour ramp within ${TOLERANCE[name]}`, () => {
    let worst = 0;
    for (const patch of golden.patches) {
      const mine = applyViewTransform(name, patch.input).map(srgbEncode);
      for (let channel = 0; channel < 3; channel++) worst = Math.max(worst, Math.abs(mine[channel] - patch[name][channel]));
    }
    assert.ok(worst <= TOLERANCE[name], `${name} differs from Blender by ${worst.toFixed(5)}`);
  });
}

test('agx maps 0.18 mid grey to what Blender does', () => {
  const grey = golden.patches.find(patch => patch.input.every(value => value === 0.18));
  const mine = applyViewTransform('agx', grey.input).map(srgbEncode);
  for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(mine[channel] - grey.agx[channel]) <= MID_GREY_TOLERANCE, `channel ${channel}: ${mine[channel]}`);
});

test('the ramp covers greys from black to 16 and saturated colours', () => {
  assert.ok(golden.patches.length >= 25);
  assert.match(golden.blenderVersion, /^5\.2/);
});

function acesFromGlsl(source) {
  const match = source.match(/clamp\(\(color \* \(([\d.]+) \* color \+ ([\d.]+)\)\) \/ \(color \* \(([\d.]+) \* color \+ ([\d.]+)\) \+ ([\d.]+)\), 0\.0, 1\.0\)/);
  assert.ok(match, 'the shader holds the ACES expression');
  const [a, b, c, d, e] = match.slice(1).map(Number);
  return x => Math.min(1, Math.max(0, (x * (a * x + b)) / (x * (c * x + d) + e)));
}

test('the rasterizer shaders and the path tracer apply the same default curve', () => {
  for (const source of [fragmentShader, liquidFragmentShader, environmentBackgroundFragment, postFragment]) {
    const shaderCurve = acesFromGlsl(source);
    for (const value of [0, 0.01, 0.18, 0.5, 1, 2, 8, 100]) assert.equal(shaderCurve(value), acesChannel(value));
  }
  const ramp = new Float32Array([0, 0.18, 1, 4, 0.02, 0.5, 8, 0.3, 0.001]);
  const pixels = toneMapToRgba8(ramp, 3, 1);
  for (let index = 0; index < 9; index++) {
    const channel = index % 3;
    assert.equal(pixels[Math.floor(index / 3) * 4 + channel], Math.round(acesChannel(ramp[index]) ** (1 / 2.2) * 255));
  }
});

test('the GLSL of agx and neutral prints the constants the path tracer uses', () => {
  const agx = viewTransformShader.apply(fragmentShader, 'main', 'agx', false);
  const { inset, outset, minimumEv, slope, pivot, toe, shoulder, encodingPower } = AGX_CONSTANTS;
  const numbers = [...inset, ...outset].flat();
  const curve = [slope, ...pivot, toe.scale, toe.power, shoulder.scale, shoulder.power, encodingPower];
  for (const value of [...numbers, minimumEv, ...curve]) assert.ok(agx.includes(String(value)) || agx.includes(value.toFixed(1)), `agx GLSL holds ${value}`);
  const neutral = viewTransformShader.apply(fragmentShader, 'main', 'neutral', false);
  for (const value of [NEUTRAL_CONSTANTS.startCompression, NEUTRAL_CONSTANTS.desaturation, 1 - NEUTRAL_CONSTANTS.startCompression]) assert.ok(neutral.includes(String(value)), `neutral GLSL holds ${value}`);
});

test('the display curve is replaced in all four programs, and the look only in the post pass', () => {
  const sources = { main: fragmentShader, liquid: liquidFragmentShader, background: environmentBackgroundFragment, post: postFragment };
  for (const [kind, source] of Object.entries(sources)) {
    for (const name of ['agx', 'neutral']) {
      const changed = viewTransformShader.apply(source, kind, name, false);
      assert.ok(!changed.includes('2.51 * color'), `${kind} ${name} drops the ACES fit`);
      assert.ok(changed.includes('selectedViewTransform(color)'));
    }
    assert.equal(viewTransformShader.apply(source, kind, 'aces', true).includes('applyLook'), kind === 'post');
  }
  assert.throws(() => viewTransformShader.apply(fragmentShader, 'main', 'filmic', false), /viewTransform must be one of/);
});

test('neutral leaves base colours below the compression start as authored, minus the 0.04 shadow offset', () => {
  neutralColor([0.5, 0.3, 0.2]).forEach((value, channel) => assert.ok(Math.abs(value - [0.46, 0.26, 0.16][channel]) < 1e-12));
  assert.ok(neutralColor([8, 8, 8]).every(value => value <= 1 && value > 0.95));
});

test('recipes take a view transform and a named look, and refuse anything else', () => {
  const look = normalizeAgentLook({ environment: { viewTransform: 'agx', look: 'warm' } });
  assert.equal(look.environment.viewTransform, 'agx');
  assert.equal(look.environment.look, 'warm');
  assert.equal(normalizeAgentLook({}).environment.viewTransform, undefined);
  assert.throws(() => normalizeAgentLook({ environment: { viewTransform: 'filmic' } }), /environment\.viewTransform: got "filmic"; expected one of aces, agx, neutral/);
  assert.throws(() => normalizeAgentLook({ environment: { look: '../grade.cube' } }), /environment\.look: got "..\/grade\.cube"; expected one of/);
});

const IDENTITY_CUBE = (size) => {
  const rows = [];
  for (let blue = 0; blue < size; blue++) for (let green = 0; green < size; green++) for (let red = 0; red < size; red++) rows.push(`${red / (size - 1)} ${green / (size - 1)} ${blue / (size - 1)}`);
  return `# identity\nTITLE "identity"\nLUT_3D_SIZE ${size}\n${rows.join('\n')}\n`;
};

test('a .cube look parses, samples as the identity, and reaches the path tracer image', () => {
  const identity = parseCube(IDENTITY_CUBE(4));
  assert.equal(identity.size, 4);
  for (const color of [[0, 0, 0], [0.2, 0.7, 0.4], [1, 1, 1], [0.33, 0.01, 0.99]]) {
    sampleLook(identity, color).forEach((value, channel) => assert.ok(Math.abs(value - color[channel]) < 1e-6));
  }
  const inverted = parseCube(IDENTITY_CUBE(2).replace(/^[01] [01] [01]$/gm, row => row.split(' ').map(value => 1 - Number(value)).join(' ')));
  assert.deepEqual(sampleLook(inverted, [0, 0, 0]).map(Math.round), [1, 1, 1]);
  const linear = new Float32Array([0.18, 0.18, 0.18]);
  const plain = toneMapToRgba8(linear, 1, 1);
  assert.deepEqual([...toneMapToRgba8(linear, 1, 1, { look: identity }).slice(0, 3)], [...plain.slice(0, 3)]);
  assert.notDeepEqual([...toneMapToRgba8(linear, 1, 1, { look: inverted }).slice(0, 3)], [...plain.slice(0, 3)]);
});

test('cube text is bounded and 1D looks are refused', () => {
  assert.throws(() => parseCube('LUT_1D_SIZE 4\n0 0 0\n'), /3D/);
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n'), /needs 8/);
  assert.throws(() => parseCube('LUT_3D_SIZE 200\n'), /from 2 to 65/);
  assert.throws(() => parseCube('MYSTERY 1\n'), /Unknown/);
});

test('every named look is a 17-point cube that changes a mid grey', () => {
  for (const name of LOOK_NAMES) {
    const look = namedLook(name);
    assert.equal(look.size, 17);
    const graded = displayColor([0.18, 0.18, 0.18], { look });
    const plain = displayColor([0.18, 0.18, 0.18]);
    assert.ok(graded.some((value, channel) => Math.abs(value - plain[channel]) > 0.005), `${name} changes the picture`);
  }
  assert.throws(() => namedLook('grade.cube'), /look must be one of/);
});
