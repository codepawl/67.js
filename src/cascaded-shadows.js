import { mat4, vec3 } from 'gl-matrix';
import { registerShaderFeatureCode } from './shader-registry.js';
import { resolveShadowLight } from './shadow-light.js';

// Cascaded sun shadows. The camera frustum is cut into up to four slices by view depth; each slice gets its own depth
// map, fitted to a bounding sphere of the slice, so a shadow near the camera is sharp and a far one is coarse. Pass
// `shadowCascades: createCascadedShadows({ count: 3 })` to the Renderer. The code lives here, not in the renderer, so a
// scene without cascades never downloads it. The classic single map shrinks to one texel unless volume fog or subsurface still reads it.
// The GLSL has no comments, because comments ship to every page:
// - cascadeMatrices take a world position to the clip space of each slice, cascadeSplits holds the view depth where each
//   slice ends, cascadeTexels the world size of one shadow texel and cascadeRanges the depth range in metres, and
//   cascadeFrame the camera forward axis with the slice count.
// - The receiver is pushed off its surface by 1.5 texels and the depth bias is one texel, as the local shadows do.
// - The last tenth of each slice blends into the next, so no seam shows.
// - The final #define makes the main shader's shadowVisibility(normal) call read the cascades; the classic map is not read.

export const MAXIMUM_CASCADES = 4;
const AUTOMATIC_CASCADE_EXTENT = 40;
const AUTOMATIC_CASCADE_COUNT = 3;
const DEFAULT_RESOLUTION = 2048;
const DEFAULT_MAXIMUM_DISTANCE = 150;
const DEFAULT_SPLIT_LAMBDA = 0.7;
const DEFAULT_CASTER_REACH = 200;
// A sampler that a program never sets reads unit 0, and the cascade array lives on unit 0, so the main program's other
// samplers are pinned to their own units here. These are the units renderer.js uses: the five maps on 1 to 5, the light map on 6, the local shadow atlas on 15.
const MAIN_SAMPLER_UNITS = { baseMap: 1, normalMap: 2, metallicRoughnessMap: 3, occlusionMap: 4, emissiveMap: 5, lightMap: 6, localShadowAtlas: 15 };
const NDC_CORNERS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

const CASCADE_DECLARATIONS = `uniform highp sampler2DArray cascadeShadowMap;
uniform mat4 cascadeMatrices[4];
uniform vec4 cascadeSplits;
uniform vec4 cascadeTexels;
uniform vec4 cascadeRanges;
uniform vec4 cascadeFrame;
uniform float sunSoftness;
vec2 cascadeVogel(int index, int count, float rotation) {
  float angle = float(index) * 2.399963 + rotation;
  return sqrt((float(index) + 0.5) / float(count)) * vec2(cos(angle), sin(angle));
}
float cascadeTap(int layer, vec2 coordinates, float receiverDepth, ivec2 dimensions) {
  vec2 pixel = coordinates * vec2(dimensions) - 0.5;
  ivec2 origin = ivec2(floor(pixel));
  vec2 blend = fract(pixel);
  ivec2 maximum = dimensions - 1;
  float lowerLeft = step(receiverDepth, texelFetch(cascadeShadowMap, ivec3(clamp(origin, ivec2(0), maximum), layer), 0).r);
  float lowerRight = step(receiverDepth, texelFetch(cascadeShadowMap, ivec3(clamp(origin + ivec2(1, 0), ivec2(0), maximum), layer), 0).r);
  float upperLeft = step(receiverDepth, texelFetch(cascadeShadowMap, ivec3(clamp(origin + ivec2(0, 1), ivec2(0), maximum), layer), 0).r);
  float upperRight = step(receiverDepth, texelFetch(cascadeShadowMap, ivec3(clamp(origin + ivec2(1, 1), ivec2(0), maximum), layer), 0).r);
  return mix(mix(lowerLeft, lowerRight, blend.x), mix(upperLeft, upperRight, blend.x), blend.y);
}
float cascadeSoftVisibility(int layer, vec3 projected, float receiverDepth, ivec2 dimensions) {
  float rotation = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float texelWorld = cascadeTexels[layer];
  float searchTexels = clamp(sunSoftness * 12.0 / texelWorld, 1.0, 24.0);
  float gapSum = 0.0;
  float blockers = 0.0;
  for (int tap = 0; tap < 12; tap++) {
    ivec2 texel = clamp(ivec2(floor(projected.xy * vec2(dimensions) + cascadeVogel(tap, 12, rotation) * searchTexels)), ivec2(0), dimensions - 1);
    float stored = texelFetch(cascadeShadowMap, ivec3(texel, layer), 0).r;
    if (stored < receiverDepth) {
      gapSum += receiverDepth - stored;
      blockers += 1.0;
    }
  }
  if (blockers == 0.0) return 1.0;
  float penumbraTexels = clamp(sunSoftness * (gapSum / blockers) * cascadeRanges[layer] / texelWorld, 1.0, 24.0);
  float lit = 0.0;
  for (int tap = 0; tap < 16; tap++) {
    lit += cascadeTap(layer, projected.xy + cascadeVogel(tap, 16, rotation) * penumbraTexels / vec2(dimensions), receiverDepth, dimensions);
  }
  return lit / 16.0;
}
float cascadeLayerVisibility(int layer, vec3 normal) {
  vec3 shifted = worldPosition + normal * (cascadeTexels[layer] * 1.5);
  vec3 projected = (cascadeMatrices[layer] * vec4(shifted, 1.0)).xyz * 0.5 + 0.5;
  if (projected.z > 1.0 || projected.z < 0.0 || any(lessThan(projected.xy, vec2(0.0))) || any(greaterThan(projected.xy, vec2(1.0)))) return 1.0;
  float bias = cascadeTexels[layer] / cascadeRanges[layer] * (1.0 + 2.0 * (1.0 - dot(normal, normalize(lightDirection))));
  ivec2 dimensions = textureSize(cascadeShadowMap, 0).xy;
  if (sunSoftness > 0.0) return cascadeSoftVisibility(layer, projected, projected.z - bias, dimensions);
  vec2 texel = 1.0 / vec2(dimensions);
  float visibility = 0.0;
  for (int row = -1; row <= 1; row++) {
    for (int column = -1; column <= 1; column++) {
      visibility += cascadeTap(layer, projected.xy + vec2(column, row) * texel * 2.5, projected.z - bias, dimensions);
    }
  }
  return visibility / 9.0;
}
float cascadeVisibility(vec3 normal) {
  float viewDepth = dot(worldPosition - eye, cascadeFrame.xyz);
  int count = int(cascadeFrame.w);
  for (int layer = 0; layer < 4; layer++) {
    if (layer >= count) break;
    float split = cascadeSplits[layer];
    if (viewDepth >= split) continue;
    float visibility = cascadeLayerVisibility(layer, normal);
    float previousSplit = layer > 0 ? cascadeSplits[layer - 1] : 0.0;
    float blendStart = split - (split - previousSplit) * 0.1;
    if (layer + 1 < count && viewDepth > blendStart) {
      visibility = mix(visibility, cascadeLayerVisibility(layer + 1, normal), smoothstep(blendStart, split, viewDepth));
    }
    return visibility;
  }
  return 1.0;
}
#define shadowVisibility(normal) cascadeVisibility(normal)
`;

registerShaderFeatureCode('cascadedShadows', { declarations: CASCADE_DECLARATIONS });

function integerInRange(value, minimum, maximum, name) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a whole number between ${minimum} and ${maximum}`);
  }
  return value;
}

function numberInRange(value, minimum, maximum, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

/** View depth where each slice ends: a blend of a uniform and a logarithmic split, as in practical split schemes. */
export function cascadeSplitDistances(count, near, far, lambda = DEFAULT_SPLIT_LAMBDA) {
  const distances = [];
  for (let index = 1; index <= count; index++) {
    const fraction = index / count;
    const logarithmic = near * (far / near) ** fraction;
    const uniform = near + (far - near) * fraction;
    distances.push(lambda * logarithmic + (1 - lambda) * uniform);
  }
  distances[count - 1] = far;
  return distances;
}

// The eight corners of the camera frustum, near plane first, from the inverse view-projection matrix.
function frustumCorners(inverseViewProjection) {
  const corners = [];
  for (const ndcDepth of [-1, 1]) {
    for (const [ndcX, ndcY] of NDC_CORNERS) {
      corners.push(vec3.transformMat4(vec3.create(), [ndcX, ndcY, ndcDepth], inverseViewProjection));
    }
  }
  return corners;
}

// The slice of the frustum between two fractions of the way from the near plane to the far plane.
function frustumSlice(corners, startFraction, endFraction) {
  const slice = [];
  for (const fraction of [startFraction, endFraction]) {
    for (let corner = 0; corner < 4; corner++) {
      slice.push(vec3.lerp(vec3.create(), corners[corner], corners[corner + 4], fraction));
    }
  }
  return slice;
}

function viewDepthOf(point, view) {
  return -vec3.transformMat4(vec3.create(), point, view)[2];
}

function boundingSphere(points) {
  const center = vec3.create();
  points.forEach(point => vec3.add(center, center, point));
  vec3.scale(center, center, 1 / points.length);
  const radius = Math.max(...points.map(point => vec3.distance(center, point)));
  return { center, radius };
}

/**
 * Writes the world to clip matrix of one slice into `target`. The slice is covered by a sphere, so turning the camera
 * does not change its size, and the sphere centre is snapped to whole texels so the shadow edges do not crawl.
 * Returns the world size of a texel and the depth range in metres.
 */
export function writeCascadeMatrix(target, { center, radius }, towardLight, resolution, casterReach, extraReach = 0) {
  const rotation = mat4.lookAt(mat4.create(), [0, 0, 0], [-towardLight[0], -towardLight[1], -towardLight[2]], Math.abs(towardLight[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]);
  const lightSpaceCenter = vec3.transformMat4(vec3.create(), center, rotation);
  const texel = (2 * radius) / resolution;
  const snappedX = Math.round(lightSpaceCenter[0] / texel) * texel;
  const snappedY = Math.round(lightSpaceCenter[1] / texel) * texel;
  const snappedZ = Math.round(lightSpaceCenter[2] / texel) * texel;
  const near = -(snappedZ + casterReach + extraReach);
  const far = -(snappedZ - radius);
  const projection = mat4.ortho(mat4.create(), snappedX - radius, snappedX + radius, snappedY - radius, snappedY + radius, near, far);
  mat4.multiply(target, projection, rotation);
  return { texel, range: far - near, snappedX, snappedY, near, far, radius };
}

// A slice that moved but still sits inside the map drawn for it can keep that map: same light direction, the sphere inside
// the drawn square, and its casters inside the drawn depth range.
function fitCovers(fit, sphere, towardLight, casterReach) {
  if (vec3.squaredDistance(fit.towardLight, towardLight) > 1e-12) return false;
  const rotation = mat4.lookAt(mat4.create(), [0, 0, 0], [-towardLight[0], -towardLight[1], -towardLight[2]], Math.abs(towardLight[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]);
  const center = vec3.transformMat4(vec3.create(), sphere.center, rotation);
  return Math.abs(center[0] - fit.snappedX) + sphere.radius <= fit.radius
    && Math.abs(center[1] - fit.snappedY) + sphere.radius <= fit.radius
    && -(center[2] + casterReach) >= fit.near
    && -(center[2] - sphere.radius) <= fit.far;
}

// While the camera moves, a slice past the first is drawn this much wider than it needs, so it stays valid for many frames.
const HOLD_MARGIN = 0.1;

export class CascadedShadows {
  constructor({ count = 3, resolution = DEFAULT_RESOLUTION, maximumDistance = DEFAULT_MAXIMUM_DISTANCE, splitLambda = DEFAULT_SPLIT_LAMBDA, casterReach = DEFAULT_CASTER_REACH } = {}) {
    this.count = integerInRange(count, 1, MAXIMUM_CASCADES, 'cascade count');
    this.resolution = integerInRange(resolution, 256, 4096, 'cascade resolution');
    this.maximumDistance = numberInRange(maximumDistance, 1, 1e5, 'cascade maximumDistance');
    this.splitLambda = numberInRange(splitLambda, 0, 1, 'cascade splitLambda');
    this.casterReach = numberInRange(casterReach, 1, 1e5, 'cascade casterReach');
    this.shaderFeature = 'cascadedShadows';
    this.matrices = new Float32Array(MAXIMUM_CASCADES * 16);
    this.drawnMatrices = new Float32Array(MAXIMUM_CASCADES * 16);
    this.holds = [];
    this.holdMargin = HOLD_MARGIN;
    this.splits = new Float32Array(MAXIMUM_CASCADES).fill(1e9);
    this.texels = new Float32Array(MAXIMUM_CASCADES).fill(1);
    this.ranges = new Float32Array(MAXIMUM_CASCADES).fill(1);
    this.forward = new Float32Array(4);
    this.texture = null;
    this.framebuffer = null;
    this.drawCount = 0;
    this.locations = null;
    this.locationProgram = null;
  }

  allocate(context) {
    this.texture = context.createTexture();
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D_ARRAY, this.texture);
    context.texImage3D(context.TEXTURE_2D_ARRAY, 0, context.DEPTH_COMPONENT24, this.resolution, this.resolution, this.count, 0, context.DEPTH_COMPONENT, context.UNSIGNED_INT, null);
    context.texParameteri(context.TEXTURE_2D_ARRAY, context.TEXTURE_MIN_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D_ARRAY, context.TEXTURE_MAG_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D_ARRAY, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D_ARRAY, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    this.framebuffer = context.createFramebuffer();
    // A new array holds no depth yet, so every slice draws on its first update.
    this.drawCount = 0;
    this.drawnMatrices.fill(0);
  }

  // Fits every slice to the current camera. Returns the number of slices whose matrix moved.
  fitToCamera(renderer) {
    const light = resolveShadowLight(renderer.world, renderer.activeLightDirection, renderer.shadowBounds);
    const towardLight = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), light.eye, light.target));
    const corners = frustumCorners(renderer.inverseViewProjection);
    const nearDistance = viewDepthOf(corners[0], renderer.view);
    const planeFarDistance = viewDepthOf(corners[4], renderer.view);
    const farDistance = Math.min(planeFarDistance, this.maximumDistance);
    const splits = cascadeSplitDistances(this.count, nearDistance, farDistance, this.splitLambda);
    const planeSpan = planeFarDistance - nearDistance;
    let previousFraction = 0;
    splits.forEach((split, layer) => {
      const endFraction = Math.min((split - nearDistance) / planeSpan, 1);
      const sphere = boundingSphere(frustumSlice(corners, previousFraction, endFraction));
      const fitted = this.chooseFit(layer, sphere, towardLight);
      this.matrices.set(fitted.matrix, layer * 16);
      this.splits[layer] = split;
      this.texels[layer] = fitted.texel;
      this.ranges[layer] = fitted.range;
      previousFraction = endFraction;
    });
    this.forward.set([...renderer.viewForward, this.count]);
    return this.matrices.some((value, index) => value !== this.drawnMatrices[index]);
  }

  // The nearest slice always fits exactly. A farther slice that moved keeps its last map while the new slice still sits inside
  // it, and is redrawn wider than needed when it does not; a camera that stops settles back on the exact fit.
  chooseFit(layer, sphere, towardLight) {
    const hold = this.holds[layer] ??= { fit: null, tight: null };
    const tight = { matrix: new Float32Array(16), towardLight: vec3.clone(towardLight) };
    Object.assign(tight, writeCascadeMatrix(tight.matrix, sphere, towardLight, this.resolution, this.casterReach));
    const moved = hold.tight && tight.matrix.some((value, index) => value !== hold.tight.matrix[index]);
    hold.tight = tight;
    if (layer === 0 || !hold.fit || !moved) {
      hold.fit = tight;
    } else if (!fitCovers(hold.fit, sphere, towardLight, this.casterReach)) {
      const wide = { matrix: new Float32Array(16), towardLight: vec3.clone(towardLight) };
      // The depth range gets the same margin on the light side, so a slice that drifts toward the light stays covered too.
      const margin = sphere.radius * this.holdMargin;
      Object.assign(wide, writeCascadeMatrix(wide.matrix, { center: sphere.center, radius: sphere.radius + margin }, towardLight, this.resolution, this.casterReach, margin));
      hold.fit = wide;
    }
    return hold.fit;
  }

  /** Whether the main shader reads the cascades alone: volume fog and subsurface thickness still read the single map. */
  replacesSingleMap(renderer) {
    return !renderer.volumeShadowWanted && !renderer.shaderFeatures.has('subsurface');
  }

  /** Redraws the slice maps when the camera, the light or a caster moved. Call once a frame after the camera is set. */
  update(renderer, casterChanged) {
    const context = renderer.context;
    if (!this.texture) {
      this.allocate(context);
      renderer.renderTargets.record('cascadedShadowMaps', { width: this.resolution, height: this.resolution, layers: this.count, format: 'DEPTH_COMPONENT24' });
    }
    const moved = this.fitToCamera(renderer);
    if (!moved && !casterChanged && this.drawCount > 0) return;
    this.drawCount++;
    context.bindFramebuffer(context.FRAMEBUFFER, this.framebuffer);
    context.drawBuffers([context.NONE]);
    context.readBuffer(context.NONE);
    context.viewport(0, 0, this.resolution, this.resolution);
    context.enable(context.DEPTH_TEST);
    context.enable(context.CULL_FACE);
    for (let layer = 0; layer < this.count; layer++) {
      const layerMatrix = this.matrices.subarray(layer * 16, layer * 16 + 16);
      const drawnMatrix = this.drawnMatrices.subarray(layer * 16, layer * 16 + 16);
      // A slice whose matrix did not change keeps the depth it holds, because the casters it draws depend on that matrix alone.
      // Far slices have large texels and snap to them, so most of them hold still while the camera orbits.
      if (!casterChanged && this.drawCount > 1 && drawnMatrix.every((value, index) => value === layerMatrix[index])) continue;
      drawnMatrix.set(layerMatrix);
      context.framebufferTextureLayer(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, this.texture, 0, layer);
      context.clear(context.DEPTH_BUFFER_BIT);
      renderer.drawShadowCasters(layerMatrix, this.resolution);
    }
    context.bindFramebuffer(context.FRAMEBUFFER, null);
  }

  /** Uploads the slice matrices and binds the depth array to unit 0, which the main pass reads. */
  bindUniforms(renderer) {
    const context = renderer.context;
    if (this.locationProgram !== renderer.program) {
      const names = ['cascadeShadowMap', 'cascadeMatrices[0]', 'cascadeSplits', 'cascadeTexels', 'cascadeRanges', 'cascadeFrame', 'sunSoftness'];
      this.locations = Object.fromEntries(names.map(name => [name, context.getUniformLocation(renderer.program, name)]));
      this.locationProgram = renderer.program;
      for (const [name, unit] of Object.entries(MAIN_SAMPLER_UNITS)) context.uniform1i(context.getUniformLocation(renderer.program, name), unit);
    }
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D_ARRAY, this.texture);
    context.uniform1i(this.locations.cascadeShadowMap, 0);
    context.uniformMatrix4fv(this.locations['cascadeMatrices[0]'], false, this.matrices);
    context.uniform4fv(this.locations.cascadeSplits, this.splits);
    context.uniform4fv(this.locations.cascadeTexels, this.texels);
    context.uniform4fv(this.locations.cascadeRanges, this.ranges);
    context.uniform4fv(this.locations.cascadeFrame, this.forward);
    const sunAngularRadius = renderer.environment?.sunAngularRadius;
    context.uniform1f(this.locations.sunSoftness, sunAngularRadius > 0 ? Math.tan(sunAngularRadius) : 0);
  }

  dispose(context, renderTargets = null) {
    renderTargets?.release('cascadedShadowMaps');
    if (this.texture) context.deleteTexture(this.texture);
    if (this.framebuffer) context.deleteFramebuffer(this.framebuffer);
    this.texture = null;
    this.framebuffer = null;
  }
}

/** Options: count (1 to 4 slices, default 3), resolution (default 2048), maximumDistance (default 150 m), splitLambda, casterReach. */
export function createCascadedShadows(options) {
  return new CascadedShadows(options);
}

/**
 * The cascade count a scene draws its sun shadow with. An explicit shadowCascades wins (0 forces the single map). Without
 * one, a scene whose single 2048 map is coarse gets three cascades: the map covers 2 x shadow.extent metres, so a texel is
 * extent / 1024 metres, and from 4 cm (extent above 40 m) a lamp post near the camera is two texels wide.
 * Measured on long-street (extent 85): 0.1555 against Cycles with one map, 0.1398 with three, +0.2 ms on an RTX 3060.
 * It reads only recipe numbers, so a recipe always resolves the same way, and the default extent of 3.5 never trips it.
 */
export function effectiveShadowCascades(environment, shadow) {
  if (environment.shadowCascades !== undefined) {
    return environment.shadowCascades;
  }
  const automaticCount = shadow.extent > AUTOMATIC_CASCADE_EXTENT ? AUTOMATIC_CASCADE_COUNT : 0;
  // A soft sun reads depths from the cascade array, so a scene that names an angle gets at least one slice.
  return environment.sunAngularRadius > 0 ? Math.max(automaticCount, 1) : automaticCount;
}
