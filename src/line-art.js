import './toon-shader.js';

// gl-program.js is not imported on purpose: this module loads on demand, and sharing a module with the scene entry makes
// the bundler hoist the shared code into the entry chunk (measured: about 350 bytes gzip on entry:agent-scene).
const fullscreenVertex = `#version 300 es
precision highp float;
out vec2 textureCoordinate;
void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  textureCoordinate = position;
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

function compileShader(context, kind, source) {
  const shader = context.createShader(kind);
  context.shaderSource(shader, source);
  context.compileShader(shader);
  if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
    throw new Error(`Line art shader compilation failed: ${context.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function compileProgram(context, vertexSource, fragmentSource) {
  const program = context.createProgram();
  context.attachShader(program, compileShader(context, context.VERTEX_SHADER, vertexSource));
  context.attachShader(program, compileShader(context, context.FRAGMENT_SHADER, fragmentSource));
  context.linkProgram(program);
  if (!context.getProgramParameter(program, context.LINK_STATUS)) {
    throw new Error(`Line art shader linking failed: ${context.getProgramInfoLog(program)}`);
  }
  return program;
}

// Outlines, toon light and screen-width lines as one addon. Nothing here is in the core renderer: installLineArt adds a
// post stage and wraps render, and a frame draws lines only when it carries `frame.lines` (the resolved
// `environment.lines` of a recipe). Without that field render runs untouched, so a scene without lines is unchanged.
//
// Outlines come from three guides: the object ID pass (part boundaries and silhouettes), the normal pass (creases) and
// the depth of the frame (one surface in front of another). The ID and normal guides are drawn by render passes
// (render-passes.js, installed first) just before the frame, which costs two extra draws of the opaque geometry.
// The line width is in output pixels, so a 4K still and a preview carry lines of the same thickness.

export const LINE_ART_DEFAULTS = Object.freeze({
  width: 1.5,
  color: Object.freeze([0.02, 0.02, 0.02]),
  boundaries: true,
  creaseAngle: 35,
  depthJump: 0.08,
  toon: 0,
});

export const LINE_ART_LIMITS = Object.freeze({
  width: Object.freeze([0.25, 16]),
  color: Object.freeze([0, 4]),
  creaseAngle: Object.freeze([0, 180]),
  depthJump: Object.freeze([0, 10]),
  toon: Object.freeze([0, 8]),
  maxPolylines: 64,
  minPolylinePoints: 2,
  maxPolylinePoints: 256,
  maxPolylineSegments: 4096,
  coordinate: 1e6,
});

const LINE_ART_FIELDS = [...Object.keys(LINE_ART_DEFAULTS), 'polylines'];
const POLYLINE_FIELDS = ['points', 'color', 'width', 'depthTest', 'closed'];
const OUTLINE_RING_LIMIT = Math.ceil(LINE_ART_LIMITS.width[1] / 2);

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be a JSON object.`);
}

function onlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length > 0) throw new RangeError(`${label} has unknown ${unknown.length === 1 ? 'field' : 'fields'}: ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}.`);
}

function numberWithin(value, [minimum, maximum], label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a number between ${minimum} and ${maximum}.`);
  }
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be true or false.`);
  return value;
}

function colorValue(value, label) {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${label} must be three linear RGB numbers [red, green, blue].`);
  return value.map((component, index) => numberWithin(component, LINE_ART_LIMITS.color, `${label}[${index}]`));
}

function pointValue(value, label) {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${label} must be a point [x, y, z].`);
  const limit = LINE_ART_LIMITS.coordinate;
  return value.map((component, index) => numberWithin(component, [-limit, limit], `${label}[${index}]`));
}

function polylineFrom(input, index, defaults) {
  const label = `lines.polylines[${index}]`;
  plainObject(input, label);
  onlyKeys(input, POLYLINE_FIELDS, label);
  const count = Array.isArray(input.points) ? input.points.length : 0;
  if (count < LINE_ART_LIMITS.minPolylinePoints || count > LINE_ART_LIMITS.maxPolylinePoints) {
    throw new RangeError(`${label}.points needs ${LINE_ART_LIMITS.minPolylinePoints} to ${LINE_ART_LIMITS.maxPolylinePoints} points.`);
  }
  return {
    points: input.points.map((point, pointIndex) => pointValue(point, `${label}.points[${pointIndex}]`)),
    color: colorValue(input.color ?? defaults.color, `${label}.color`),
    width: numberWithin(input.width ?? defaults.width, LINE_ART_LIMITS.width, `${label}.width`),
    depthTest: booleanValue(input.depthTest ?? true, `${label}.depthTest`),
    closed: booleanValue(input.closed ?? false, `${label}.closed`),
  };
}

function segmentCount(polyline) {
  return polyline.points.length - 1 + (polyline.closed ? 1 : 0);
}

/**
 * Checks `environment.lines` and returns it with every default filled in, so the same input gives the same lines.
 * Throws a RangeError or TypeError that names the field.
 */
export function resolveLineArt(input = {}) {
  plainObject(input, 'lines');
  onlyKeys(input, LINE_ART_FIELDS, 'lines');
  const resolved = {
    width: numberWithin(input.width ?? LINE_ART_DEFAULTS.width, LINE_ART_LIMITS.width, 'lines.width'),
    color: colorValue(input.color ?? LINE_ART_DEFAULTS.color, 'lines.color'),
    boundaries: booleanValue(input.boundaries ?? LINE_ART_DEFAULTS.boundaries, 'lines.boundaries'),
    creaseAngle: numberWithin(input.creaseAngle ?? LINE_ART_DEFAULTS.creaseAngle, LINE_ART_LIMITS.creaseAngle, 'lines.creaseAngle'),
    depthJump: numberWithin(input.depthJump ?? LINE_ART_DEFAULTS.depthJump, LINE_ART_LIMITS.depthJump, 'lines.depthJump'),
    toon: numberWithin(input.toon ?? LINE_ART_DEFAULTS.toon, LINE_ART_LIMITS.toon, 'lines.toon'),
  };
  if (input.polylines !== undefined) {
    if (!Array.isArray(input.polylines) || input.polylines.length > LINE_ART_LIMITS.maxPolylines) {
      throw new RangeError(`lines.polylines must be a list of at most ${LINE_ART_LIMITS.maxPolylines} polylines.`);
    }
    resolved.polylines = input.polylines.map((polyline, index) => polylineFrom(polyline, index, resolved));
    const segments = resolved.polylines.reduce((total, polyline) => total + segmentCount(polyline), 0);
    if (segments > LINE_ART_LIMITS.maxPolylineSegments) {
      throw new RangeError(`lines.polylines hold ${segments} segments; the limit is ${LINE_ART_LIMITS.maxPolylineSegments}.`);
    }
  }
  return resolved;
}

function drawsOutlines(lines) {
  return lines.boundaries || lines.creaseAngle > 0 || lines.depthJump > 0;
}

// Both guides read the same texel as the frame, so every lookup is a texel fetch at an integer pixel.
const outlineFragment = `#version 300 es
precision highp float;
uniform sampler2D sourceTexture;
uniform sampler2D sceneDepth;
uniform sampler2D partTexture;
uniform sampler2D normalTexture;
uniform vec3 projectionDepth;
uniform float halfWidth;
uniform vec3 lineColor;
uniform float useBoundaries;
uniform float creaseCosine;
uniform float depthJump;
out vec4 outputColor;
ivec2 lastPixel;
vec3 partAt(ivec2 pixel) { return texelFetch(partTexture, clamp(pixel, ivec2(0), lastPixel), 0).rgb; }
vec3 normalAt(ivec2 pixel) { return normalize(texelFetch(normalTexture, clamp(pixel, ivec2(0), lastPixel), 0).rgb * 2.0 - 1.0); }
float depthAt(ivec2 pixel) {
  float ndc = texelFetch(sceneDepth, clamp(pixel, ivec2(0), lastPixel), 0).r * 2.0 - 1.0;
  return projectionDepth.z > 0.5 ? -(ndc - projectionDepth.y) / projectionDepth.x : (ndc + projectionDepth.x) / projectionDepth.y;
}
bool hasPart(vec3 part) { return dot(part, vec3(1.0)) > 0.0; }
bool differs(ivec2 center, ivec2 other, vec3 centerPart, vec3 centerNormal) {
  vec3 otherPart = partAt(other);
  if (useBoundaries > 0.5 && dot(abs(otherPart - centerPart), vec3(1.0)) > 0.001) return true;
  if (creaseCosine > -1.5 && hasPart(centerPart) && hasPart(otherPart) && dot(centerNormal, normalAt(other)) < creaseCosine) return true;
  return false;
}
bool depthEdge(ivec2 center, ivec2 offset, float centerDepth) {
  float jump = abs(depthAt(center + offset) + depthAt(center - offset) - 2.0 * centerDepth);
  return jump > depthJump * abs(centerDepth);
}
bool ringHasEdge(ivec2 center, int ring, vec3 centerPart, vec3 centerNormal, float centerDepth) {
  int diagonal = max(1, int(round(float(ring) * 0.70710678)));
  ivec2 offsets[4] = ivec2[4](ivec2(ring, 0), ivec2(0, ring), ivec2(diagonal, diagonal), ivec2(diagonal, -diagonal));
  for (int index = 0; index < 4; index++) {
    ivec2 offset = offsets[index];
    if (differs(center, center + offset, centerPart, centerNormal) || differs(center, center - offset, centerPart, centerNormal)) return true;
    if (depthJump > 0.0 && depthEdge(center, offset, centerDepth)) return true;
  }
  return false;
}
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  lastPixel = textureSize(sourceTexture, 0) - 1;
  vec4 source = texelFetch(sourceTexture, pixel, 0);
  vec3 centerPart = partAt(pixel);
  vec3 centerNormal = normalAt(pixel);
  float centerDepth = depthAt(pixel);
  float fullRings = floor(halfWidth);
  float partial = halfWidth - fullRings;
  float coverage = 0.0;
  for (int ring = 1; ring <= ${OUTLINE_RING_LIMIT}; ring++) {
    if (float(ring) > ceil(halfWidth)) break;
    if (ringHasEdge(pixel, ring, centerPart, centerNormal, centerDepth)) {
      coverage = float(ring) <= fullRings ? 1.0 : partial;
      break;
    }
  }
  outputColor = vec4(source.rgb * (1.0 - coverage) + lineColor * coverage, source.a * (1.0 - coverage) + coverage);
}`;

const polylineVertex = `#version 300 es
precision highp float;
uniform mat4 viewProjection;
uniform vec2 resolution;
uniform float lineWidth;
in vec3 startPoint;
in vec3 endPoint;
out vec2 localPixel;
flat out float segmentLength;
const float NEAR_W = 0.001;
void main() {
  vec4 startClip = viewProjection * vec4(startPoint, 1.0);
  vec4 endClip = viewProjection * vec4(endPoint, 1.0);
  if (startClip.w < NEAR_W && endClip.w < NEAR_W) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    localPixel = vec2(0.0);
    segmentLength = 0.0;
    return;
  }
  if (startClip.w < NEAR_W) startClip = mix(startClip, endClip, (NEAR_W - startClip.w) / (endClip.w - startClip.w));
  if (endClip.w < NEAR_W) endClip = mix(endClip, startClip, (NEAR_W - endClip.w) / (startClip.w - endClip.w));
  vec2 startPixel = startClip.xy / startClip.w * resolution * 0.5;
  vec2 endPixel = endClip.xy / endClip.w * resolution * 0.5;
  float segmentPixels = distance(startPixel, endPixel);
  vec2 along = segmentPixels > 0.0001 ? (endPixel - startPixel) / segmentPixels : vec2(1.0, 0.0);
  vec2 across = vec2(-along.y, along.x);
  float margin = lineWidth * 0.5 + 1.0;
  bool atEnd = gl_VertexID == 1 || gl_VertexID == 4 || gl_VertexID == 5;
  bool upper = gl_VertexID == 2 || gl_VertexID == 3 || gl_VertexID == 5;
  float lengthwise = atEnd ? segmentPixels + margin : -margin;
  float sideways = upper ? margin : -margin;
  vec4 anchor = atEnd ? endClip : startClip;
  vec2 pixel = (atEnd ? endPixel : startPixel) + along * (atEnd ? margin : -margin) + across * sideways;
  gl_Position = vec4(pixel / (resolution * 0.5) * anchor.w, anchor.z, anchor.w);
  localPixel = vec2(lengthwise, sideways);
  segmentLength = segmentPixels;
}`;

const polylineFragment = `#version 300 es
precision highp float;
uniform sampler2D sceneDepth;
uniform vec3 projectionDepth;
uniform float lineWidth;
uniform vec3 lineColor;
uniform float depthTest;
in vec2 localPixel;
flat in float segmentLength;
out vec4 outputColor;
float eyeDepth(float depth) {
  float ndc = depth * 2.0 - 1.0;
  return projectionDepth.z > 0.5 ? -(ndc - projectionDepth.y) / projectionDepth.x : projectionDepth.y / (ndc + projectionDepth.x);
}
void main() {
  float distanceToSegment = length(vec2(localPixel.x - clamp(localPixel.x, 0.0, segmentLength), localPixel.y));
  float alpha = clamp(lineWidth * 0.5 - distanceToSegment + 0.5, 0.0, 1.0);
  if (alpha <= 0.0) discard;
  if (depthTest > 0.5) {
    float sceneDistance = eyeDepth(texelFetch(sceneDepth, ivec2(gl_FragCoord.xy), 0).r);
    if (eyeDepth(gl_FragCoord.z) > sceneDistance * 1.005 + 0.002) discard;
  }
  outputColor = vec4(lineColor * alpha, alpha);
}`;

function uniformLocations(context, program, names) {
  return Object.fromEntries(names.map(name => [name, context.getUniformLocation(program, name)]));
}

function createColorTarget(context, width, height, floatColor, filter) {
  const texture = context.createTexture();
  context.bindTexture(context.TEXTURE_2D, texture);
  context.texImage2D(context.TEXTURE_2D, 0, floatColor ? context.RGBA16F : context.RGBA8, width, height, 0, context.RGBA,
    floatColor ? context.HALF_FLOAT : context.UNSIGNED_BYTE, null);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, filter);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, filter);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
  const framebuffer = context.createFramebuffer();
  context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
  context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
  if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) {
    throw new Error('Line art framebuffer allocation failed. Choose a lower quality preset.');
  }
  return { texture, framebuffer };
}

function polylineSegments(polyline) {
  const points = polyline.points;
  const segments = new Float32Array(segmentCount(polyline) * 6);
  for (let index = 0; index < segmentCount(polyline); index++) {
    segments.set(points[index], index * 6);
    segments.set(points[(index + 1) % points.length], index * 6 + 3);
  }
  return segments;
}

function createLineArtStage(state) {
  let outlineProgram = null;
  let outlineUniforms = null;
  let polylineProgram = null;
  let polylineUniforms = null;
  let vertexArray = null;
  let outputTarget = null;
  const guideTargets = new Map();
  const segmentBuffers = new Map();

  function guideTarget(renderer, name) {
    const { context } = renderer;
    if (!guideTargets.has(name)) {
      guideTargets.set(name, createColorTarget(context, renderer.canvas.width, renderer.canvas.height, false, context.NEAREST));
    }
    return guideTargets.get(name);
  }

  // The pass target is reused by the next pass, so each guide is copied out of it into a texture of its own.
  function captureGuide(renderer, name) {
    const { context, canvas } = renderer;
    const target = guideTarget(renderer, name);
    context.bindFramebuffer(context.READ_FRAMEBUFFER, renderer.passSupport.framebuffer);
    context.bindFramebuffer(context.DRAW_FRAMEBUFFER, target.framebuffer);
    context.blitFramebuffer(0, 0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height, context.COLOR_BUFFER_BIT, context.NEAREST);
  }

  function releaseTargets(context) {
    if (outputTarget) {
      context.deleteTexture(outputTarget.texture);
      context.deleteFramebuffer(outputTarget.framebuffer);
      outputTarget = null;
    }
    for (const target of guideTargets.values()) {
      context.deleteTexture(target.texture);
      context.deleteFramebuffer(target.framebuffer);
    }
    guideTargets.clear();
  }

  function releaseSegmentBuffers(context, keep = new Set()) {
    for (const [key, entry] of segmentBuffers) {
      if (keep.has(key)) continue;
      context.deleteBuffer(entry.buffer);
      segmentBuffers.delete(key);
    }
  }

  function dispose(context) {
    releaseTargets(context);
    releaseSegmentBuffers(context);
    if (outlineProgram) context.deleteProgram(outlineProgram);
    if (polylineProgram) context.deleteProgram(polylineProgram);
    if (vertexArray) context.deleteVertexArray(vertexArray);
    outlineProgram = null;
    polylineProgram = null;
    vertexArray = null;
  }

  function projectionDepth(renderer) {
    const projection = renderer.projection;
    const orthographic = projection[15] === 1;
    return [projection[10], projection[14], orthographic ? 1 : 0];
  }

  function drawOutlines(renderer, lines, sourceTexture) {
    const { context } = renderer;
    if (!outlineProgram) {
      outlineProgram = compileProgram(context, fullscreenVertex, outlineFragment);
      outlineUniforms = uniformLocations(context, outlineProgram, ['sourceTexture', 'sceneDepth', 'partTexture', 'normalTexture',
        'projectionDepth', 'halfWidth', 'lineColor', 'useBoundaries', 'creaseCosine', 'depthJump']);
    }
    context.useProgram(outlineProgram);
    const bindings = [[sourceTexture, 'sourceTexture'], [renderer.depthTexture, 'sceneDepth'], [guideTarget(renderer, 'part').texture, 'partTexture'], [guideTarget(renderer, 'normal').texture, 'normalTexture']];
    bindings.forEach(([texture, uniform], unit) => {
      context.activeTexture(context.TEXTURE0 + unit);
      context.bindTexture(context.TEXTURE_2D, texture);
      context.uniform1i(outlineUniforms[uniform], unit);
    });
    context.uniform3fv(outlineUniforms.projectionDepth, projectionDepth(renderer));
    context.uniform1f(outlineUniforms.halfWidth, lines.width / 2);
    context.uniform3fv(outlineUniforms.lineColor, lines.color);
    context.uniform1f(outlineUniforms.useBoundaries, lines.boundaries ? 1 : 0);
    context.uniform1f(outlineUniforms.creaseCosine, lines.creaseAngle > 0 ? Math.cos(lines.creaseAngle * Math.PI / 180) : -2);
    context.uniform1f(outlineUniforms.depthJump, lines.depthJump);
    context.drawArrays(context.TRIANGLES, 0, 3);
  }

  function segmentBufferFor(context, polyline) {
    const key = JSON.stringify([polyline.points, polyline.closed]);
    let entry = segmentBuffers.get(key);
    if (!entry) {
      const segments = polylineSegments(polyline);
      const buffer = context.createBuffer();
      context.bindBuffer(context.ARRAY_BUFFER, buffer);
      context.bufferData(context.ARRAY_BUFFER, segments, context.STATIC_DRAW);
      entry = { buffer, count: segments.length / 6 };
      segmentBuffers.set(key, entry);
    }
    return { key, ...entry };
  }

  function drawPolylines(renderer, polylines) {
    const { context, canvas } = renderer;
    if (!polylineProgram) {
      polylineProgram = compileProgram(context, polylineVertex, polylineFragment);
      polylineUniforms = uniformLocations(context, polylineProgram, ['viewProjection', 'resolution', 'lineWidth', 'sceneDepth',
        'projectionDepth', 'lineColor', 'depthTest']);
      vertexArray = context.createVertexArray();
    }
    context.useProgram(polylineProgram);
    context.bindVertexArray(vertexArray);
    context.enable(context.BLEND);
    context.blendFuncSeparate(context.ONE, context.ONE_MINUS_SRC_ALPHA, context.ONE, context.ONE_MINUS_SRC_ALPHA);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, renderer.depthTexture);
    context.uniform1i(polylineUniforms.sceneDepth, 0);
    context.uniformMatrix4fv(polylineUniforms.viewProjection, false, renderer.viewProjection);
    context.uniform2f(polylineUniforms.resolution, canvas.width, canvas.height);
    context.uniform3fv(polylineUniforms.projectionDepth, projectionDepth(renderer));
    const startLocation = context.getAttribLocation(polylineProgram, 'startPoint');
    const endLocation = context.getAttribLocation(polylineProgram, 'endPoint');
    const used = new Set();
    for (const polyline of polylines) {
      const { key, buffer, count } = segmentBufferFor(context, polyline);
      used.add(key);
      context.bindBuffer(context.ARRAY_BUFFER, buffer);
      for (const [location, offset] of [[startLocation, 0], [endLocation, 12]]) {
        context.enableVertexAttribArray(location);
        context.vertexAttribPointer(location, 3, context.FLOAT, false, 24, offset);
        context.vertexAttribDivisor(location, 1);
      }
      context.uniform1f(polylineUniforms.lineWidth, polyline.width);
      context.uniform3fv(polylineUniforms.lineColor, polyline.color);
      context.uniform1f(polylineUniforms.depthTest, polyline.depthTest ? 1 : 0);
      context.drawArraysInstanced(context.TRIANGLES, 0, 6, count);
    }
    releaseSegmentBuffers(context, used);
    context.disable(context.BLEND);
    context.bindVertexArray(null);
  }

  // Draws the outlines, then the polylines, into a target of its own; null leaves the frame as it is.
  function apply(renderer, frame, effects, sourceTexture) {
    const lines = state.lines;
    if (!lines) return null;
    const outlines = drawsOutlines(lines);
    const polylines = lines.polylines?.length > 0;
    if (!outlines && !polylines) return null;
    if (!renderer.depthTexture) throw new Error('Line art requires depth:true on the renderer.');
    const { context, canvas } = renderer;
    outputTarget ??= createColorTarget(context, canvas.width, canvas.height, renderer.hdr, context.LINEAR);
    context.bindFramebuffer(context.FRAMEBUFFER, outputTarget.framebuffer);
    context.viewport(0, 0, canvas.width, canvas.height);
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    if (outlines) {
      drawOutlines(renderer, lines, sourceTexture);
    } else {
      copyTexture(renderer, sourceTexture);
    }
    if (polylines) drawPolylines(renderer, lines.polylines);
    return outputTarget.texture;
  }

  const copyFragment = `#version 300 es
precision highp float;
uniform sampler2D sourceTexture;
out vec4 outputColor;
void main() { outputColor = texelFetch(sourceTexture, ivec2(gl_FragCoord.xy), 0); }`;
  let copyProgram = null;
  let copyUniform = null;

  function copyTexture(renderer, sourceTexture) {
    const { context } = renderer;
    if (!copyProgram) {
      copyProgram = compileProgram(context, fullscreenVertex, copyFragment);
      copyUniform = context.getUniformLocation(copyProgram, 'sourceTexture');
    }
    context.useProgram(copyProgram);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, sourceTexture);
    context.uniform1i(copyUniform, 0);
    context.drawArrays(context.TRIANGLES, 0, 3);
  }

  return {
    name: 'Line art',
    apply,
    captureGuide,
    releaseTargets,
    dispose(context) {
      dispose(context);
      if (copyProgram) context.deleteProgram(copyProgram);
      copyProgram = null;
    },
  };
}

/**
 * Adds outlines, toon light and polylines to a renderer. The renderer needs `depth: true` and installRenderPasses first.
 * A frame turns them on with `frame.lines`, an object from resolveLineArt (a recipe's `environment.lines`); a frame
 * without it draws exactly as before. Outlines draw the opaque and cutout geometry only, like render passes.
 */
export function installLineArt(renderer) {
  if (renderer.lineArt) return renderer;
  if (!renderer.passSupport) throw new Error('Line art needs installRenderPasses(renderer) from crucible/addons/render-passes first.');
  const state = { lines: null };
  const stage = createLineArtStage(state);
  renderer.postStages.push(stage);
  const drawFrame = renderer.render.bind(renderer);
  let toonBands = 0;

  // The toon uniforms are not in the core renderer's list, so the addon finds them itself after each program build.
  function locateToonUniforms() {
    for (const name of ['materialToon', 'toonDefault']) {
      renderer.uniforms[name] = renderer.context.getUniformLocation(renderer.program, name);
    }
  }

  // The default bands reach the main program as a uniform, and a rebuilt program starts again at zero.
  function pushDefaultToon() {
    if (!renderer.shaderFeatures?.has('toon')) return;
    renderer.context.useProgram(renderer.program);
    renderer.context.uniform1f(renderer.uniforms.toonDefault, toonBands);
  }

  const rebuildMainProgram = renderer.rebuildMainProgram.bind(renderer);
  renderer.rebuildMainProgram = () => {
    rebuildMainProgram();
    locateToonUniforms();
    pushDefaultToon();
  };

  function applyDefaultToon(bands) {
    toonBands = bands;
    if (bands > 0) renderer.requireFeatureNames(['toon']);
    pushDefaultToon();
  }

  function drawGuides(frame) {
    for (const [pass, name] of [['objectId', 'part'], ['normal', 'normal']]) {
      drawFrame({ ...frame, pass });
      stage.captureGuide(renderer, name);
    }
  }

  renderer.render = frame => {
    const lines = frame.lines && frame.pass === undefined && !frame.reflectionTarget && !renderer.benchmark ? frame.lines : null;
    applyDefaultToon(lines?.toon ?? 0);
    state.lines = lines;
    if (lines && drawsOutlines(lines)) drawGuides(frame);
    try {
      drawFrame(frame);
    } finally {
      state.lines = null;
    }
  };
  if (renderer.program) locateToonUniforms();
  renderer.lineArt = { resolve: resolveLineArt };
  return renderer;
}
