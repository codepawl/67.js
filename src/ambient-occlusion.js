export const AMBIENT_OCCLUSION_SAMPLES = 12;

/**
 * Screen-space ambient occlusion from the resolved depth texture alone.
 * The surface normal comes from screen derivatives of the position, so the pass needs no normal buffer.
 * It writes one visibility factor per pixel; the post pass blurs and applies it.
 * The depth texture is read without filtering, so `texelPosition` rebuilds a position at the centre of the texel it read. Rebuilding
 * it at the requested uv puts it up to half a texel off its surface, and on a flat wall seen at a slant that reads as a bump (issue #1126).
 */
export const ambientOcclusionFragment = `#version 300 es
precision highp float;
in vec2 textureCoordinate;
uniform sampler2D sceneDepth;
uniform mat4 inverseViewProjection;
uniform float radius;
uniform float projectionScale;
uniform float aspect;
uniform float orthographic;
out vec4 occlusion;

vec4 texelPosition(vec2 uv) {
  vec2 size = vec2(textureSize(sceneDepth, 0));
  ivec2 texel = ivec2(clamp(uv, 0.0, 0.9999) * size);
  float depth = texelFetch(sceneDepth, texel, 0).r;
  vec4 point = inverseViewProjection * vec4((vec2(texel) + 0.5) / size * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  return vec4(point.xyz / point.w, depth);
}

float interleavedNoise(vec2 pixel) {
  return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
}

void main() {
  vec4 center = texelPosition(textureCoordinate);
  vec3 position = center.xyz;
  if (center.w >= 1.0) {
    occlusion = vec4(1.0);
    return;
  }
  vec3 normal = normalize(cross(dFdx(position), dFdy(position)));
  if (orthographic < 0.5 && dot(normal, position) > 0.0) normal = -normal;
  float screenRadius = min(radius * projectionScale / (orthographic > 0.5 ? 1.0 : length(position)), 0.25);
  float rotation = interleavedNoise(gl_FragCoord.xy) * 6.2831853;
  float total = 0.0;
  for (int index = 0; index < ${AMBIENT_OCCLUSION_SAMPLES}; index++) {
    float fraction = (float(index) + 0.5) / float(${AMBIENT_OCCLUSION_SAMPLES});
    float angle = rotation + float(index) * 2.3999632;
    vec2 offset = vec2(cos(angle), sin(angle)) * sqrt(fraction) * screenRadius;
    vec2 sampleUv = textureCoordinate + vec2(offset.x / aspect, offset.y);
    vec4 neighbour = texelPosition(sampleUv);
    if (neighbour.w >= 1.0) continue;
    vec3 toSample = neighbour.xyz - position;
    float sampleDistance = length(toSample);
    float falloff = 1.0 - clamp(sampleDistance / (radius * 1.5), 0.0, 1.0);
    total += max(dot(normal, toSample) / max(sampleDistance, 0.0001) - 0.15, 0.0) * falloff;
  }
  float visibility = clamp(1.0 - 2.5 * total / float(${AMBIENT_OCCLUSION_SAMPLES}), 0.0, 1.0);
  occlusion = vec4(vec3(visibility), 1.0);
}`;
