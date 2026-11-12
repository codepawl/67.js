// The texel entry of the light bake, appended to kernel.wgsl for a bake: one invocation is one lightmap texel
// (params.sizeBouncesLights.x is the texel count, params.seedAndAtlas.z the sample count). The path starts on the texel's
// surface with a cosine weighted direction, so the radiance it returns is the light that arrives at the texel; the bake
// multiplies by the albedo. Plane 0 of the accumulation holds the radiance sums, plane 1 the sums of first rays that left
// the scene. Same random numbers and weights as `bakeTexels` in src/path-tracer-webgpu-kernel.js.
@group(0) @binding(10) var<storage, read> texelPoints: array<vec4<f32>>;
@group(0) @binding(11) var<storage, read> texelNormals: array<vec4<f32>>;

const TEXEL_WORKGROUP_SIZE: u32 = 64u;

@compute @workgroup_size(64)
fn bakeTexels(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let texelCount = u32(params.sizeBouncesLights.x);
  let texelIndex = id.y * groups.x * TEXEL_WORKGROUP_SIZE + id.x;
  if (texelIndex >= texelCount) { return; }
  let sampleIndex = u32(params.emittersFlagsSample.w);
  let seed = params.seedAndAtlas.x;
  if (params.emittersFlagsSample.y != 0) { sunFrame = buildFrame(params.sunDirection.xyz); }
  let normal = texelNormals[texelIndex].xyz;
  let origin = texelPoints[texelIndex].xyz + normal * params.environmentRotationAndRays.z;
  let firstUnit = (f32(sampleIndex) + hashJitter(texelIndex, sampleIndex, seed, 1u)) / f32(params.seedAndAtlas.z);
  let secondUnit = hashJitter(texelIndex, sampleIndex, seed, 2u);
  let coneRadius = sqrt(firstUnit);
  let angle = TWO_PI * secondUnit;
  let rayDirection = buildFrame(normal) * vec3<f32>(coneRadius * cos(angle), coneRadius * sin(angle), sqrt(max(0.0, 1.0 - firstUnit)));
  tracePath(origin, rayDirection, texelIndex, sampleIndex, false);
  if (!(all(radiance >= vec3<f32>(0.0)) && all(radiance < vec3<f32>(1e30)))) { radiance = vec3<f32>(0.0); }
  accumulation[texelIndex] += vec4<f32>(radiance, 0.0);
  accumulation[texelCount + texelIndex] += vec4<f32>(firstLegEscaped, 0.0, 0.0, 0.0);
}
