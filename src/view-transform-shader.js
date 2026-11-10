import { viewTransformShader } from './shader-registry.js';
import { AGX_CONSTANTS, NEUTRAL_CONSTANTS, namedLook } from './view-transform.js';
import { VIEW_TRANSFORM_NAMES, LOOK_NAMES } from './view-transform-names.js';
import { catalogLook } from './look-catalog.js';

// The GLSL of the AgX and Khronos PBR Neutral view transforms and of the look LUT. It lives outside shaders.js so a
// scene on the default curve never downloads it: the renderer asks for it only when it is given viewTransform: 'agx' or
// 'neutral', or a look, and importing this module (or loading it through loadAgentSceneModules) registers it.
// The constants are printed from view-transform.js, which the path tracer and the tests read, so the curves cannot drift.
// The renderer carries the display curve in four programs (the main fragment, the liquid fragment, the environment
// background and the HDR post pass). Each holds the ACES fit as one expression, which apply swaps for a call to
// selectedViewTransform; the look is a 3D texture read at the end of the post pass, on the display-encoded colour.

const ACES_EXPRESSION = 'clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0)';
const POST_FINISH_LINE = '  float alpha = POST_TRANSPARENT ? coverage : 1.0;';
const LOOK_TEXTURE_UNIT = 6;
const LOOK_UNIFORM = 'viewLookTexture';

const glslNumber = value => (Number.isInteger(value) ? value.toFixed(1) : String(value));
const glslVector = values => `vec3(${values.map(glslNumber).join(', ')})`;
const glslMatrix = columns => `mat3(${columns.map(glslVector).join(', ')})`;

const agxSide = ({ scale, power }) => ({ scale: glslNumber(scale), power: glslNumber(power), inversePower: glslNumber(1 / power) });
const agxToe = agxSide(AGX_CONSTANTS.toe);
const agxShoulder = agxSide(AGX_CONSTANTS.shoulder);

const AGX_GLSL = `const mat3 agxInset = ${glslMatrix(AGX_CONSTANTS.inset)};
const mat3 agxOutset = ${glslMatrix(AGX_CONSTANTS.outset)};
vec3 agxCurve(vec3 x) {
  vec3 distance = ${glslNumber(AGX_CONSTANTS.slope)} * (x - ${glslNumber(AGX_CONSTANTS.pivot[0])});
  vec3 above = max(distance, 0.0) / ${agxShoulder.scale};
  vec3 below = max(-distance, 0.0) / ${agxToe.scale};
  vec3 rise = ${agxShoulder.scale} * above / pow(1.0 + pow(above, vec3(${agxShoulder.power})), vec3(${agxShoulder.inversePower}));
  vec3 fall = ${agxToe.scale} * below / pow(1.0 + pow(below, vec3(${agxToe.power})), vec3(${agxToe.inversePower}));
  return ${glslNumber(AGX_CONSTANTS.pivot[1])} + rise - fall;
}
vec3 selectedViewTransform(vec3 color) {
  color = agxInset * color;
  color = clamp((log2(max(color, vec3(1e-10))) - ${glslNumber(AGX_CONSTANTS.minimumEv)}) / ${glslNumber(AGX_CONSTANTS.maximumEv - AGX_CONSTANTS.minimumEv)}, 0.0, 1.0);
  color = pow(max(agxCurve(color), vec3(0.0)), vec3(${glslNumber(AGX_CONSTANTS.encodingPower)}));
  return clamp(agxOutset * color, 0.0, 1.0);
}`;

const NEUTRAL_GLSL = `vec3 selectedViewTransform(vec3 color) {
  float lowest = min(color.r, min(color.g, color.b));
  float offset = lowest < 0.08 ? lowest - 6.25 * lowest * lowest : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < ${glslNumber(NEUTRAL_CONSTANTS.startCompression)}) return clamp(color, 0.0, 1.0);
  float distance = ${glslNumber(1 - NEUTRAL_CONSTANTS.startCompression)};
  float newPeak = 1.0 - distance * distance / (peak + distance - ${glslNumber(NEUTRAL_CONSTANTS.startCompression)});
  color *= newPeak / peak;
  float desaturate = 1.0 - 1.0 / (${glslNumber(NEUTRAL_CONSTANTS.desaturation)} * (peak - newPeak) + 1.0);
  return clamp(mix(color, vec3(newPeak), desaturate), 0.0, 1.0);
}`;

const LOOK_GLSL = `uniform highp sampler3D ${LOOK_UNIFORM};
vec3 applyLook(vec3 color) {
  float size = float(textureSize(${LOOK_UNIFORM}, 0).x);
  return texture(${LOOK_UNIFORM}, clamp(color, 0.0, 1.0) * ((size - 1.0) / size) + 0.5 / size).rgb;
}`;

function insertAfterPrecision(source, code) {
  const marker = 'precision highp float;';
  if (!source.includes(marker)) throw new Error('A shader that takes a view transform needs a precision statement.');
  return source.replace(marker, `${marker}\n${code}`);
}

/** The source of one program with the chosen display curve, and for the post pass the look. */
function apply(source, kind, viewTransform, hasLook) {
  if (!VIEW_TRANSFORM_NAMES.includes(viewTransform)) throw new RangeError(`viewTransform must be one of ${VIEW_TRANSFORM_NAMES.join(', ')}.`);
  let result = source;
  if (viewTransform !== 'aces') {
    if (!result.includes(ACES_EXPRESSION)) throw new Error(`The ${kind} shader no longer holds the ACES expression that a view transform replaces.`);
    result = insertAfterPrecision(result.replaceAll(ACES_EXPRESSION, 'selectedViewTransform(color)'), viewTransform === 'agx' ? AGX_GLSL : NEUTRAL_GLSL);
  }
  if (hasLook && kind === 'post') {
    if (!result.includes(POST_FINISH_LINE)) throw new Error('The post shader no longer holds the line that a look is applied before.');
    result = insertAfterPrecision(result.replace(POST_FINISH_LINE, `  color = applyLook(color);\n${POST_FINISH_LINE}`), LOOK_GLSL);
  }
  return result;
}

const lookTextures = new WeakMap();
const namedLooks = new Map();

/** A look as the renderer draws it: a name from LOOK_NAMES is built once, a parsed .cube look is used as is. */
function resolveLook(look) {
  if (typeof look !== 'string') return look;
  if (!LOOK_NAMES.includes(look)) return catalogLook(look);
  if (!namedLooks.has(look)) namedLooks.set(look, namedLook(look));
  return namedLooks.get(look);
}

function createLookTexture(context, look) {
  const { size, data } = look;
  const bytes = new Uint8Array(size ** 3 * 4);
  for (let index = 0; index < size ** 3; index++) {
    for (let channel = 0; channel < 3; channel++) bytes[index * 4 + channel] = Math.round(data[index * 3 + channel] * 255);
    bytes[index * 4 + 3] = 255;
  }
  const texture = context.createTexture();
  context.bindTexture(context.TEXTURE_3D, texture);
  context.texImage3D(context.TEXTURE_3D, 0, context.RGBA8, size, size, size, 0, context.RGBA, context.UNSIGNED_BYTE, bytes);
  context.texParameteri(context.TEXTURE_3D, context.TEXTURE_MIN_FILTER, context.LINEAR);
  context.texParameteri(context.TEXTURE_3D, context.TEXTURE_MAG_FILTER, context.LINEAR);
  for (const wrap of [context.TEXTURE_WRAP_S, context.TEXTURE_WRAP_T, context.TEXTURE_WRAP_R]) context.texParameteri(context.TEXTURE_3D, wrap, context.CLAMP_TO_EDGE);
  return texture;
}

/** Binds the renderer's look to the post program that was just made current. */
function bindLook(renderer, program) {
  const context = renderer.context;
  if (!lookTextures.has(renderer)) lookTextures.set(renderer, createLookTexture(context, renderer.look));
  context.activeTexture(context.TEXTURE0 + LOOK_TEXTURE_UNIT);
  context.bindTexture(context.TEXTURE_3D, lookTextures.get(renderer));
  context.uniform1i(context.getUniformLocation(program, LOOK_UNIFORM), LOOK_TEXTURE_UNIT);
}

function dispose(renderer) {
  if (lookTextures.has(renderer)) renderer.context.deleteTexture(lookTextures.get(renderer));
  lookTextures.delete(renderer);
}

Object.assign(viewTransformShader, { apply, bindLook, dispose, resolveLook });

export { apply as applyViewTransformToShader };
