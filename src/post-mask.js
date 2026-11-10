// A mask for the named post steps (post-steps.js): a step applies only where the mask is on. Two sources, which multiply when
// both are named: the parts listed by name, read from the object ID pass, and a range of distance along the view. The mask is
// exact per pixel, so it has hard edges where a part meets another (an object ID cannot be antialiased); a depth range softens
// its ends with `feather`. A step with no mask applies to the whole frame, as before.

export const MAXIMUM_MASK_OBJECTS = 16;
const MAXIMUM_NAME_LENGTH = 128;

function checkedNumber(value, fallback, minimum, maximum, name) {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`);
  return result;
}

function checkedKeys(group, allowed, name) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) throw new TypeError(`${name} must be an object.`);
  for (const key of Object.keys(group)) {
    if (!allowed.includes(key)) throw new TypeError(`Unknown ${name} field "${key}". Fix: use ${allowed.join(', ')}.`);
  }
}

function resolveObjectNames(objects, name) {
  if (!Array.isArray(objects) || objects.length === 0 || objects.length > MAXIMUM_MASK_OBJECTS) {
    throw new TypeError(`${name} must be a list of 1 to ${MAXIMUM_MASK_OBJECTS} part names.`);
  }
  objects.forEach((part, index) => {
    if (typeof part !== 'string' || part.length === 0 || part.length > MAXIMUM_NAME_LENGTH) {
      throw new TypeError(`${name}[${index}] must be a part name of 1 to ${MAXIMUM_NAME_LENGTH} characters. Fix: pass the node id, as the object ID pass lists it.`);
    }
  });
  return [...objects];
}

/** The mask a step names, resolved with defaults: { objects?, depth?: { near, far, feather }, invert }. */
export function resolveMask(input, name) {
  checkedKeys(input, ['objects', 'depth', 'invert'], name);
  if (input.objects === undefined && input.depth === undefined) {
    throw new TypeError(`${name} needs a source. Fix: name objects (a list of part names), depth ({ near, far, feather }), or both.`);
  }
  const mask = { invert: input.invert === true };
  if (input.invert !== undefined && typeof input.invert !== 'boolean') throw new TypeError(`${name}.invert must be true or false.`);
  if (input.objects !== undefined) mask.objects = resolveObjectNames(input.objects, `${name}.objects`);
  if (input.depth !== undefined) {
    checkedKeys(input.depth, ['near', 'far', 'feather'], `${name}.depth`);
    const near = checkedNumber(input.depth.near, 0, 0, 1e5, `${name}.depth.near`);
    const far = checkedNumber(input.depth.far, 1e5, 0, 1e5, `${name}.depth.far`);
    if (far <= near) throw new RangeError(`${name}.depth.far must be greater than near. Fix: distances are metres along the view direction.`);
    mask.depth = { near, far, feather: checkedNumber(input.depth.feather, 0, 0, 1e4, `${name}.depth.feather`) };
  }
  return mask;
}

/** Whether the object ID pass must be drawn before the lit frame: true when any resolved step masks by objects. */
export function usesObjectMask(steps) {
  return Object.values(steps).some(step => Boolean(step?.mask?.objects));
}

export const MASK_UNIFORM_NAMES = ['objectIds', 'maskObjectCount', 'maskObjectIds', 'maskUseDepth', 'maskDepth', 'maskInvert', 'maskEye', 'maskForward'];

/** GLSL for a step that takes a mask: maskAt(coordinate) is 1 where the step applies and 0 where the source shows through. */
export const maskShader = `
uniform sampler2D objectIds;
uniform int maskObjectCount;
uniform int maskObjectIds[${MAXIMUM_MASK_OBJECTS}];
uniform float maskUseDepth;
uniform vec3 maskDepth;
uniform float maskInvert;
uniform vec3 maskEye;
uniform vec3 maskForward;
float maskAt(vec2 coordinate) {
  float mask = 1.0;
  if (maskObjectCount > 0) {
    vec3 idBytes = floor(texelFetch(objectIds, ivec2(coordinate * resolution), 0).rgb * 255.0 + 0.5);
    int identifier = int(idBytes.r + idBytes.g * 256.0 + idBytes.b * 65536.0);
    float hit = 0.0;
    for (int index = 0; index < ${MAXIMUM_MASK_OBJECTS}; index++) {
      if (index >= maskObjectCount) break;
      if (maskObjectIds[index] == identifier) hit = 1.0;
    }
    mask *= hit;
  }
  if (maskUseDepth > 0.5) {
    float distanceAlongView = dot(worldPointAt(coordinate) - maskEye, maskForward);
    float feather = max(maskDepth.z, 0.0001);
    mask *= clamp((distanceAlongView - (maskDepth.x - feather)) / feather, 0.0, 1.0)
      * (1.0 - clamp((distanceAlongView - maskDepth.y) / feather, 0.0, 1.0));
  }
  return mix(mask, 1.0 - mask, maskInvert);
}
`;

function objectIdentifiers(renderer, names) {
  if (!renderer.passSupport) throw new Error('A mask by objects needs installRenderPasses(renderer) and the object ID pass drawn first.');
  const known = renderer.passSupport.objectNames();
  const identifiers = [];
  for (const name of names) {
    const matches = known.flatMap((candidate, index) => (candidate === name ? [index + 1] : []));
    if (matches.length === 0) {
      throw new Error(`Mask object "${name}" is not a part in the frame. Fix: use a part name such as ${known.slice(0, 8).map(part => `"${part}"`).join(', ') || '(the scene has no opaque parts)'}.`);
    }
    identifiers.push(...matches);
  }
  if (identifiers.length > MAXIMUM_MASK_OBJECTS) throw new RangeError(`The mask names ${identifiers.length} parts; the limit is ${MAXIMUM_MASK_OBJECTS}. Fix: name fewer parts.`);
  return identifiers;
}

/** Sets the mask uniforms of a stage. A step with no mask gets a mask of one everywhere. Leaves texture unit 1 active. */
export function bindMask(context, uniforms, renderer, frame, mask) {
  const identifiers = mask?.objects ? objectIdentifiers(renderer, mask.objects) : [];
  context.uniform1i(uniforms.maskObjectCount, identifiers.length);
  if (identifiers.length > 0) {
    const padded = new Int32Array(MAXIMUM_MASK_OBJECTS);
    padded.set(identifiers);
    context.uniform1iv(uniforms.maskObjectIds, padded);
    context.activeTexture(context.TEXTURE2);
    context.bindTexture(context.TEXTURE_2D, renderer.passSupport.texture);
    context.uniform1i(uniforms.objectIds, 2);
  }
  context.uniform1f(uniforms.maskUseDepth, mask?.depth ? 1 : 0);
  if (mask?.depth) {
    context.uniform3f(uniforms.maskDepth, mask.depth.near, mask.depth.far, mask.depth.feather);
    context.uniform3fv(uniforms.maskEye, frame.eye);
    context.uniform3fv(uniforms.maskForward, renderer.viewForward);
  }
  context.uniform1f(uniforms.maskInvert, mask?.invert ? 1 : 0);
  context.activeTexture(context.TEXTURE1);
}
