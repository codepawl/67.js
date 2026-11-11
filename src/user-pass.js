import { compileProgram, fullscreenVertex } from './gl-program.js';
import {
  SNIPPET_LIMITS, requireKnownFields, validateShaderSnippet, validateSnippetUniforms, snippetUniformDeclarations, mapShaderInfoLog,
} from './shader-snippet-validator.js';
import { MAXIMUM_MASK_OBJECTS, resolveObjectNames, objectIdentifierSlots, unbindMask } from './post-mask.js';

// User post-process passes: fragment snippets that run on the finished frame, after the stock effects, the grade and the
// view transform, as the last step before the canvas. The core renderer carries nothing for them. installUserPasses wraps
// resolveFrame, copies the finished frame into a texture, runs each pass in order and draws the last one to the canvas.
// A snippet is checked by shader-snippet-validator.js before it is ever compiled.

/** Names the engine provides to a snippet; a uniform cannot take one. */
export const USER_PASS_INPUTS = Object.freeze(['sceneColor', 'sceneDepth', 'resolution', 'time', 'depthAt', 'worldPointAt', 'worldNormalAt', 'objectSlotAt', 'sceneObjectIds', 'userPass']);
export const USER_PASS_SCALE = Object.freeze({ min: 0.05, max: 1 });
const PASS_NAME_PATTERN = /^[a-z][A-Za-z0-9-]{0,31}$/;
const PASS_FIELDS = ['name', 'fragment', 'uniforms', 'scale', 'objects'];
const ENTRY_FUNCTION = Object.freeze({ pattern: /\bvec4\s+userPass\s*\(\s*vec2\s+[A-Za-z_]\w*\s*\)\s*\{/, example: 'vec4 userPass(vec2 uv) { return texture(sceneColor, uv); }' });

/**
 * Checks a list of passes and returns it normalized: uniforms as { name: { type, value } }, scale filled in. Throws on the
 * first problem with a message that names the pass, the line and column, and a fix.
 */
export function normalizeUserPasses(input) {
  if (!Array.isArray(input)) throw new TypeError('postPasses must be an array of { name, fragment, uniforms, scale }. Fix: send [] to clear it.');
  if (input.length > SNIPPET_LIMITS.maxPasses) {
    throw new RangeError(`postPasses holds ${input.length} passes; the limit is ${SNIPPET_LIMITS.maxPasses}. Fix: merge passes, or draw several effects in one fragment.`);
  }
  const names = new Set();
  return input.map((entry, index) => {
    requireKnownFields(entry, PASS_FIELDS, `postPasses[${index}]`);
    if (typeof entry.name !== 'string' || !PASS_NAME_PATTERN.test(entry.name)) {
      throw new RangeError(`postPasses[${index}].name must match ${PASS_NAME_PATTERN}. Fix: a lowercase letter, then letters, digits or hyphens, 32 characters at most.`);
    }
    if (names.has(entry.name)) throw new RangeError(`Pass name "${entry.name}" is used twice. Fix: give each pass its own name.`);
    names.add(entry.name);
    const scale = entry.scale ?? 1;
    if (typeof scale !== 'number' || !(scale >= USER_PASS_SCALE.min && scale <= USER_PASS_SCALE.max)) {
      throw new RangeError(`Post pass "${entry.name}" scale must be between ${USER_PASS_SCALE.min} and ${USER_PASS_SCALE.max}. Fix: 0.25 renders at a quarter of the width and height.`);
    }
    validateShaderSnippet(entry.fragment, { label: `Post pass "${entry.name}" fragment`, requiredFunction: ENTRY_FUNCTION });
    const uniforms = validateSnippetUniforms(entry.uniforms, { label: `Post pass "${entry.name}"`, reservedNames: USER_PASS_INPUTS });
    const normalized = { name: entry.name, fragment: entry.fragment, uniforms, scale };
    if (entry.objects !== undefined) normalized.objects = resolveObjectNames(entry.objects, `postPasses[${index}].objects`);
    return normalized;
  });
}

/** What scene_capabilities reports under postPasses; it lives here so the scene entry does not carry the text. */
export const USER_PASS_CAPABILITIES = Object.freeze({
  fields: 'name, fragment (defines vec4 userPass(vec2 uv)), uniforms, scale 0.05-1 (1), objects (1-16 part names)',
  inputs: 'sceneColor, sceneDepth (sampler2D), resolution (vec2, this pass), time (s), depthAt(uv), worldPointAt(uv), worldNormalAt(uv, from depth), objectSlotAt(uv) (position of the part under uv in the pass objects list, or -1); gl_FragCoord',
  uniforms: 'a number is float, [x,y(,z(,w))] is vec2-4, {type:"int",value} is int; name ^[a-z][A-Za-z0-9]{0,31}$',
  rules: 'no # lines, while, do, uniform/layout declarations, gl_ names but gl_FragCoord, or u67_ names; for loops only as for (int i = 0; i < N; i++) { } with literal bounds, 64 iterations at most, loop work under 4096',
  limits: Object.freeze({ maxPasses: SNIPPET_LIMITS.maxPasses, maxBytes: SNIPPET_LIMITS.maxBytes, maxUniforms: SNIPPET_LIMITS.maxUniforms, maxLoopIterations: SNIPPET_LIMITS.maxLoopIterations, maxLoopWork: SNIPPET_LIMITS.maxLoopWork }),
  notes: 'Passes run in order on the finished frame; scale under 1 renders smaller and enlarges with nearest filtering. A compile error returns the log with snippet line numbers (renderError); the scene stays. Stills and render jobs apply them; the path tracer does not. docs/user-passes.md',
});

/** What scene_inspect reports for each pass. */
export function describeUserPasses(passes) {
  return passes.map(pass => ({
    name: pass.name,
    scale: pass.scale,
    ...(pass.objects ? { objects: pass.objects } : {}),
    uniforms: Object.entries(pass.uniforms).map(([name, { type }]) => `${name}:${type}`),
    fragmentBytes: pass.fragment.length,
  }));
}

const FRAGMENT_HEADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 textureCoordinate;
uniform sampler2D sceneColor;
uniform sampler2D sceneDepth;
uniform mat4 u67_inverseViewProjection;
uniform vec2 resolution;
uniform float time;
uniform sampler2D sceneObjectIds;
uniform int u67_objectCount;
uniform int u67_objectIds[${MAXIMUM_MASK_OBJECTS}];
uniform int u67_objectSlots[${MAXIMUM_MASK_OBJECTS}];
out vec4 u67_output;
float depthAt(vec2 uv) { return texture(sceneDepth, uv).r; }
vec3 worldPointAt(vec2 uv) {
  vec4 point = u67_inverseViewProjection * vec4(uv * 2.0 - 1.0, depthAt(uv) * 2.0 - 1.0, 1.0);
  return point.xyz / point.w;
}
// Which entry of the pass objects list is under uv: -1 for the background, a part not in the list, or a pass with no objects.
int objectSlotAt(vec2 uv) {
  if (u67_objectCount == 0) return -1;
  vec3 idBytes = floor(texelFetch(sceneObjectIds, ivec2(uv * vec2(textureSize(sceneObjectIds, 0))), 0).rgb * 255.0 + 0.5);
  int identifier = int(idBytes.r + idBytes.g * 256.0 + idBytes.b * 65536.0);
  for (int slot = 0; slot < ${MAXIMUM_MASK_OBJECTS}; slot++) {
    if (slot >= u67_objectCount) break;
    if (u67_objectIds[slot] == identifier) return u67_objectSlots[slot];
  }
  return -1;
}
// Normal from the depth buffer: the cross product of the smaller step in x and in y, facing the camera.
vec3 worldNormalAt(vec2 uv) {
  vec2 texel = 1.0 / vec2(textureSize(sceneDepth, 0));
  vec3 center = worldPointAt(uv);
  vec3 right = worldPointAt(uv + vec2(texel.x, 0.0)) - center;
  vec3 left = center - worldPointAt(uv - vec2(texel.x, 0.0));
  vec3 up = worldPointAt(uv + vec2(0.0, texel.y)) - center;
  vec3 down = center - worldPointAt(uv - vec2(0.0, texel.y));
  vec3 normal = cross(dot(right, right) < dot(left, left) ? right : left, dot(up, up) < dot(down, down) ? up : down);
  float size = length(normal);
  return size > 1e-12 ? normal / size : vec3(0.0, 1.0, 0.0);
}
`;
const FRAGMENT_FOOTER = '\nvoid main() { u67_output = userPass(textureCoordinate); }\n';

/** The full fragment source of a normalized pass, and how many lines come before the snippet. */
export function buildPassFragment(pass) {
  const { source: snippet } = validateShaderSnippet(pass.fragment, { label: `Post pass "${pass.name}" fragment`, requiredFunction: ENTRY_FUNCTION });
  const header = `${FRAGMENT_HEADER}${snippetUniformDeclarations(pass.uniforms)}\n`;
  return { source: `${header}${snippet}${FRAGMENT_FOOTER}`, headerLines: header.split('\n').length - 1, snippet };
}

const copyFragment = `#version 300 es
precision highp float;
in vec2 textureCoordinate;
uniform sampler2D sourceTexture;
out vec4 outputColor;
void main() { outputColor = texture(sourceTexture, textureCoordinate); }`;

function createTexture(context, width, height, filter, withAlpha = true) {
  const texture = context.createTexture();
  context.bindTexture(context.TEXTURE_2D, texture);
  context.texImage2D(context.TEXTURE_2D, 0, withAlpha ? context.RGBA8 : context.RGB8, width, height, 0, withAlpha ? context.RGBA : context.RGB, context.UNSIGNED_BYTE, null);
  for (const parameter of [context.TEXTURE_MIN_FILTER, context.TEXTURE_MAG_FILTER]) context.texParameteri(context.TEXTURE_2D, parameter, filter);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
  return texture;
}

function createTarget(context, width, height) {
  // Nearest, so a pass rendered at a lower scale is enlarged into hard pixels by whatever reads it.
  const texture = createTexture(context, width, height, context.NEAREST);
  const framebuffer = context.createFramebuffer();
  context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
  context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
  if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) {
    throw new Error('Post pass framebuffer allocation failed. Fix: lower the pass scale or the render size.');
  }
  return { texture, framebuffer, width, height };
}

function setUniformValue(context, location, { type, value }) {
  if (type === 'float') context.uniform1f(location, value);
  else if (type === 'int') context.uniform1i(location, value);
  else if (type === 'vec2') context.uniform2fv(location, value);
  else if (type === 'vec3') context.uniform3fv(location, value);
  else context.uniform4fv(location, value);
}

function compilationError(pass, error, built) {
  const log = error.message.replace(/^Shader (compilation|linking) failed: /, '');
  const mapped = mapShaderInfoLog(log, { headerLines: built.headerLines, snippet: built.snippet });
  return new Error(`Post pass "${pass.name}" failed to compile as GLSL ES 3.00. Line numbers refer to your fragment snippet.\n${mapped}`);
}

/**
 * Adds user passes to a renderer. `renderer.userPasses.set(passes)` takes the list `normalizeUserPasses` accepts (a bare
 * number is a float, an array a vec2 to vec4); `set([])` removes them. A pass reads `sceneColor` (the finished frame, or the
 * previous pass), `sceneDepth` (needs depth: true on the renderer; reads 1 without it), `resolution` (this pass's size in
 * pixels), `time`, and the helpers depthAt, worldPointAt and worldNormalAt (a normal derived from the depth). Setting new
 * uniform values does not recompile; a new fragment does, on the next frame, and a compile failure throws from that frame.
 */
export function installUserPasses(renderer) {
  if (renderer.userPasses) return renderer;
  const state = { passes: [], key: '[]', entries: [], capture: null, copy: null };
  const builtByPass = new WeakMap();

  function releaseEntryTarget(context, entry) {
    if (!entry.target) return;
    context.deleteTexture(entry.target.texture);
    context.deleteFramebuffer(entry.target.framebuffer);
    entry.target = null;
  }

  function releaseEntry(context, entry) {
    releaseEntryTarget(context, entry);
    context.deleteProgram(entry.program);
  }

  function releaseTargets(context) {
    if (state.capture) context.deleteTexture(state.capture.texture);
    state.capture = null;
    state.entries.forEach(entry => releaseEntryTarget(context, entry));
  }

  function dispose(context) {
    releaseTargets(context);
    state.entries.forEach(entry => context.deleteProgram(entry.program));
    state.entries = [];
    if (state.copy) context.deleteProgram(state.copy.program);
    state.copy = null;
  }

  // One compiled program per pass, rebuilt only when its fragment or its uniform declarations change.
  function compiledEntries() {
    const context = renderer.context;
    state.entries.slice(state.passes.length).forEach(entry => releaseEntry(context, entry));
    state.entries.length = Math.min(state.entries.length, state.passes.length);
    state.passes.forEach((pass, index) => {
      if (!builtByPass.has(pass)) builtByPass.set(pass, buildPassFragment(pass));
      const built = builtByPass.get(pass);
      const entry = state.entries[index];
      if (entry?.source === built.source) {
        entry.pass = pass;
        return;
      }
      let program;
      try {
        program = compileProgram(context, fullscreenVertex, built.source);
      } catch (error) {
        throw compilationError(pass, error, built);
      }
      if (entry) releaseEntry(context, entry);
      const names = ['sceneColor', 'sceneDepth', 'sceneObjectIds', 'u67_objectCount', 'u67_objectIds', 'u67_objectSlots', 'u67_inverseViewProjection', 'resolution', 'time', ...Object.keys(pass.uniforms)];
      state.entries[index] = {
        pass, source: built.source, program, target: null,
        locations: Object.fromEntries(names.map(name => [name, context.getUniformLocation(program, name)])),
      };
    });
    return state.entries;
  }

  function captureFinishedFrame(width, height) {
    const context = renderer.context;
    if (state.capture && (state.capture.width !== width || state.capture.height !== height)) {
      context.deleteTexture(state.capture.texture);
      state.capture = null;
    }
    // A copy from the canvas needs a texture format the canvas has: without an alpha channel it has none either.
    const withAlpha = Boolean(context.getContextAttributes()?.alpha);
    state.capture ??= { texture: createTexture(context, width, height, context.LINEAR, withAlpha), width, height };
    context.bindFramebuffer(context.FRAMEBUFFER, null);
    context.bindTexture(context.TEXTURE_2D, state.capture.texture);
    context.copyTexSubImage2D(context.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
    return state.capture.texture;
  }

  function targetFor(entry, width, height) {
    if (entry.target && (entry.target.width !== width || entry.target.height !== height)) releaseEntryTarget(renderer.context, entry);
    entry.target ??= createTarget(renderer.context, width, height);
    return entry.target;
  }

  function drawPass(entry, inputTexture, width, height, frame) {
    const context = renderer.context;
    const { locations, pass } = entry;
    context.viewport(0, 0, width, height);
    context.useProgram(entry.program);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, inputTexture);
    context.uniform1i(locations.sceneColor, 0);
    context.activeTexture(context.TEXTURE1);
    context.bindTexture(context.TEXTURE_2D, renderer.depthTexture ?? renderer.whiteTexture);
    context.uniform1i(locations.sceneDepth, 1);
    context.uniformMatrix4fv(locations.u67_inverseViewProjection, false, renderer.inverseViewProjection);
    context.uniform2f(locations.resolution, width, height);
    context.uniform1f(locations.time, frame.time ?? 0);
    for (const [name, uniform] of Object.entries(pass.uniforms)) setUniformValue(context, locations[name], uniform);
    const { identifiers, slots } = pass.objects ? objectIdentifierSlots(renderer, pass.objects) : { identifiers: [], slots: [] };
    context.uniform1i(locations.u67_objectCount, identifiers.length);
    if (identifiers.length > 0) {
      const padded = new Int32Array(MAXIMUM_MASK_OBJECTS);
      padded.set(identifiers);
      context.uniform1iv(locations.u67_objectIds, padded);
      const paddedSlots = new Int32Array(MAXIMUM_MASK_OBJECTS);
      paddedSlots.set(slots);
      context.uniform1iv(locations.u67_objectSlots, paddedSlots);
      context.activeTexture(context.TEXTURE2);
      context.bindTexture(context.TEXTURE_2D, renderer.passSupport.texture);
      context.uniform1i(locations.sceneObjectIds, 2);
    }
    context.drawArrays(context.TRIANGLES, 0, 3);
    // The next frame draws into the object ID target, so it must not stay bound as a texture.
    if (identifiers.length > 0) unbindMask(context);
  }

  function copyToCanvas(texture, width, height) {
    const context = renderer.context;
    if (!state.copy) {
      const program = compileProgram(context, fullscreenVertex, copyFragment);
      state.copy = { program, texture: context.getUniformLocation(program, 'sourceTexture') };
    }
    context.bindFramebuffer(context.FRAMEBUFFER, null);
    context.viewport(0, 0, width, height);
    context.useProgram(state.copy.program);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, texture);
    context.uniform1i(state.copy.texture, 0);
    context.drawArrays(context.TRIANGLES, 0, 3);
  }

  function runPasses(frame) {
    const context = renderer.context;
    const { width, height } = renderer.canvas;
    const entries = compiledEntries();
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.disable(context.BLEND);
    context.bindVertexArray(null);
    let input = captureFinishedFrame(width, height);
    let drewToCanvas = false;
    entries.forEach((entry, index) => {
      const directToCanvas = index === entries.length - 1 && entry.pass.scale === 1;
      const passWidth = directToCanvas ? width : Math.max(1, Math.round(width * entry.pass.scale));
      const passHeight = directToCanvas ? height : Math.max(1, Math.round(height * entry.pass.scale));
      const target = directToCanvas ? null : targetFor(entry, passWidth, passHeight);
      context.bindFramebuffer(context.FRAMEBUFFER, target?.framebuffer ?? null);
      drawPass(entry, input, passWidth, passHeight, frame);
      input = target?.texture;
      drewToCanvas = directToCanvas;
    });
    if (!drewToCanvas) copyToCanvas(input, width, height);
  }

  const resolveFrame = renderer.resolveFrame;
  renderer.resolveFrame = function resolveFrameWithUserPasses(frame, ...rest) {
    resolveFrame.call(this, frame, ...rest);
    if (state.passes.length > 0 && !this.benchmark) runPasses(frame);
  };
  // Only the lifecycle: the passes run after the final draw, not between the stock stages.
  renderer.postStages.push({ name: 'User passes', apply: () => null, releaseTargets, dispose });
  renderer.userPasses = {
    set(passes) {
      const key = JSON.stringify(passes);
      if (key === state.key) return;
      state.passes = normalizeUserPasses(passes);
      state.key = key;
    },
    get passes() {
      return structuredClone(state.passes);
    },
  };
  return renderer;
}
