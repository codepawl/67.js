import { SUBSURFACE_WALK_STEPS } from './path-tracer-subsurface.js';

// The subsurface random walk of the CPU tracer (path-tracer-subsurface.js and enterSubsurface in path-tracer.js) as GLSL
// pieces. path-tracer-gpu-shader.js splices them into the kernel only for a scene with a part whose subsurface weight is
// above 0, so every other scene compiles the kernel it always did. The per-material block sits in the uSubsurface table
// (path-tracer-gpu-pack.js): two texels per material, (weight, mean free path red, green, blue) and (colour, unused), where
// a colour red of -1 means the base colour.

export const SUBSURFACE_TEXELS = 2;

export const SUBSURFACE_UNIFORM = `
uniform sampler2D uSubsurface;
`;

// Runs right after prepareSurface() and before addLights(), as splitSubsurface() does on the CPU.
export const SUBSURFACE_SPLIT = `
        subsurfaceWeight = splitSubsurface();`;

// Runs right after the lobe unit is drawn, as the subsurface branch of trace() does on the CPU.
export const SUBSURFACE_LOBE = `
      if (subsurfaceWeight > 0.0) {
        if (lobeUnit < surfaceSubsurfaceChance) {
          if (!enterSubsurface(depth, normal)) break;
          lobeUnit = 0.0;
        } else {
          lobeUnit -= surfaceSubsurfaceChance;
        }
      }`;

export const SUBSURFACE_FUNCTIONS = `
// ---- Subsurface random walk ----

const int WALK_STEPS = ${SUBSURFACE_WALK_STEPS};
const int WALK_EXIT = 0;
const int WALK_THIN = 1;
const int WALK_LOST = 2;
const int SUBSURFACE_TEXELS = ${SUBSURFACE_TEXELS};

float subsurfaceWeight = 0.0;
float surfaceSubsurfaceChance = 0.0;
vec3 walkWeight;
vec3 walkDirection;

/** Moves the subsurface share of the diffuse lobe to the walk; returns the material's weight. */
float splitSubsurface() {
  float weight = fetchData(uSubsurface, hitMaterialIndex * SUBSURFACE_TEXELS).x;
  surfaceSubsurfaceChance = surfaceDiffuseChance * weight;
  surfaceDiffuseChance -= surfaceSubsurfaceChance;
  surfaceDiffuse *= 1.0 - weight;
  return weight;
}

float singleScatterAlbedo(float multipleScatterAlbedo) {
  float albedo = clamp(multipleScatterAlbedo, 0.0, 1.0);
  float root = sqrt(9.59217 + 41.6808 * albedo + 17.7126 * albedo * albedo);
  float offset = 4.09712 + 4.20863 * albedo - root;
  return clamp(1.0 - offset * offset, 0.0, 1.0);
}

/** Walks inward from the entry point until the walk meets the part's own surface; leaves its throughput in walkWeight. */
int randomWalk(vec3 point, vec3 normal, vec3 meanFreePath, vec3 color, int material) {
  vec3 extinction = 1.0 / meanFreePath;
  vec3 albedo = vec3(singleScatterAlbedo(color.r), singleScatterAlbedo(color.g), singleScatterAlbedo(color.b));
  vec3 position = point - normal * uSurfaceOffset;
  mat3 frame = buildFrame(normal);
  float radius = sqrt(nextRandom());
  float angle = TWO_PI * nextRandom();
  float height = sqrt(max(0.0, 1.0 - radius * radius));
  walkDirection = frame[0] * (radius * cos(angle)) + frame[1] * (radius * sin(angle)) - normal * height;
  for (int scatters = 0; scatters <= WALK_STEPS; scatters++) {
    bool found = intersectScene(position, walkDirection, false);
    if (!found || hitMaterialIndex != material) return scatters == 0 ? WALK_THIN : WALK_LOST;
    // One channel draws the distance; weighting by the mean density over the three channels keeps every channel unbiased.
    int hero = min(2, int(floor(nextRandom() * 3.0)));
    float distance = -log(1.0 - nextRandom()) / extinction[hero];
    if (distance >= hitDistance) {
      vec3 attenuation = exp(-extinction * hitDistance);
      float survival = (attenuation.x + attenuation.y + attenuation.z) / 3.0;
      if (!(survival > 0.0)) return WALK_LOST;
      walkWeight *= attenuation / survival;
      return WALK_EXIT;
    }
    if (scatters == WALK_STEPS) return WALK_LOST;
    vec3 falloff = exp(-extinction * distance);
    vec3 scatterDensity = extinction * falloff;
    float density = (scatterDensity.x + scatterDensity.y + scatterDensity.z) / 3.0;
    if (!(density > 0.0)) return WALK_LOST;
    walkWeight *= albedo * scatterDensity / density;
    position += walkDirection * distance;
    float up = 2.0 * nextRandom() - 1.0;
    float azimuth = TWO_PI * nextRandom();
    float ring = sqrt(max(0.0, 1.0 - up * up));
    walkDirection = vec3(ring * cos(azimuth), up, ring * sin(azimuth));
  }
  return WALK_LOST;
}

/**
 * Sends the diffuse light of the hit through its walk. On success the path stands where the walk left (or, for a card with
 * nothing behind it, on the near or far face), normal faces out of that point, the surface is white diffuse there with its
 * lights added, and the throughput carries the walk. False when the walk ended inside the part.
 */
bool enterSubsurface(int depth, inout vec3 normal) {
  vec4 block = fetchData(uSubsurface, hitMaterialIndex * SUBSURFACE_TEXELS);
  vec4 colorBlock = fetchData(uSubsurface, hitMaterialIndex * SUBSURFACE_TEXELS + 1);
  vec3 color = colorBlock.x < 0.0 ? hitColor : colorBlock.rgb;
  int material = hitMaterialIndex;
  vec3 entryPoint = hitPoint;
  uint entryMask = hitMask;
  float entryScale = surfaceDiffuseShare * block.x / surfaceSubsurfaceChance;
  walkWeight = vec3(1.0);
  int outcome = randomWalk(entryPoint, normal, block.yzw, color, material);
  if (outcome == WALK_LOST) return false;
  if (outcome == WALK_EXIT) {
    // The exit hit is the tracer's hit now: its point and (flipped to face out of the part) its normal.
    normal = hitNormal * (dot(hitNormal, walkDirection) < 0.0 ? -1.0 : 1.0);
    throughput *= walkWeight * entryScale;
  } else {
    // A card: half of the colour is reflected on the side the ray came from and half is transmitted diffusely through it.
    hitPoint = entryPoint;
    hitMask = entryMask;
    if (nextRandom() < 0.5) normal = -normal;
    throughput *= color * entryScale;
  }
  surfaceFrame = buildFrame(normal);
  surfaceDiffuse = vec3(1.0);
  surfaceDiffuseChance = 1.0;
  surfaceSubsurfaceChance = 0.0;
  surfaceSpecularChance = 0.0;
  surfaceCoatChance = 0.0;
  surfaceCoatWeight = 0.0;
  addLights(depth, normal);
  return true;
}
`;
