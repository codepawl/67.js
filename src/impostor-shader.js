// GLSL for the `impostor` material tag: one camera-facing card per tree that shows the nearest baked view.
// The card is a quad with corners (+-radius, centerHeight +- radius, 0) and uv (0..1, 0 at the top), built by
// vegetation-impostors.js; the shader recovers radius and center height from any one corner, so the card needs no
// extra attribute. The same function runs in the colour and shadow vertex shaders: in the shadow pass the "eye" is
// the light, so the card shows the tree as the sun sees it.

import { materialTags, shaderTransforms } from './shader-registry.js';

/** Frames per side of the hemi-octahedral atlas (the atlas holds this many squared views). */
export const IMPOSTOR_FRAMES = 8;
/** The value of `material.tag === 'impostor'` in the instance data. */
export const IMPOSTOR_TAG = 13;

export const impostorShader = `
// Hemi-octahedral position of a direction in the tree's own frame, in cells: the upper hemisphere fills the square and a
// cell's own view sits at its middle, so the four views around the position can be blended in the fragment shader.
vec2 impostorCellPosition(vec3 localDirection) {
  vec3 folded = vec3(localDirection.x, max(localDirection.y, 0.0), localDirection.z);
  folded /= max(abs(folded.x) + folded.y + abs(folded.z), 0.00001);
  vec2 square = vec2(folded.x + folded.z, folded.x - folded.z) * 0.5 + 0.5;
  return square * ${IMPOSTOR_FRAMES}.0 - 0.5;
}

// Returns the world position of this corner, the atlas uv of the first of the four views around the viewing direction
// and viewBlend: the fractions toward the second view along each axis, then the uv step to it (0 at the atlas edge).
// clipMatrix is the matrix of the pass (camera or light); the eye is where it projects to w = 0, or for an orthographic
// pass a direction.
vec3 impostorCard(vec3 localPosition, vec2 corner, mat4 modelMatrix, mat4 clipMatrix, float seconds, float strength, out vec2 atlasUv, out vec4 viewBlend, out vec3 cardNormal) {
  vec2 side = vec2(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0);
  float radius = abs(localPosition.x);
  float centerHeight = localPosition.y - side.y * radius;
  vec3 center = (modelMatrix * vec4(0.0, centerHeight, 0.0, 1.0)).xyz;
  vec4 apex = inverse(clipMatrix) * vec4(0.0, 0.0, 1.0, 0.0);
  vec3 toEye = normalize(abs(apex.w) > 0.000001 ? apex.xyz / apex.w - center : -apex.xyz);
  vec3 right = cross(vec3(0.0, 1.0, 0.0), toEye);
  float rightLength = length(right);
  right = rightLength > 0.001 ? right / rightLength : vec3(1.0, 0.0, 0.0);
  vec3 cardUp = cross(toEye, right);
  cardNormal = toEye;
  float scale = length(modelMatrix[0].xyz);
  vec3 localDirection = normalize(transpose(mat3(modelMatrix)) * toEye);
  vec2 cellPosition = impostorCellPosition(localDirection);
  vec2 firstCell = clamp(floor(cellPosition), 0.0, ${IMPOSTOR_FRAMES - 1}.0);
  vec2 secondCell = clamp(floor(cellPosition) + 1.0, 0.0, ${IMPOSTOR_FRAMES - 1}.0);
  atlasUv = (firstCell + corner) / ${IMPOSTOR_FRAMES}.0;
  viewBlend = vec4(cellPosition - floor(cellPosition), (secondCell - firstCell) / ${IMPOSTOR_FRAMES}.0);
  float heightFraction = side.y * 0.5 + 0.5;
  float sway = sin(seconds * 1.2 + center.z * 0.31 + center.x * 0.17) * strength * 0.05 * radius * heightFraction * heightFraction;
  return center + (right * (side.x * radius + sway) + cardUp * side.y * radius) * scale;
}
`;

// Importing this module installs a transform that startProgram applies to every shader source: it inserts the card code
// before known lines of the colour vertex, shadow vertex and fragment shaders, so shaders.js carries none of it.
materialTags.impostor = IMPOSTOR_TAG;

// A fade carries its coverage in the opacity: 1 plus the coverage for the outgoing side, 2 plus it for the incoming side.
const ALPHA_COVERAGE = `  if (materialOpacity > 1.0) {
    float biased = materialOpacity - 1.0;
    bool incoming = biased > 1.0;
    float coverage = incoming ? biased - 1.0 : biased;
    float threshold = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (textureAlpha < alphaCutoff || (incoming ? coverage < 1.0 - threshold : coverage <= threshold)) discard;
    return 1.0;
  }
`;

const VIEW_BLEND_OUTPUT = 'out vec4 cardViewBlend;\n';
const COLOR_HOOK = `  cardViewBlend = vec4(0.0);
  if (instanceSurface.w == ${IMPOSTOR_TAG}.0) {
    vec2 atlasUv;
    vec3 cardNormal;
    world.xyz = impostorCard(position, uv, instanceMatrix, viewProjection, time, wind, atlasUv, cardViewBlend, cardNormal);
    uv = atlasUv;
    worldPosition = world.xyz;
    worldNormal = cardNormal;
  }
`;

const DEPTH_HOOK = `  if (instanceSurface.w == ${IMPOSTOR_TAG}.0) {
    vec3 lightFacing;
    vec2 atlasUv;
    vec4 viewBlend;
    world.xyz = impostorCard(position, uv, instanceMatrix, lightProjection, time, wind, atlasUv, viewBlend, lightFacing);
    uv = atlasUv + step(0.5, viewBlend.xy) * viewBlend.zw;
  }
`;

function insertBefore(source, anchor, code) {
  return source.includes(anchor) ? source.replace(anchor, () => code + anchor) : source;
}

// The colour fragment shader samples the atlas through cardUV: the view picked for this pixel among the four around the
// viewing direction, by their bilinear weights against a screen pattern like the fade's (a stochastic blend, so one sample
// a pixel). Gradients still come from textureUV, so mip levels and the normal basis stay smooth across the picks.
const VIEW_BLEND_FRAGMENT = `in vec4 cardViewBlend;
vec2 cardUV;
vec2 pickCardUV() {
  vec2 fraction = cardViewBlend.xy;
  float threshold = fract(52.9829189 * fract(dot(gl_FragCoord.xy + 17.0, vec2(0.06711056, 0.00583715))));
  float afterFirst = (1.0 - fraction.x) * (1.0 - fraction.y);
  float afterSecond = afterFirst + fraction.x * (1.0 - fraction.y);
  float afterThird = afterSecond + (1.0 - fraction.x) * fraction.y;
  vec2 pick = threshold < afterFirst ? vec2(0.0) : threshold < afterSecond ? vec2(1.0, 0.0) : threshold < afterThird ? vec2(0.0, 1.0) : vec2(1.0);
  return textureUV + pick * cardViewBlend.zw;
}
`;

function addViewBlend(source) {
  if (!source.includes('in vec2 textureUV, lightmapUV;') || !source.includes('void main() {')) return source;
  const gradients = 'dFdx(textureUV), dFdy(textureUV)';
  return source
    .replace('texture(baseMap, textureUV)', () => `textureGrad(baseMap, cardUV, ${gradients})`)
    .replace(/texture\(normalMap, normalCoordinates([^)]*)\)/, (match, transform) => `textureGrad(normalMap, cardUV${transform}, ${gradients})`)
    .replace('in vec2 textureUV, lightmapUV;', () => `in vec2 textureUV, lightmapUV;\n${VIEW_BLEND_FRAGMENT}`)
    .replace('void main() {', () => 'void main() {\n  cardUV = pickCardUV();');
}

/** Adds the card and dither code to a shader source that has the lines it hooks into; other sources pass through. */
export function addImpostorCode(source) {
  if (source.includes('float surfaceAlpha(float textureAlpha) {')) return addViewBlend(insertBefore(source, '  if (alphaMode > 1.5) return alpha;', ALPHA_COVERAGE));
  if (!source.includes('uniform float wind;') || !source.includes('void main() {')) return source;
  const isColor = source.includes('worldNormal = normalize(');
  const withDefinitions = insertBefore(source, 'void main() {', (isColor ? VIEW_BLEND_OUTPUT : '') + impostorShader);
  if (isColor) return insertBefore(withDefinitions, "  // Metres along the object's own axes", COLOR_HOOK);
  return insertBefore(withDefinitions, '  textureUV = uv;\n  gl_Position = lightProjection * world;', DEPTH_HOOK);
}

shaderTransforms.push(addImpostorCode);
