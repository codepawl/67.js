import { SUBSURFACE_FUNCTIONS, SUBSURFACE_LOBE, SUBSURFACE_SPLIT, SUBSURFACE_UNIFORM } from './path-tracer-gpu-subsurface.js';

// The GPU path tracer kernel: a WebGL2 fragment shader that follows the same paths as the CPU tracer in
// path-tracer.js. It reads the BVH, triangles, materials, lights and environment from float textures
// (path-tracer-gpu-pack.js), draws the same random numbers in the same order, and writes one sample per pixel into four
// additive render targets: radiance and depth, albedo, normal, and luminance with its square.

export const DATA_TEXTURE_SHIFT = 11;
export const DATA_TEXTURE_WIDTH = 1 << DATA_TEXTURE_SHIFT;
export const TRIANGLE_TEXELS = 9;
export const MATERIAL_TEXELS = 10;
export const LIGHT_TEXELS = 6;

export const VERTEX_SOURCE = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

// Camera mode: one pixel is one jittered camera ray.
const CAMERA_MAIN = `void main() {
  ivec2 pixelCoordinate = ivec2(gl_FragCoord.xy);
  int row = pixelCoordinate.y;
  uint pixel = uint(row * uSize.x + pixelCoordinate.x);
  uint sampleIndex = uint(uSample);
  if (uHasSun) sunFrame = buildFrame(uSunDirection);
  float jitterX = hashJitter(pixel, sampleIndex, uSeed, 1u);
  float jitterY = hashJitter(pixel, sampleIndex, uSeed, 2u);
  if (BLUE_NOISE_FIRST && sampleIndex == 0u) {
    blueSample = blueNoiseAt(pixelCoordinate);
    jitterX = blueSample.x;
    jitterY = blueSample.y;
    blueDrawsUsed = 0;
  }
  float screenX = ((float(pixelCoordinate.x) + jitterX) / float(uSize.x) * 2.0 - 1.0) * uHalfSize.x;
  float screenY = (1.0 - (float(row) + jitterY) / float(uSize.y) * 2.0) * uHalfSize.y;
  vec3 rayDirection = normalize(uForward + uRight * screenX + uAbove * screenY);
  tracePath(uEye, rayDirection, pixel, sampleIndex);`;

// Texel mode: one pixel is one lightmap texel. The path starts on the texel's surface with a cosine weighted direction,
// so the radiance it returns is the light arriving at the texel (the caller multiplies by the albedo). The first
// uBounces + 1 hits are followed, which is the bake's bounce count.
const TEXEL_UNIFORM = `uniform sampler2D uTexelPoints;
uniform sampler2D uTexelNormals;
uniform int uTexelCount;
uniform int uSampleCount;`;

const TEXEL_MAIN = `void main() {
  ivec2 pixelCoordinate = ivec2(gl_FragCoord.xy);
  int texelIndex = pixelCoordinate.y * uSize.x + pixelCoordinate.x;
  uint pixel = uint(texelIndex);
  uint sampleIndex = uint(uSample);
  if (uHasSun) sunFrame = buildFrame(uSunDirection);
  vec3 normal = texelFetch(uTexelNormals, pixelCoordinate, 0).xyz;
  vec3 origin = texelFetch(uTexelPoints, pixelCoordinate, 0).xyz + normal * uSurfaceOffset;
  float firstUnit = (float(uSample) + hashJitter(pixel, sampleIndex, uSeed, 1u)) / float(uSampleCount);
  float secondUnit = hashJitter(pixel, sampleIndex, uSeed, 2u);
  float coneRadius = sqrt(firstUnit);
  float angle = TWO_PI * secondUnit;
  vec3 rayDirection = buildFrame(normal) * vec3(coneRadius * cos(angle), coneRadius * sin(angle), sqrt(max(0.0, 1.0 - firstUnit)));
  if (texelIndex >= uTexelCount) rayDirection = normal;
  tracePath(origin, rayDirection, pixel, sampleIndex);`;

const buildSource = (hasSubsurface, texelBake, blueNoise, lightImportance) => `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

const float PI = 3.14159265358979;
const float TWO_PI = 6.28318530717959;
const int TEXTURE_SHIFT = ${DATA_TEXTURE_SHIFT};
const int TEXTURE_MASK = ${DATA_TEXTURE_WIDTH - 1};
const int TRIANGLE_TEXELS = ${TRIANGLE_TEXELS};
const int MATERIAL_TEXELS = ${MATERIAL_TEXELS};
const int LIGHT_TEXELS = ${LIGHT_TEXELS};
const int STACK_SIZE = 128;
const bool BLUE_NOISE_FIRST = ${blueNoise};
const bool IMPORTANT_LIGHTS = ${lightImportance};
const int ALPHA_STEP_LIMIT = 8;
const int RUSSIAN_ROULETTE_START = 3;
const float MINIMUM_ALPHA = 1e-3;
const float MIRROR_ALPHA = 2e-3;
const float DIELECTRIC_COAT_REFLECTANCE = 0.04;

uniform sampler2D uNodes;
uniform sampler2D uTriangles;
uniform sampler2D uMaterials;
uniform sampler2D uLights;
uniform sampler2D uAtlas;
uniform sampler2D uEnvironment;
uniform sampler2D uEnvironmentRows;
uniform sampler2D uEnvironmentPixels;
uniform sampler2D uBlueNoise;

uniform vec3 uEye;
uniform vec3 uForward;
uniform vec3 uRight;
uniform vec3 uAbove;
uniform vec2 uHalfSize;
uniform ivec2 uSize;
uniform int uSample;
uniform uint uSeed;
uniform int uBounces;
uniform float uFireflyClamp;
uniform float uSurfaceOffset;
uniform float uFarDistance;
uniform int uLightCount;
uniform int uEmitterCount;
uniform bool uHasSun;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunCosineMax;
uniform bool uHasEnvironment;
uniform vec4 uEnvironmentShape;
uniform vec2 uEnvironmentRotation;
uniform bool uHasVolume;
uniform vec3 uVolumeMinimum;
uniform vec3 uVolumeMaximum;
uniform vec3 uVolumeAlbedo;
uniform vec3 uVolumeShape;
${texelBake ? TEXEL_UNIFORM : ''}
${hasSubsurface ? SUBSURFACE_UNIFORM : ''}
layout(location = 0) out vec4 outRadiance;
layout(location = 1) out vec4 outAlbedo;
layout(location = 2) out vec4 outNormal;
layout(location = 3) out vec4 outStatistics;

vec4 fetchData(sampler2D source, int index) {
  return texelFetch(source, ivec2(index & TEXTURE_MASK, index >> TEXTURE_SHIFT), 0);
}

float fetchScalar(sampler2D source, int index) {
  return texelFetch(source, ivec2(index & TEXTURE_MASK, index >> TEXTURE_SHIFT), 0).r;
}

// ---- Random numbers (the same integer arithmetic as the CPU tracer) ----

uint rngState = 1u;

void resetRandom(uint pixel, uint sampleIndex, uint seed) {
  uint mixed = ((pixel + 0x9e3779b9u) * 0x85ebca6bu) ^ ((sampleIndex + 0x7f4a7c15u) * 0xc2b2ae35u) ^ ((seed + 0x165667b1u) * 0x27d4eb2fu);
  mixed = (mixed ^ (mixed >> 15)) * 0x2c1b3c6du;
  mixed = (mixed ^ (mixed >> 12)) * 0x297a2d39u;
  mixed ^= mixed >> 15;
  rngState = mixed == 0u ? 1u : mixed;
}

// Blue noise tile of the first sample of a pixel: its first two values replace the first two random draws of the path.
vec4 blueSample = vec4(0.0);
int blueDrawsUsed = 2;

vec4 blueNoiseAt(ivec2 pixelCoordinate) {
  vec4 bytes = round(texelFetch(uBlueNoise, pixelCoordinate & 63, 0) * 255.0);
  return (bytes + 0.5) / 256.0;
}

float nextRandom() {
  if (BLUE_NOISE_FIRST && blueDrawsUsed < 2) {
    blueDrawsUsed++;
    return blueDrawsUsed == 1 ? blueSample.z : blueSample.w;
  }
  rngState = rngState * 747796405u + 2891336453u;
  uint word = ((rngState >> ((rngState >> 28) + 4u)) ^ rngState) * 277803737u;
  word = (word >> 22) ^ word;
  return float(word >> 8) / 16777216.0;
}

float hashJitter(uint pixel, uint sampleIndex, uint seed, uint dimension) {
  uint mixed = ((pixel ^ 0x51ed270bu) * 0x9e3779b1u) ^ ((sampleIndex + dimension * 0x632be5abu) * 0x85ebca6bu) ^ ((seed + 0x1b873593u) * 0xc2b2ae35u);
  mixed = (mixed ^ (mixed >> 16)) * 0x7feb352du;
  mixed = (mixed ^ (mixed >> 15)) * 0x846ca68bu;
  mixed ^= mixed >> 16;
  return float(mixed >> 8) / 16777216.0;
}

float luminance(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

// ---- Ray queries ----

float nearestDistance;
int nearestSlot;
float nearestU;
float nearestV;

float safeInverseComponent(float component) {
  if (abs(component) > 1e-20) return 1.0 / component;
  return component < 0.0 ? -1e20 : 1e20;
}

vec3 safeInverse(vec3 direction) {
  return vec3(safeInverseComponent(direction.x), safeInverseComponent(direction.y), safeInverseComponent(direction.z));
}

float boxEntry(int node, vec3 origin, vec3 inverse) {
  vec4 low = fetchData(uNodes, node * 2);
  vec4 high = fetchData(uNodes, node * 2 + 1);
  vec3 first = (low.xyz - origin) * inverse;
  vec3 second = (high.xyz - origin) * inverse;
  vec3 nearest = min(first, second);
  vec3 farthest = max(first, second);
  float entry = max(max(max(nearest.x, nearest.y), nearest.z), 0.0);
  float exitDistance = min(min(farthest.x, farthest.y), farthest.z);
  return entry <= exitDistance * (1.0 + 1e-6) + 1e-6 ? entry : 1e30;
}

bool visitLeaf(int node, vec3 origin, vec3 direction, bool anyHit) {
  vec4 range = fetchData(uNodes, node * 2 + 1);
  vec4 header = fetchData(uNodes, node * 2);
  int start = int(range.w);
  int end = start + int(-header.w);
  for (int slot = start; slot < end; slot++) {
    int base = slot * TRIANGLE_TEXELS;
    vec3 corner = fetchData(uTriangles, base).xyz;
    vec3 edgeFirst = fetchData(uTriangles, base + 1).xyz;
    vec3 edgeSecond = fetchData(uTriangles, base + 2).xyz;
    vec3 pivot = cross(direction, edgeSecond);
    float determinant = dot(edgeFirst, pivot);
    if (determinant == 0.0) continue;
    vec3 offset = origin - corner;
    float firstWeight = dot(offset, pivot) / determinant;
    if (firstWeight < 0.0 || firstWeight > 1.0) continue;
    vec3 query = cross(offset, edgeFirst);
    float secondWeight = dot(direction, query) / determinant;
    if (secondWeight < 0.0 || firstWeight + secondWeight > 1.0) continue;
    float distance = dot(edgeSecond, query) / determinant;
    if (distance < 0.0 || distance >= nearestDistance) continue;
    nearestDistance = distance;
    nearestSlot = slot;
    nearestU = firstWeight;
    nearestV = secondWeight;
    if (anyHit) return true;
  }
  return false;
}

void traceRay(vec3 origin, vec3 direction, float limit, bool anyHit) {
  nearestDistance = limit;
  nearestSlot = -1;
  vec3 inverse = safeInverse(direction);
  int nodeStack[STACK_SIZE];
  float entryStack[STACK_SIZE];
  int stackSize = 1;
  nodeStack[0] = 0;
  entryStack[0] = 0.0;
  while (stackSize > 0) {
    stackSize--;
    int node = nodeStack[stackSize];
    if (!(entryStack[stackSize] < nearestDistance)) continue;
    vec4 header = fetchData(uNodes, node * 2);
    if (header.w < 0.0) {
      if (visitLeaf(node, origin, direction, anyHit)) return;
      continue;
    }
    int left = node + 1;
    int right = int(header.w);
    float leftEntry = boxEntry(left, origin, inverse);
    float rightEntry = boxEntry(right, origin, inverse);
    bool nearFirst = leftEntry <= rightEntry;
    nodeStack[stackSize] = nearFirst ? right : left;
    entryStack[stackSize] = nearFirst ? rightEntry : leftEntry;
    nodeStack[stackSize + 1] = nearFirst ? left : right;
    entryStack[stackSize + 1] = nearFirst ? leftEntry : rightEntry;
    stackSize += 2;
  }
}

// ---- Hits ----

float hitDistance;
vec3 hitPoint;
vec3 hitNormal;
vec3 hitColor;
vec3 hitEmission;
float hitMetallic;
float hitRoughness;
float hitClearcoat;
float hitClearcoatRoughness;
float hitTransmission;
float hitIor;
float hitCutoff;
int hitMaterialIndex;
uint hitMask;

vec3 srgbToLinear(vec3 encoded) {
  return mix(pow((encoded + 0.055) / 1.055, vec3(2.4)), encoded / 12.92, lessThanEqual(encoded, vec3(0.04045)));
}

vec4 sampleAtlas(vec4 rectangle, float flags, vec2 uv) {
  if (rectangle.z <= 0.0) return vec4(1.0);
  int width = int(rectangle.z);
  int height = int(rectangle.w);
  bool repeat = mod(flags, 2.0) >= 1.0;
  bool encoded = flags >= 2.0;
  float x = uv.x * rectangle.z - 0.5;
  float y = uv.y * rectangle.w - 0.5;
  float left = floor(x);
  float top = floor(y);
  float shareX = x - left;
  float shareY = y - top;
  vec4 total = vec4(0.0);
  for (int corner = 0; corner < 4; corner++) {
    int column = int(left) + (corner & 1);
    int row = int(top) + (corner >> 1);
    if (repeat) {
      column = ((column % width) + width) % width;
      row = ((row % height) + height) % height;
    } else {
      column = clamp(column, 0, width - 1);
      row = clamp(row, 0, height - 1);
    }
    float weight = (((corner & 1) == 1) ? shareX : 1.0 - shareX) * (((corner >> 1) == 1) ? shareY : 1.0 - shareY);
    vec4 texel = texelFetch(uAtlas, ivec2(int(rectangle.x) + column, int(rectangle.y) + row), 0);
    vec3 color = encoded ? srgbToLinear(texel.rgb) : texel.rgb;
    total += weight * vec4(color, texel.a);
  }
  return total;
}

void applyNormalMap(vec4 rectangle, float flags, vec2 scale, vec3 edgeOne, vec3 edgeTwo, vec2 uvOne, vec2 uvTwo, vec2 uv) {
  float determinant = uvOne.x * uvTwo.y - uvTwo.x * uvOne.y;
  if (abs(determinant) < 1e-12) return;
  vec3 normal = hitNormal;
  vec3 tangent = (edgeOne * uvTwo.y - edgeTwo * uvOne.y) / determinant;
  vec3 bitangent = (edgeTwo * uvOne.x - edgeOne * uvTwo.x) / determinant;
  tangent -= normal * dot(tangent, normal);
  float tangentLength = length(tangent);
  if (tangentLength == 0.0) return;
  tangent /= tangentLength;
  vec3 across = cross(normal, tangent);
  float acrossLength = length(across);
  if (acrossLength == 0.0) acrossLength = 1.0;
  float handedness = dot(across, bitangent) < 0.0 ? -1.0 : 1.0;
  across *= handedness / acrossLength;
  vec3 texel = sampleAtlas(rectangle, flags, uv).rgb;
  float sideways = (texel.x * 2.0 - 1.0) * scale.x;
  float forwards = (texel.y * 2.0 - 1.0) * scale.y;
  float outwards = texel.z * 2.0 - 1.0;
  vec3 mapped = tangent * sideways + across * forwards + normal * outwards;
  float mappedLength = length(mapped);
  if (!(mappedLength > 1e-6)) return;
  hitNormal = mapped / mappedLength;
}

/** Fills the hit globals from the triangle in \`nearestSlot\`; returns the alpha of the colour map. */
float fillHit(vec3 origin, vec3 direction, float distance) {
  int base = nearestSlot * TRIANGLE_TEXELS;
  vec4 cornerData = fetchData(uTriangles, base);
  vec3 edgeOne = fetchData(uTriangles, base + 1).xyz;
  vec3 edgeTwo = fetchData(uTriangles, base + 2).xyz;
  vec4 normalOneData = fetchData(uTriangles, base + 3);
  vec4 normalTwoData = fetchData(uTriangles, base + 4);
  vec4 normalThreeData = fetchData(uTriangles, base + 5);
  vec4 colorOneData = fetchData(uTriangles, base + 6);
  vec4 colorTwoData = fetchData(uTriangles, base + 7);
  vec4 colorThreeData = fetchData(uTriangles, base + 8);
  float secondWeight = nearestU;
  float thirdWeight = nearestV;
  float firstWeight = 1.0 - secondWeight - thirdWeight;
  hitDistance = distance;
  hitPoint = origin + direction * distance;
  vec3 normal = firstWeight * normalOneData.xyz + secondWeight * normalTwoData.xyz + thirdWeight * normalThreeData.xyz;
  float normalLength = length(normal);
  hitNormal = normal / (normalLength == 0.0 ? 1.0 : normalLength);
  vec3 vertexColor = firstWeight * colorOneData.xyz + secondWeight * colorTwoData.xyz + thirdWeight * colorThreeData.xyz;
  vec2 uv = firstWeight * vec2(normalOneData.w, colorOneData.w) + secondWeight * vec2(normalTwoData.w, colorTwoData.w) + thirdWeight * vec2(normalThreeData.w, colorThreeData.w);
  hitMaterialIndex = int(cornerData.w);
  int material = hitMaterialIndex * MATERIAL_TEXELS;
  vec4 colorMetallic = fetchData(uMaterials, material);
  vec4 emissionRoughness = fetchData(uMaterials, material + 1);
  vec4 coating = fetchData(uMaterials, material + 2);
  vec4 shape = fetchData(uMaterials, material + 3);
  vec4 flagsOne = fetchData(uMaterials, material + 4);
  vec4 flagsTwo = fetchData(uMaterials, material + 5);
  hitColor = colorMetallic.rgb * vertexColor;
  hitEmission = emissionRoughness.rgb;
  hitMetallic = colorMetallic.w;
  hitRoughness = emissionRoughness.w;
  hitClearcoat = coating.x;
  hitClearcoatRoughness = coating.y;
  hitTransmission = coating.z;
  hitIor = coating.w;
  hitCutoff = shape.z;
  hitMask = uint(shape.w) | (uint(flagsOne.x) << 16);
  float alpha = 1.0;
  vec4 mapRectangle = fetchData(uMaterials, material + 6);
  if (mapRectangle.z > 0.0) {
    vec4 texel = sampleAtlas(mapRectangle, flagsOne.y, uv);
    hitColor *= texel.rgb;
    alpha = texel.a;
  }
  vec4 emissiveRectangle = fetchData(uMaterials, material + 9);
  if (emissiveRectangle.z > 0.0) hitEmission *= sampleAtlas(emissiveRectangle, flagsTwo.x, uv).rgb;
  vec4 surfaceRectangle = fetchData(uMaterials, material + 8);
  if (surfaceRectangle.z > 0.0) {
    vec4 texel = sampleAtlas(surfaceRectangle, flagsOne.w, uv);
    hitRoughness *= texel.g;
    hitMetallic *= texel.b;
  }
  vec4 normalRectangle = fetchData(uMaterials, material + 7);
  if (normalRectangle.z > 0.0) {
    vec2 uvOne = vec2(normalTwoData.w - normalOneData.w, colorTwoData.w - colorOneData.w);
    vec2 uvTwo = vec2(normalThreeData.w - normalOneData.w, colorThreeData.w - colorOneData.w);
    applyNormalMap(normalRectangle, flagsOne.z, shape.xy, edgeOne, edgeTwo, uvOne, uvTwo, uv);
  }
  return alpha;
}

/** The nearest solid hit, stepping through the transparent texels of cutout materials. */
bool intersectScene(vec3 origin, vec3 direction) {
  vec3 start = origin;
  float travelled = 0.0;
  for (int attempt = 0; attempt < ALPHA_STEP_LIMIT; attempt++) {
    traceRay(start, direction, uFarDistance, false);
    if (nearestSlot < 0) return false;
    float foundDistance = nearestDistance;
    float alpha = fillHit(start, direction, foundDistance);
    if (hitCutoff == 0.0 || alpha >= hitCutoff) {
      hitDistance += travelled;
      return true;
    }
    float advance = foundDistance + uSurfaceOffset;
    travelled += advance;
    start += direction * advance;
  }
  return false;
}

/** The alpha of the colour map at the nearest hit, without touching the hit globals a shadow ray must not disturb. */
float alphaAtNearestHit() {
  int base = nearestSlot * TRIANGLE_TEXELS;
  float secondWeight = nearestU;
  float thirdWeight = nearestV;
  float firstWeight = 1.0 - secondWeight - thirdWeight;
  vec4 first = fetchData(uTriangles, base + 3);
  vec4 second = fetchData(uTriangles, base + 4);
  vec4 third = fetchData(uTriangles, base + 5);
  vec2 uv = firstWeight * vec2(first.w, fetchData(uTriangles, base + 6).w) + secondWeight * vec2(second.w, fetchData(uTriangles, base + 7).w) + thirdWeight * vec2(third.w, fetchData(uTriangles, base + 8).w);
  int material = int(fetchData(uTriangles, base).w) * MATERIAL_TEXELS;
  vec4 mapRectangle = fetchData(uMaterials, material + 6);
  if (mapRectangle.z <= 0.0) return 1.0;
  return sampleAtlas(mapRectangle, fetchData(uMaterials, material + 4).y, uv).a;
}

bool occluded(vec3 origin, vec3 direction, float limit) {
  vec3 start = origin;
  float remaining = limit;
  for (int attempt = 0; attempt < ALPHA_STEP_LIMIT; attempt++) {
    traceRay(start, direction, remaining, true);
    if (nearestSlot < 0) return false;
    int material = int(fetchData(uTriangles, nearestSlot * TRIANGLE_TEXELS).w) * MATERIAL_TEXELS;
    float cutoff = fetchData(uMaterials, material + 3).z;
    if (cutoff == 0.0) return true;
    if (alphaAtNearestHit() >= cutoff) return true;
    float advance = nearestDistance + uSurfaceOffset;
    remaining -= advance;
    if (remaining <= 0.0) return false;
    start += direction * advance;
  }
  return true;
}

// ---- Frames ----

mat3 buildFrame(vec3 normal) {
  bool helperIsX = abs(normal.x) < 0.9;
  float helperX = helperIsX ? 1.0 : 0.0;
  float helperY = helperIsX ? 0.0 : 1.0;
  vec3 tangent = vec3(-normal.z * helperY, normal.z * helperX, normal.x * helperY - normal.y * helperX);
  tangent = normalize(tangent);
  return mat3(tangent, cross(normal, tangent), normal);
}

vec3 localToWorld(mat3 frame, vec3 local) {
  return frame * local;
}

vec3 worldToLocal(mat3 frame, vec3 world) {
  return transpose(frame) * world;
}

// ---- Environment map ----

vec3 environmentRadiance(vec3 direction) {
  float width = uEnvironmentShape.x;
  float height = uEnvironmentShape.y;
  float mapX = uEnvironmentRotation.x * direction.x - uEnvironmentRotation.y * direction.z;
  float mapZ = uEnvironmentRotation.y * direction.x + uEnvironmentRotation.x * direction.z;
  float column = (atan(mapX, -mapZ) / TWO_PI + 0.5) * width - 0.5;
  float row = acos(clamp(direction.y, -1.0, 1.0)) / PI * height - 0.5;
  float left = floor(column);
  float top = floor(row);
  float shareX = column - left;
  float shareY = row - top;
  int columns = int(width);
  int rows = int(height);
  vec3 total = vec3(0.0);
  for (int corner = 0; corner < 4; corner++) {
    int cornerColumn = ((int(left) + (corner & 1)) % columns + columns) % columns;
    int cornerRow = clamp(int(top) + (corner >> 1), 0, rows - 1);
    float weight = (((corner & 1) == 1) ? shareX : 1.0 - shareX) * (((corner >> 1) == 1) ? shareY : 1.0 - shareY);
    total += weight * texelFetch(uEnvironment, ivec2(cornerColumn, cornerRow), 0).rgb * uEnvironmentShape.z;
  }
  return total;
}

float environmentPdf(vec3 direction) {
  float width = uEnvironmentShape.x;
  float height = uEnvironmentShape.y;
  float mapX = uEnvironmentRotation.x * direction.x - uEnvironmentRotation.y * direction.z;
  float mapZ = uEnvironmentRotation.y * direction.x + uEnvironmentRotation.x * direction.z;
  int column = min(int(width) - 1, int(floor((atan(mapX, -mapZ) / TWO_PI + 0.5) * width)));
  float polar = acos(clamp(direction.y, -1.0, 1.0));
  int row = min(int(height) - 1, int(floor(polar / PI * height)));
  float sinePolar = max(sin(polar), 1e-6);
  float rowWeight = sin(PI * (float(row) + 0.5) / height);
  vec3 texel = texelFetch(uEnvironment, ivec2(column, row), 0).rgb;
  float weight = (luminance(texel) + 1e-6) * rowWeight;
  return weight / uEnvironmentShape.w * width * height / (TWO_PI * PI * sinePolar);
}

int firstIndexAbove(sampler2D cumulative, int start, int end, float target) {
  int low = start;
  int high = end - 1;
  for (int step = 0; step < 24; step++) {
    if (low >= high) break;
    int middle = (low + high) >> 1;
    if (fetchScalar(cumulative, middle) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Draws a direction in proportion to the map's light; returns its pdf. */
float sampleEnvironment(float rowUnit, float columnUnit, float columnJitter, float rowJitter, out vec3 direction) {
  int width = int(uEnvironmentShape.x);
  int height = int(uEnvironmentShape.y);
  int row = firstIndexAbove(uEnvironmentRows, 0, height, rowUnit);
  int rowBase = row * width;
  int column = firstIndexAbove(uEnvironmentPixels, rowBase, rowBase + width, columnUnit) - rowBase;
  float polar = PI * (float(row) + rowJitter) / float(height);
  float azimuth = ((float(column) + columnJitter) / float(width) - 0.5) * TWO_PI;
  float sinePolar = sin(polar);
  float mapX = sinePolar * sin(azimuth);
  float mapZ = -sinePolar * cos(azimuth);
  direction = vec3(
    uEnvironmentRotation.x * mapX + uEnvironmentRotation.y * mapZ,
    cos(polar),
    -uEnvironmentRotation.y * mapX + uEnvironmentRotation.x * mapZ
  );
  return environmentPdf(direction);
}

// ---- Microfacet pieces ----

float ggxDistribution(float alpha, float cosineHalf) {
  float alphaSquared = alpha * alpha;
  float denominator = cosineHalf * cosineHalf * (alphaSquared - 1.0) + 1.0;
  return alphaSquared / (PI * denominator * denominator);
}

float smithMasking(float alpha, float cosine) {
  float alphaSquared = alpha * alpha;
  return 2.0 * cosine / (cosine + sqrt(alphaSquared + (1.0 - alphaSquared) * cosine * cosine));
}

float schlick(float reflectanceAtNormal, float cosine) {
  float weight = pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0);
  return reflectanceAtNormal + (1.0 - reflectanceAtNormal) * weight;
}

vec3 schlickColor(vec3 reflectanceAtNormal, float cosine) {
  float weight = pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0);
  return reflectanceAtNormal + (1.0 - reflectanceAtNormal) * weight;
}

vec3 sampleVisibleNormal(vec3 view, float alpha, float firstUnit, float secondUnit) {
  vec3 stretched = vec3(alpha * view.x, alpha * view.y, view.z);
  float stretchedLength = length(stretched);
  stretched /= stretchedLength;
  float heightAxis = stretched.z;
  float planeLength = length(stretched.xy);
  vec2 planeDirection = planeLength > 0.0 ? stretched.xy / planeLength : vec2(0.0);
  vec2 tangent = planeLength > 0.0 ? vec2(-stretched.y, stretched.x) / planeLength : vec2(1.0, 0.0);
  vec3 bitangent = vec3(-heightAxis * planeDirection, planeLength);
  float radius = sqrt(firstUnit);
  float angle = TWO_PI * secondUnit;
  float diskX = radius * cos(angle);
  float diskY = radius * sin(angle);
  float blend = 0.5 * (1.0 + heightAxis);
  diskY = (1.0 - blend) * sqrt(1.0 - diskX * diskX) + blend * diskY;
  float lift = sqrt(max(0.0, 1.0 - diskX * diskX - diskY * diskY));
  vec3 normal = vec3(diskX * tangent + diskY * bitangent.xy + lift * stretched.xy, diskY * bitangent.z + lift * heightAxis);
  vec3 unstretched = vec3(alpha * normal.x, alpha * normal.y, max(0.0, normal.z));
  return unstretched / length(unstretched);
}

float roughnessToAlpha(float roughness) {
  return max(roughness * roughness, MINIMUM_ALPHA);
}

// ---- The layered surface ----

mat3 surfaceFrame;
vec3 surfaceView;
float surfaceViewCosine;
vec3 surfaceDiffuse;
vec3 surfaceSpecularNormal;
float surfaceSpecularWeight;
float surfaceSpecularAlpha;
float surfaceCoatWeight;
float surfaceCoatChance;
bool surfaceSampledCoat;
float surfaceCoatAlpha;
float surfaceDiffuseChance;
float surfaceDiffuseShare;
float surfaceSpecularChance;
vec3 surfaceValue;
float surfacePdf;

float dielectricSpecularAlbedo(float normalReflectance, float roughness, float viewCosine) {
  float smoothness = 1.0 - roughness;
  float slope = min(smoothness * smoothness, exp2(-9.28 * viewCosine)) * smoothness + (0.0425 - 0.0275 * roughness);
  float scale = 1.04 - 0.572 * roughness - 1.04 * slope;
  float offset = 1.04 * slope + 0.022 * roughness - 0.04;
  return clamp(normalReflectance * scale + offset, 0.0, 1.0);
}

void prepareSurface(vec3 normal, vec3 view) {
  surfaceFrame = buildFrame(normal);
  surfaceView = view;
  float viewCosine = max(dot(normal, view), 1e-4);
  surfaceViewCosine = viewCosine;
  float ratio = (hitIor - 1.0) / (hitIor + 1.0);
  float dielectricNormalReflectance = ratio * ratio;
  float dielectricFresnel = dielectricSpecularAlbedo(dielectricNormalReflectance, hitRoughness, viewCosine);
  surfaceCoatWeight = hitClearcoat > 0.0 ? hitClearcoat * schlick(DIELECTRIC_COAT_REFLECTANCE, viewCosine) : 0.0;
  float underCoat = 1.0 - surfaceCoatWeight;
  float diffuseShare = (1.0 - hitMetallic) * (1.0 - dielectricFresnel) * underCoat;
  surfaceDiffuse = hitColor * diffuseShare;
  surfaceDiffuseShare = diffuseShare;
  surfaceSpecularNormal = vec3(dielectricNormalReflectance * (1.0 - hitMetallic)) + hitColor * hitMetallic;
  float specularLuminance = luminance(surfaceSpecularNormal);
  surfaceSpecularWeight = underCoat;
  surfaceSpecularAlpha = roughnessToAlpha(hitRoughness);
  surfaceCoatAlpha = roughnessToAlpha(hitClearcoatRoughness);
  float diffuseLuminance = luminance(surfaceDiffuse);
  float specularChance = schlick(specularLuminance, viewCosine) * underCoat;
  float coatChance = surfaceCoatWeight;
  float sum = diffuseLuminance + specularChance + coatChance;
  surfaceDiffuseChance = sum > 0.0 ? diffuseLuminance / sum : 1.0;
  surfaceSpecularChance = sum > 0.0 ? specularChance / sum : 0.0;
  surfaceCoatChance = sum > 0.0 ? coatChance / sum : 0.0;
}

float microfacetTerm(float alpha, float viewCosine, float lightCosine, float halfCosine) {
  return ggxDistribution(alpha, halfCosine) * smithMasking(alpha, viewCosine) * smithMasking(alpha, lightCosine) / (4.0 * viewCosine * lightCosine);
}

void evaluateSurface(vec3 lightDirection) {
  surfaceValue = vec3(0.0);
  surfacePdf = 0.0;
  vec3 normal = surfaceFrame[2];
  float lightCosine = dot(normal, lightDirection);
  if (lightCosine <= 0.0) return;
  vec3 halfVector = surfaceView + lightDirection;
  float halfLength = length(halfVector);
  halfVector /= halfLength == 0.0 ? 1.0 : halfLength;
  float halfCosine = dot(normal, halfVector);
  float viewHalfCosine = max(dot(surfaceView, halfVector), 0.0);
  float viewCosine = surfaceViewCosine;
  surfacePdf += surfaceDiffuseChance * lightCosine / PI;
  surfaceValue += surfaceDiffuse / PI;
  if (surfaceSpecularChance > 0.0 && surfaceSpecularAlpha > MIRROR_ALPHA) {
    float alpha = surfaceSpecularAlpha;
    float term = microfacetTerm(alpha, viewCosine, lightCosine, halfCosine) * surfaceSpecularWeight;
    surfaceValue += schlickColor(surfaceSpecularNormal, viewHalfCosine) * term;
    surfacePdf += surfaceSpecularChance * smithMasking(alpha, viewCosine) * ggxDistribution(alpha, halfCosine) / (4.0 * viewCosine);
  }
  if (surfaceCoatChance > 0.0 && surfaceCoatAlpha > MIRROR_ALPHA) {
    float alpha = surfaceCoatAlpha;
    float reflectance = schlick(DIELECTRIC_COAT_REFLECTANCE, viewHalfCosine) * microfacetTerm(alpha, viewCosine, lightCosine, halfCosine) * (surfaceCoatWeight / max(schlick(DIELECTRIC_COAT_REFLECTANCE, viewCosine), 1e-6));
    surfaceValue += vec3(reflectance);
    surfacePdf += surfaceCoatChance * smithMasking(alpha, viewCosine) * ggxDistribution(alpha, halfCosine) / (4.0 * viewCosine);
  }
}

/** The next direction of a path; returns true for a mirror lobe, which is followed exactly. */
bool sampleSurface(float lobeUnit, float firstUnit, float secondUnit, out vec3 direction) {
  if (lobeUnit < surfaceDiffuseChance) {
    float radius = sqrt(firstUnit);
    float angle = TWO_PI * secondUnit;
    direction = localToWorld(surfaceFrame, vec3(radius * cos(angle), radius * sin(angle), sqrt(max(0.0, 1.0 - firstUnit))));
    return false;
  }
  bool isCoat = lobeUnit >= surfaceDiffuseChance + surfaceSpecularChance;
  surfaceSampledCoat = isCoat;
  float alpha = isCoat ? surfaceCoatAlpha : surfaceSpecularAlpha;
  vec3 localView = worldToLocal(surfaceFrame, surfaceView);
  if (alpha <= MIRROR_ALPHA) {
    direction = 2.0 * surfaceViewCosine * surfaceFrame[2] - surfaceView;
    return true;
  }
  vec3 localHalf = sampleVisibleNormal(localView, alpha, firstUnit, secondUnit);
  vec3 localLight = 2.0 * dot(localView, localHalf) * localHalf - localView;
  direction = localToWorld(surfaceFrame, localLight);
  return false;
}

vec3 mirrorWeight() {
  if (surfaceSampledCoat) return vec3(surfaceCoatWeight / surfaceCoatChance);
  return schlickColor(surfaceSpecularNormal, surfaceViewCosine) * surfaceSpecularWeight / surfaceSpecularChance;
}

float dielectricFresnelTerm(float cosineIncident, float relativeIndex) {
  float sineSquared = relativeIndex * relativeIndex * (1.0 - cosineIncident * cosineIncident);
  if (sineSquared >= 1.0) return 1.0;
  float cosineTransmitted = sqrt(1.0 - sineSquared);
  float parallel = (relativeIndex * cosineIncident - cosineTransmitted) / (relativeIndex * cosineIncident + cosineTransmitted);
  float perpendicular = (cosineIncident - relativeIndex * cosineTransmitted) / (cosineIncident + relativeIndex * cosineTransmitted);
  return 0.5 * (parallel * parallel + perpendicular * perpendicular);
}

bool sampleGlass(vec3 normal, vec3 view, bool entering, float ior, float alpha, float selectionUnit, float firstUnit, float secondUnit, out vec3 direction) {
  mat3 frame = buildFrame(normal);
  vec3 halfVector = normal;
  if (alpha > MIRROR_ALPHA) {
    vec3 localView = worldToLocal(frame, view);
    halfVector = localToWorld(frame, sampleVisibleNormal(localView, alpha, firstUnit, secondUnit));
  }
  float relativeIndex = entering ? 1.0 / ior : ior;
  float cosineIncident = max(dot(view, halfVector), 1e-6);
  float reflectChance = dielectricFresnelTerm(cosineIncident, relativeIndex);
  if (selectionUnit < reflectChance) {
    direction = 2.0 * dot(view, halfVector) * halfVector - view;
    return dot(direction, normal) > 0.0;
  }
  float cosineTransmitted = sqrt(max(0.0, 1.0 - relativeIndex * relativeIndex * (1.0 - cosineIncident * cosineIncident)));
  float bend = relativeIndex * cosineIncident - cosineTransmitted;
  direction = bend * halfVector - relativeIndex * view;
  return dot(direction, normal) < 0.0;
}

// ---- Fog ----

/** Narrows [entry, exit] to where the ray is inside the slab of one axis; false when it misses the box on that axis. */
bool clipAxis(float origin, float direction, float minimum, float maximum, inout float entry, inout float exitDistance) {
  if (direction == 0.0) return origin >= minimum && origin <= maximum;
  float first = (minimum - origin) / direction;
  float second = (maximum - origin) / direction;
  entry = max(entry, min(first, second));
  exitDistance = min(exitDistance, max(first, second));
  return true;
}

bool volumeInterval(vec3 origin, vec3 direction, float limit, out vec2 span) {
  float entry = 0.0;
  float exitDistance = min(limit, uVolumeShape.z);
  if (!clipAxis(origin.x, direction.x, uVolumeMinimum.x, uVolumeMaximum.x, entry, exitDistance)) return false;
  if (!clipAxis(origin.y, direction.y, uVolumeMinimum.y, uVolumeMaximum.y, entry, exitDistance)) return false;
  if (!clipAxis(origin.z, direction.z, uVolumeMinimum.z, uVolumeMaximum.z, entry, exitDistance)) return false;
  if (!(entry < exitDistance)) return false;
  span = vec2(entry, exitDistance);
  return true;
}

float henyeyGreensteinPhase(float anisotropy, float cosine) {
  float squared = anisotropy * anisotropy;
  return (1.0 - squared) / (4.0 * PI * pow(1.0 + squared - 2.0 * anisotropy * cosine, 1.5));
}

float sampleHenyeyGreensteinCosine(float anisotropy, float unit) {
  if (abs(anisotropy) < 1e-3) return 1.0 - 2.0 * unit;
  float squared = anisotropy * anisotropy;
  float ratio = (1.0 - squared) / (1.0 - anisotropy + 2.0 * anisotropy * unit);
  return clamp((1.0 + squared - ratio * ratio) / (2.0 * anisotropy), -1.0, 1.0);
}

// ---- One path ----

vec3 throughput;
vec3 radiance;
vec3 direction;
vec3 lightDirection;
vec3 lightRadiance;
bool inMedium = false;
float selectionProbability = 1.0;
float environmentSampledPdf = 0.0;
mat3 sunFrame;
vec3 featureAlbedo;
vec3 featureNormal;
float featureDepth;
float firstLegEscaped = 0.0;

void addRadiance(int depth, vec3 amount) {
  if (depth > 0) {
    float peak = max(amount.x, max(amount.y, amount.z));
    if (peak > uFireflyClamp) amount *= uFireflyClamp / peak;
  }
  radiance += amount;
}

float fogTransmittance(vec3 origin, float distance) {
  if (!uHasVolume) return 1.0;
  vec2 span;
  if (!volumeInterval(origin, lightDirection, distance, span)) return 1.0;
  return exp(-uVolumeShape.x * (span.y - span.x));
}

float environmentWeight(float candidatePdf) {
  float lightPdf = environmentSampledPdf * selectionProbability;
  float total = lightPdf * lightPdf + candidatePdf * candidatePdf;
  return lightPdf * lightPdf / total / lightPdf;
}

float directWeight(int mode, float candidatePdf) {
  if (mode == 1) return environmentWeight(candidatePdf);
  return 1.0 / selectionProbability;
}

// A shadow ray is recorded by addDirect and traced by flushShadowRay, so the whole shader holds one copy of the
// shadow-ray traversal (a compiler inlines every call, and a copy per light type took minutes to compile).
vec3 shadowOrigin;
vec3 shadowDirection;
float shadowLimit;
vec3 shadowAmount;
int shadowDepth;
bool shadowPending = false;

void addDirect(int depth, vec3 normal, float distance, int weightMode) {
  if (inMedium) {
    float cosine = dot(lightDirection, direction);
    float phase = henyeyGreensteinPhase(uVolumeShape.y, cosine);
    float scale = phase * fogTransmittance(hitPoint, distance) * directWeight(weightMode, phase);
    shadowOrigin = hitPoint;
    shadowAmount = throughput * lightRadiance * scale;
    shadowDepth = depth + 1;
  } else {
    float cosine = dot(normal, lightDirection);
    if (cosine <= 0.0) return;
    evaluateSurface(lightDirection);
    vec3 value = surfaceValue;
    if (value.x + value.y + value.z <= 0.0) return;
    shadowOrigin = hitPoint + normal * uSurfaceOffset;
    float scale = cosine * directWeight(weightMode, surfacePdf) * fogTransmittance(shadowOrigin, distance);
    shadowAmount = throughput * value * lightRadiance * scale;
    shadowDepth = depth;
  }
  shadowDirection = lightDirection;
  shadowLimit = distance;
  shadowPending = true;
}

void flushShadowRay() {
  if (!shadowPending) return;
  shadowPending = false;
  if (!occluded(shadowOrigin, shadowDirection, shadowLimit)) addRadiance(shadowDepth, shadowAmount);
}

bool reaches(int bit) {
  return inMedium || ((hitMask >> uint(bit)) & 1u) == 1u;
}

float aimAt(vec3 target, out float distanceSquared) {
  vec3 delta = target - hitPoint;
  distanceSquared = dot(delta, delta);
  float distance = sqrt(distanceSquared);
  lightDirection = delta / distance;
  return distance;
}

vec3 randomOnSphere(float radius) {
  float height = 2.0 * nextRandom() - 1.0;
  float angle = TWO_PI * nextRandom();
  float ring = sqrt(1.0 - height * height);
  return vec3(radius * ring * cos(angle), radius * height, radius * ring * sin(angle));
}

float pointLightFalloff(float distanceSquared, float range, float radius) {
  float cutoff = 1.0;
  if (range > 0.0) {
    float ratio = distanceSquared / (range * range);
    float fade = max(1.0 - ratio * ratio, 0.0);
    cutoff = fade * fade;
  }
  return cutoff / max(distanceSquared, radius * radius);
}

/** Draws one emitter's contribution into the pending shadow ray: emitter 0 is the sun when there is one, then the lights, then the sky. */
void sampleEmitter(int depth, vec3 normal, int emitter) {
  float distance = 0.0;
  int weightMode = 0;
  if (uHasSun && emitter == 0) {
    if (!reaches(0)) return;
    float cosineTheta = 1.0 - nextRandom() * (1.0 - uSunCosineMax);
    float sineTheta = sqrt(max(0.0, 1.0 - cosineTheta * cosineTheta));
    float phi = TWO_PI * nextRandom();
    lightDirection = sunFrame[0] * (sineTheta * cos(phi)) + sunFrame[1] * (sineTheta * sin(phi)) + sunFrame[2] * cosineTheta;
    lightRadiance = uSunColor;
    distance = uFarDistance;
  } else {
    int index = emitter - (uHasSun ? 1 : 0);
    if (index < uLightCount) {
      int base = index * LIGHT_TEXELS;
      vec4 positionType = fetchData(uLights, base);
      vec4 colorBit = fetchData(uLights, base + 1);
      vec4 directionRadius = fetchData(uLights, base + 2);
      vec4 acrossCone = fetchData(uLights, base + 3);
      vec4 alongBlend = fetchData(uLights, base + 4);
      vec4 intensityRange = fetchData(uLights, base + 5);
      int type = int(positionType.w);
      if (!reaches(int(colorBit.w))) return;
      float distanceSquared;
      if (type == 2) {
        float across = (nextRandom() - 0.5) * directionRadius.w;
        float along = (nextRandom() - 0.5) * acrossCone.w;
        vec3 point = positionType.xyz + acrossCone.xyz * across + alongBlend.xyz * along;
        distance = aimAt(point, distanceSquared);
        float emitCosine = -dot(directionRadius.xyz, lightDirection);
        if (distance < 1e-6 || emitCosine <= 0.0) return;
        lightRadiance = colorBit.rgb * (intensityRange.x * emitCosine / distanceSquared);
      } else {
        vec3 jitter = randomOnSphere(directionRadius.w);
        distance = aimAt(positionType.xyz + jitter, distanceSquared);
        if (distance < 1e-6) return;
        float mask = 1.0;
        if (type == 1) {
          float inside = -dot(directionRadius.xyz, lightDirection) - acrossCone.w;
          if (inside <= 0.0) return;
          if (alongBlend.w > 0.0 && inside < alongBlend.w) {
            float unit = inside / alongBlend.w;
            mask = unit * unit * (3.0 - 2.0 * unit);
          }
        }
        lightRadiance = colorBit.rgb * (intensityRange.x * pointLightFalloff(distanceSquared, intensityRange.y, directionRadius.w) * mask);
      }
      distance -= uSurfaceOffset;
    } else {
      vec3 sampled;
      float rowUnit = nextRandom();
      float columnUnit = nextRandom();
      float columnJitter = nextRandom();
      float rowJitter = nextRandom();
      environmentSampledPdf = sampleEnvironment(rowUnit, columnUnit, columnJitter, rowJitter, sampled);
      lightDirection = sampled;
      if (!(environmentSampledPdf > 0.0)) return;
      lightRadiance = environmentRadiance(lightDirection);
      distance = uFarDistance;
      weightMode = 1;
    }
  }
  addDirect(depth, normal, distance, weightMode);
}

/**
 * A cheap estimate of the light one local light brings to the hit point: its power over the squared distance, the
 * cosine at the surface and, for a spot light, whether the point is inside the cone. It ignores shadows. The estimate only
 * steers the choice; the chance of the choice is divided out, so the image stays the same in expectation.
 */
float lightImportance(int index, vec3 normal) {
  int base = index * LIGHT_TEXELS;
  vec4 positionType = fetchData(uLights, base);
  vec4 colorBit = fetchData(uLights, base + 1);
  vec4 directionRadius = fetchData(uLights, base + 2);
  vec4 acrossCone = fetchData(uLights, base + 3);
  vec4 intensityRange = fetchData(uLights, base + 5);
  vec3 delta = positionType.xyz - hitPoint;
  float distanceSquared = max(dot(delta, delta), 1e-8);
  vec3 toLight = delta * inversesqrt(distanceSquared);
  float cosine = 0.1 + max(dot(normal, toLight), 0.0);
  float power = luminance(colorBit.rgb) * intensityRange.x;
  int type = int(positionType.w);
  if (type == 2) return power * max(-dot(directionRadius.xyz, toLight), 0.0) * cosine / distanceSquared;
  float coneFactor = 1.0;
  if (type == 1 && -dot(directionRadius.xyz, toLight) - acrossCone.w <= 0.0) coneFactor = 0.0;
  return power * coneFactor * cosine * pointLightFalloff(distanceSquared, intensityRange.y, directionRadius.w);
}

/**
 * Draws one emitter. The sun and the sky keep their uniform share; the local lights split their shares by importance,
 * mixed with a uniform part so no light that could contribute has no chance. With one local light, or none, this is the
 * uniform choice with the same random number.
 */
int chooseEmitterByImportance(vec3 normal, out float probability) {
  float uniformShare = 1.0 / float(uEmitterCount);
  float draw = nextRandom();
  int firstLightEmitter = uHasSun ? 1 : 0;
  float total = 0.0;
  if (uLightCount > 1) {
    for (int index = 0; index < uLightCount; index++) total += lightImportance(index, normal);
  }
  if (!(total > 0.0)) {
    probability = uniformShare;
    return min(int(floor(draw * float(uEmitterCount))), uEmitterCount - 1);
  }
  float lightsShare = float(uLightCount) * uniformShare;
  float cumulative = 0.0;
  int chosen = uEmitterCount - 1;
  probability = uniformShare;
  for (int emitter = 0; emitter < uEmitterCount; emitter++) {
    int index = emitter - firstLightEmitter;
    float share = uniformShare;
    if (index >= 0 && index < uLightCount) share = lightsShare * (0.9 * lightImportance(index, normal) / total + 0.1 / float(uLightCount));
    cumulative += share;
    if (draw < cumulative) {
      chosen = emitter;
      probability = share;
      break;
    }
    probability = share;
  }
  return chosen;
}

/** The first hit lights from every emitter; later hits draw one, and divide by the chance of drawing it. */
void addLights(int depth, vec3 normal) {
  if (depth == 0 || uEmitterCount <= 1) {
    selectionProbability = 1.0;
    for (int emitter = 0; emitter < uEmitterCount; emitter++) {
      sampleEmitter(depth, normal, emitter);
      flushShadowRay();
    }
    return;
  }
  if (IMPORTANT_LIGHTS) {
    int chosen = chooseEmitterByImportance(normal, selectionProbability);
    sampleEmitter(depth, normal, chosen);
    flushShadowRay();
    return;
  }
  selectionProbability = 1.0 / float(uEmitterCount);
  sampleEmitter(depth, normal, int(floor(nextRandom() * float(uEmitterCount))));
  flushShadowRay();
}

void addEscape(int depth, float previousPdf, bool afterMirror) {
  if (!uHasEnvironment) return;
  vec3 sky = environmentRadiance(direction);
  float weight = 1.0;
  if (!afterMirror) {
    float environmentSide = environmentPdf(direction) * selectionProbability;
    weight = previousPdf * previousPdf / (previousPdf * previousPdf + environmentSide * environmentSide);
  }
  addRadiance(depth, throughput * sky * weight);
}

bool survivesRoulette(int depth) {
  if (depth < RUSSIAN_ROULETTE_START) return true;
  float survival = min(0.95, max(0.05, max(throughput.x, max(throughput.y, throughput.z))));
  if (nextRandom() >= survival) return false;
  throughput /= survival;
  return true;
}

bool scatterInFog(vec3 origin, float segmentLength) {
  vec2 span;
  if (!volumeInterval(origin, direction, segmentLength, span)) return false;
  float eventDistance = span.x - log(1.0 - nextRandom()) / uVolumeShape.x;
  if (eventDistance >= span.y) return false;
  hitPoint = origin + direction * eventDistance;
  return true;
}

${hasSubsurface ? SUBSURFACE_FUNCTIONS : ''}
void tracePath(vec3 origin, vec3 startDirection, uint pixel, uint sampleIndex) {
  resetRandom(pixel, sampleIndex, uSeed);
  radiance = vec3(0.0);
  throughput = vec3(1.0);
  featureAlbedo = vec3(1.0);
  featureNormal = vec3(0.0, 0.0, 1.0);
  featureDepth = 0.0;
  bool featuresRecorded = false;
  direction = startDirection;
  vec3 position = origin;
  float previousPdf = 0.0;
  bool afterMirror = true;
  vec3 normal = vec3(0.0, 1.0, 0.0);
  for (int depth = 0; depth <= uBounces; depth++) {
    bool found = intersectScene(position, direction);
    bool inFog = uHasVolume && scatterInFog(position, found ? hitDistance : uFarDistance);
    if (!inFog && !found) {
      if (depth == 0) firstLegEscaped = 1.0;
      addEscape(depth, previousPdf, afterMirror);
      break;
    }
    bool isGlass = false;
    bool entering = true;
    bool needsLights = true;
    if (inFog) {
      throughput *= uVolumeAlbedo;
      inMedium = true;
    } else {
      entering = dot(hitNormal, direction) < 0.0;
      normal = entering ? hitNormal : -hitNormal;
      isGlass = hitTransmission > 0.0 && nextRandom() < hitTransmission;
      if (!featuresRecorded) {
        featureAlbedo = isGlass ? vec3(1.0) : hitColor;
        featureNormal = normal;
        featureDepth = hitDistance;
        featuresRecorded = true;
      }
      addRadiance(depth, throughput * hitEmission);
      needsLights = !isGlass;
      if (needsLights) {
        prepareSurface(normal, -direction);
${hasSubsurface ? SUBSURFACE_SPLIT : ''}
      }
    }
    if (needsLights) addLights(depth, normal);
    inMedium = false;
    if (inFog) {
      float cosine = sampleHenyeyGreensteinCosine(uVolumeShape.y, nextRandom());
      float sine = sqrt(max(0.0, 1.0 - cosine * cosine));
      float azimuth = TWO_PI * nextRandom();
      mat3 frame = buildFrame(direction);
      direction = frame[0] * sine * cos(azimuth) + frame[1] * sine * sin(azimuth) + frame[2] * cosine;
      previousPdf = henyeyGreensteinPhase(uVolumeShape.y, cosine);
      afterMirror = false;
      position = hitPoint;
      if (!survivesRoulette(depth)) break;
      continue;
    }
    if (isGlass) {
      float alpha = roughnessToAlpha(hitRoughness);
      float selectionUnit = nextRandom();
      float firstUnit = nextRandom();
      float secondUnit = nextRandom();
      vec3 glassDirection;
      if (!sampleGlass(normal, -direction, entering, hitIor, alpha, selectionUnit, firstUnit, secondUnit, glassDirection)) break;
      direction = glassDirection;
      if (dot(direction, normal) < 0.0) throughput *= hitColor;
      afterMirror = true;
    } else {
      float lobeUnit = nextRandom();
${hasSubsurface ? SUBSURFACE_LOBE : ''}
      float firstUnit = nextRandom();
      float secondUnit = nextRandom();
      vec3 sampledDirection;
      bool isMirror = sampleSurface(lobeUnit, firstUnit, secondUnit, sampledDirection);
      direction = sampledDirection;
      float cosine = dot(direction, normal);
      if (cosine <= 0.0) break;
      if (isMirror) {
        throughput *= mirrorWeight();
        afterMirror = true;
      } else {
        evaluateSurface(direction);
        if (!(surfacePdf > 0.0)) break;
        throughput *= surfaceValue * cosine / surfacePdf;
        previousPdf = surfacePdf;
        afterMirror = false;
      }
    }
    position = hitPoint + direction * uSurfaceOffset;
    if (!survivesRoulette(depth)) break;
  }
}

${texelBake ? TEXEL_MAIN : CAMERA_MAIN}
  // A sample that went through a NaN or an infinity (a grazing ray, a zero pdf) counts as black, so it cannot spread through the denoiser.
  if (!(all(greaterThanEqual(radiance, vec3(0.0))) && all(lessThan(radiance, vec3(1e30))))) radiance = vec3(0.0);
  if (!(featureDepth >= 0.0 && featureDepth < 1e30)) featureDepth = 0.0;
  if (!(all(greaterThanEqual(featureNormal, vec3(-1.5))) && all(lessThan(featureNormal, vec3(1.5))))) featureNormal = vec3(0.0, 0.0, 1.0);
  if (!(all(greaterThanEqual(featureAlbedo, vec3(0.0))) && all(lessThan(featureAlbedo, vec3(1e30))))) featureAlbedo = vec3(1.0);
  float sampleLuminance = luminance(radiance);
  outRadiance = vec4(radiance, featureDepth);
  outAlbedo = vec4(featureAlbedo, 0.0);
  outNormal = vec4(featureNormal, 0.0);
  outStatistics = vec4(sampleLuminance, sampleLuminance * sampleLuminance, firstLegEscaped, 0.0);
}
`;

/**
 * The kernel; `hasSubsurface` compiles in the random walk, which only scenes with a subsurface part need. `texelBake`
 * starts every path at a lightmap texel instead of the camera (see light-bake-gpu.js).
 */
export function buildFragmentSource({ hasSubsurface = false, texelBake = false, blueNoise = false, lightImportance = false } = {}) {
  return buildSource(hasSubsurface, texelBake, blueNoise, lightImportance);
}

export const FRAGMENT_SOURCE = buildFragmentSource();
