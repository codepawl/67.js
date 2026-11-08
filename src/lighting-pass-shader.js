import { registerShaderFeatureCode } from './shader-registry.js';

// The GLSL of the lighting render passes (diffuse, glossy, shadow, ao, mist), spliced into the main fragment shader by the
// `lightingPass` feature. render-passes.js imports this file, so only a renderer that installs render passes carries it, and
// only a frame that asks for a lighting pass compiles it in. Modes 6 to 10 of renderPassMode, see RENDER_PASS_MODES.
//
// glossyLight collects every specular term: each light's lobe inside illuminate, and the sky or environment reflection. The
// environment term is the same function with a black surface colour, which removes its diffuse half. Diffuse is the rest of
// the lit radiance without emission, so diffuse + glossy + emission is the radiance before fog by construction.
registerShaderFeatureCode('lightingPass', {
  declarations: `#define USES_LIGHTING_PASS (renderPassMode > 5.5)
vec3 glossyLight = vec3(0.0);
`,
  illuminateSpecular: '  if (USES_LIGHTING_PASS) glossyLight += specular * radiance * normalLight;\n',
  probeReflection: '  if (USES_LIGHTING_PASS && ENVIRONMENT_ENABLED) glossyLight += environmentLighting(normal, specularNormal, baseReflectance, viewDirection, reflected, vec3(0.0), metallic, roughness, occlusion, ambientIntensity, skyReflection);\n',
  probeSurroundings: '    if (USES_LIGHTING_PASS) glossyLight += surroundings * reflectance * skyReflection * (1.0 - roughness * 0.55) * mix(1.0, 0.5 * daylight, worldMode) * occlusion * ambientIntensity;\n',
  worldFinal: `  if (USES_LIGHTING_PASS) {
    float mist = 1.0 - exp(-length(worldPosition - eye) * fogDensity);
    vec3 passValue = renderPassMode < 6.5 ? (radiance - glossyLight - emission) * exposure
      : renderPassMode < 7.5 ? glossyLight * exposure
      : vec3(renderPassMode < 8.5 ? visibility : renderPassMode < 9.5 ? occlusion : mist);
    outputColor = vec4(passValue, 1.0);
    return;
  }
`,
});
