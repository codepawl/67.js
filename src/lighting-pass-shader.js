import { registerShaderFeatureCode } from './shader-registry.js';

// The GLSL of the lighting and auxiliary render passes (modes 6 to 18 of renderPassMode, see RENDER_PASS_MODES), spliced into
// the main fragment shader by the `lightingPass` feature. render-passes.js imports this file, so only a renderer that installs
// render passes carries it, and only a frame that asks for one of these passes compiles it in.
registerShaderFeatureCode('lightingPass', {
  declarations: `#define USES_LIGHTING_PASS (renderPassMode > 5.5)
vec3 glossyLight = vec3(0.0);
vec3 environmentLight = vec3(0.0);
uniform float passFloatOutput;
uniform mat4 passCurrentViewProjection;
uniform mat4 passPreviousViewProjection;
uniform mat4 passObjectDeltas[8];
uniform float passVolumeDensity;
uniform vec3 passVolumeColor;
uniform float passMaterialIds[32];
uniform float passTransmission;
uniform vec3 passMaterialAov;
uniform float hasPassAuxMap;
float cryptoHash(float id) {
  uint h = uint(id + 0.5) * 0x9e3779b9u;
  h ^= h >> 16u;
  h *= 0x85ebca6bu;
  h ^= h >> 13u;
  return float((h % 255u) + 1u) / 255.0;
}
`,
  illuminateSpecular: '  if (USES_LIGHTING_PASS) glossyLight += specular * radiance * normalLight;\n',
  probeReflection: `  if (USES_LIGHTING_PASS && ENVIRONMENT_ENABLED) {
    glossyLight += environmentLighting(normal, specularNormal, baseReflectance, viewDirection, reflected, vec3(0.0), metallic, roughness, occlusion, ambientIntensity, skyReflection);
    environmentLight = environmentLighting(normal, specularNormal, baseReflectance, viewDirection, reflected, color, metallic, roughness, occlusion, ambientIntensity, skyReflection);
  }
`,
  probeSurroundings: `    if (USES_LIGHTING_PASS) {
      vec3 envSpecular = surroundings * reflectance * skyReflection * (1.0 - roughness * 0.55) * mix(1.0, 0.5 * daylight, worldMode) * occlusion * ambientIntensity;
      glossyLight += envSpecular;
      environmentLight = envSpecular + color * (1.0 - metallic) * mix(vec3(0.16, 0.20, 0.22), vec3(0.19, 0.25, 0.30) * max(daylight, 0.08), worldMode) * (0.45 + 0.55 * max(normal.y, 0.0)) * occlusion * ambientIntensity;
    }
`,
  worldFinal: `  if (USES_LIGHTING_PASS) {
    float mist = 1.0 - exp(-length(worldPosition - eye) * fogDensity);
    int instanceIndex = int(instanceEmission.w + 0.5);
    vec4 currentClip = passCurrentViewProjection * vec4(worldPosition, 1.0);
    vec2 currentScreen = currentClip.xy / max(currentClip.w, 1e-6) * 0.5 + 0.5;
    vec4 prevClip = passPreviousViewProjection * (passObjectDeltas[min(instanceIndex, 7)] * vec4(worldPosition, 1.0));
    vec2 prevScreen = prevClip.w > 0.0 ? prevClip.xy / prevClip.w * 0.5 + 0.5 : currentScreen;
    vec2 vel = currentScreen - prevScreen;
    vec2 uvCoord = max(textureUV, vec2(0.0));
    vec4 auxSample = hasPassAuxMap > 0.5 ? (BOX_MAPPED ? sampleBox(emissiveMap) : texture(emissiveMap, textureUV)) : vec4(1.0);
    vec3 passValue = renderPassMode < 6.5 ? (radiance - glossyLight - emission) * exposure
      : renderPassMode < 7.5 ? glossyLight * exposure
      : renderPassMode < 8.5 ? vec3(visibility)
      : renderPassMode < 9.5 ? vec3(occlusion)
      : renderPassMode < 10.5 ? vec3(mist)
      : renderPassMode < 11.5 ? (passFloatOutput > 0.5 ? worldPosition : clamp(worldPosition / renderPassDepthRange * 0.5 + 0.5, 0.0, 1.0))
      : renderPassMode < 12.5 ? (passFloatOutput > 0.5 ? vec3(vel, 0.0) : vec3(clamp(vel * 0.5 + 0.5, 0.0, 1.0), 0.0))
      : renderPassMode < 13.5 ? (passFloatOutput > 0.5 ? vec3(uvCoord, 0.0) : vec3(clamp(fract(uvCoord), 0.0, 1.0), 0.0))
      : renderPassMode < 14.5 ? (1.0 - reflectance) * passTransmission * auxSample.r * ((radiance - glossyLight - emission) + color * ambientIntensity * 0.5) * exposure
      : renderPassMode < 15.5 ? passVolumeColor * (1.0 - exp(-length(worldPosition - eye) * passVolumeDensity)) * exposure
      : renderPassMode < 16.5 ? environmentLight * exposure
      : renderPassMode < 17.5 ? vec3(cryptoHash(renderPassObjectBase + instanceEmission.w + 1.0), cryptoHash(passMaterialIds[min(instanceIndex, 31)]), 1.0)
      : passMaterialAov * auxSample.rgb;
    outputColor = vec4(passValue, 1.0);
    return;
  }
`,
});
