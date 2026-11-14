# Light bake

`crucible/addons/light-bake` writes the light that bounces between surfaces into one lightmap texture per part. It is in the current source and not yet published. Recipes reach it through the `bake` section (see below), so MCP agents can bake without code (issue #55).

```js
import { bakeLightmaps } from 'crucible/addons/light-bake';

const { parts: bakedParts, report } = bakeLightmaps(parts, {
  pointLights: environment.pointLights,
  keyColor: environment.keyColor,
  lightDirection: environment.lightDirection,
}, { samples: 128, bounces: 2 });

const renderer = new CrucibleRenderer(canvas, bakedParts, rendererOptions);
```

## In a recipe

```json
{ "bake": { "preset": "standard" } }
```

`bake` (or the `set-bake` operation, `null` clears it) takes a `preset` and optional `samples`, `bounces` and `texelsPerUnit` that override it:

| Preset | samples | bounces | texelsPerUnit |
| --- | --- | --- | --- |
| `draft` | 32 | 1 | 3 |
| `standard` (default) | 128 | 2 | 6 |
| `fine` | 192 | 2 | 7 |

Ranges are 1 to 256 samples, 1 to 8 bounces and 1 to 12 texels per unit. The bake lights the rest pose with the recipe's point lights and key light (key colour times `keyIntensity`). It runs when the scene builds and again only when a part, its matrix, a light, a material or the bake fields change: camera edits, effects edits, motion seeks and renders reuse the result. A bake that passes its time limit fails the edit and leaves the scene as it was. The limit is 90 s when the bake runs on a worker (the MCP preview does this, so it blocks nothing) and 20 s on the page's own thread when there is no Worker. The preview's call deadline grows by the 90 s for a `scene_create` whose recipe has a `bake` and for a `scene_apply` with `set-bake`; other calls keep 30 s. A `scene_apply` also gets it whenever the active scene already has a bake, because an ordinary edit such as moving a part rebakes. The same recipe gives the same lightmap bytes. `scene_inspect` returns `bake`: the resolved fields, `used` (the samples, bounces and texelsPerUnit that were traced), `reduced`, `texels`, `rayWork`, `seconds` (of the run that made the lightmaps), `bakedParts`, `skipped` (name and reason), `reused`, and, while the recipe has `environment.localVolumes`, `skippedLocalVolumes` (index, shape, emissive) and `warnings`: the bake leaves volumes out, read from the recipe on every call, so adding or clearing one updates them without a rebake.

### Work budget

The unwrap gives the texel count before any ray is traced, so the work of a bake is plain arithmetic: path steps, texels x samples x bounces. It reads no clock and does not depend on machine speed, and the same recipe always resolves to the same numbers. Measured on this machine, a path step costs about 1.8 to 3.1 microseconds, in a closed 56 part room and in the 57 node demo room alike (the number of lights did not change it, so it is not counted).

- A preset (all three fields equal to `draft` or `standard`; `fine` has the same numbers as `standard`) is scaled down until it fits 5 million path steps: samples by a fifth and texelsPerUnit by a tenth, repeatedly (samples not below 16, texelsPerUnit not below 1). A hall that still does not fit at that floor gives up one bounce and starts again from the preset, down to one bounce, so a preset bakes any scene the explicit limit allows. That is 9 to 16 s of tracing on an idle machine, under the 20 s inline limit, and a busy machine still finishes inside the 90 s worker limit. `bake.used` shows the result, `bake.reduced` is `true` and `bake.reduction` says what was asked, what ran and how to ask for more (explicit settings). The demo room at `standard` runs at about 64 samples instead of 16 and 2.32 before. A scene that cannot fit even 16 samples, 1 bounce and texelsPerUnit 1 fails with a message to remove parts or lights.
- Explicit `samples`, `bounces` or `texelsPerUnit` (any combination that is not exactly a preset) are never reduced. They are limited by a hard bound of 24 million path steps (about 5 times the demo room at samples 96, bounces 2, texelsPerUnit 3, which bakes in 11 to 17 s), and by the real time limit (90 s on a worker, 20 s inline). Over the bound they fail before any ray is traced and the message names what fits, for example "samples 120 or fewer with texelsPerUnit 12, or texelsPerUnit 8.61 or less with samples 256". Under the bound they run, and one that passes its limit fails with "The scene is unchanged. Try samples 128, or texelsPerUnit 3.5." (half of what was asked); the clock decides only that failure, never what is traced.

A node that hosts cloth is skipped like a hair host: the cloth simulation replaces its geometry every frame, so a lightmap built on the rest geometry would not follow it (and the renderer refuses a light map on geometry without `lightUvs`, which failed every frame after t=0). Baked parts read every other material field live, so motion tracks on colour still work; the lightmap itself is fixed at the rest pose.

## GPU backend

```js
import { bakeLightmapsAsync } from 'crucible/addons/light-bake-gpu';

const { parts: bakedParts, report } = await bakeLightmapsAsync(parts, lighting, { backend: 'gpu', samples: 512, bounces: 2 });
```

`backend` is `cpu` (the default and the reference), `gpu` or `webgpu`, named as for the path tracer's `backend`. `webgpu` runs the same texel bake as WGSL compute (the `bakeTexels` entry of `src/path-tracer-webgpu-kernel.js`, loaded only for this backend), needs `navigator.gpu` instead of WebGL2, takes the same options, limits and report fields (`gpu`, `gpuCompileSeconds`), and gives the same light as `gpu` to within float rounding. Measured on the RTX 3060 (2026-11-09, one run on a loaded machine, \lit-interior\, 28,784 texels, 512 samples, \ench/reference/bake-compare.mjs\): the WebGPU bake takes 0.54 s against 0.76 s on WebGL2 once compiled, its kernel compiles in 0.39 s against 9.1 s, and the mean light differs by 0.0004 percent (gap share 0.0000035). `bakeLightmapsAsync` takes the same arguments and options as `bakeLightmaps` and resolves with the same `{ parts, report }`; the synchronous `bakeLightmaps` throws a `TypeError` for `gpu` and names this addon. A GPU bake rasterizes the texels as the CPU bake does, then sends all covered texels of all parts to the path tracer's kernel in one batch (`src/light-bake-gpu.js`, `src/path-tracer-gpu.js`): the kernel starts a cosine weighted path at each texel, follows `bounces` hits with the tracer's own lights, materials and maps, and returns the light that arrives. The albedo, smoothing, dilation, sky visibility and the baked parts then come from the same code as on the CPU. It is its own addon (`crucible/addons/light-bake-gpu`), so the CPU bake and the core bundle do not carry it. It needs a page with WebGL2 and float render targets (`EXT_color_buffer_float`, `EXT_float_blend`) and throws without them. It takes up to 1,024 parts where the CPU bake takes 256 (`MAX_GPU_BAKE_PARTS`; the texel and ray work limits are the same). It does not take a light with `affects` (the kernel has no light linking) or `skyOnly`, and `report` adds `gpu` and `gpuCompileSeconds` (the kernel compiles once per page). The GPU result is not byte identical to the CPU one: the CPU gatherer treats every part as a diffuse surface, while the kernel also follows specular lobes, clear coat and glass, and it draws other random numbers. On a room of diffuse surfaces the two agree to about 1 percent; a rough dielectric adds about 3 percent of light on the GPU and a glossy floor about 5 (see "Why the GPU light is brighter").


The bake traces cosine-weighted paths from each texel through up to `bounces` reflections. Each hit adds its own emission and the direct light it receives from the point lights and the sun, with shadow rays. A texel stores that light times its own albedo. Direct light is not baked: it stays live, so shadows and moving lights keep working. The stored light is only what has bounced at least once, so a scene needs the same lights at run time that it gave the bake.

Spot lights take the cone and soft edge the renderer uses (`angle`, `penumbra`, default 0.15), with `range` and `radius` as for a point light. An area light is a rectangle that emits from its front side only, with the path tracer's `intensity * cosine / distance squared`. A hit is lit by one shadow ray per area light to a point of the rectangle that changes on every call; the sequence is a hash of the call count, so it repeats exactly, and the many paths of a texel average the soft shadow. At most 8 spot and 7 area lights. A scene without spot or area lights bakes the same bytes as before.

Not baked: the environment map (it already lights every surface at run time) and specular reflection. A metal part reflects no baked light. Fresnel and sheen are ignored.

### Recipe bakes choose the backend themselves

A recipe `bake` built in a runtime on the GPU backend (the MCP server's default, `scene_inspect`, render jobs) traces its lightmaps first on the native ray query tracer when [Cook](https://github.com/codepawl/cook/blob/main/README.md) is installed and built (`bake.backend` is `native`; its texel entry is `bakeTexels` in the same Vulkan kernel as the render jobs, and a failed native bake falls back to the page's GPU kernel with `bake.backendNote`). On `lit-interior` (28,784 texels, 256 samples, `bench/reference/bake-compare.mjs` with a `native` variant, 2026-11-09) the native bake took 0.26 s against 0.30 s on WebGPU and 0.42 s on WebGL2 once compiled, its kernel compiles in 4 ms against 0.36 s and 8.2 s, and the mean light is 0.12 percent above WebGL2 (gap share 0.0032; the first leg of a bake counts as one bounce, so the kernel runs `bounces - 1`). The native bake traces fog and subsurface scattering as the native render job does. Without it the bake traces on the GPU when the page has WebGL2 with `EXT_color_buffer_float` and `EXT_float_blend`, and on the CPU worker otherwise: SwiftShader runtimes (`--backend cpu`), a recipe whose lights use `affects`, or a GPU bake that fails. `scene_inspect` reports `bake.backend` (`cpu` or `gpu`) and, for the GPU, `bake.gpu` and `bake.gpuCompileSeconds`. The CPU path is unchanged, so the same recipe gives the same bytes there. The irradiance grid and probes still trace on the CPU.

## How a part draws it

A baked part is a copy with new geometry and a new material. A plain part (no maps, pattern, layers or emission) gets lightmap UVs from the `uv_unwrap` unwrap in channel 0, and its material gets `emissiveMap` (the lightmap, `srgb`, linear filter, clamped), `emissiveColor [1, 1, 1]` and `emission` set to the brightest texel, so the renderer, its shaders and every scene without a bake stay as they are. The input parts are not changed.

A part with texture maps, a pattern, layers or its own emission cannot lend its emissive map or its UV channel 0, so it takes the light through the renderer's `lightMap` slot instead. Its geometry keeps `uvs` (the unwrap splits vertices along its seams, and each new vertex copies the `uvs` and `colors` of the vertex it came from) and gains `lightUvs`, the second UV set. The material keeps every field and gains `lightMap` (`srgb`, linear filter, clamped) and `lightMapScale` (the brightest texel). The texture holds the light that arrives, not the light times an albedo, and the fragment shader adds `color * (1 - metallic) * lightMap * lightMapScale` under the existing shading, so the pattern or texture (box projected or UV mapped) tints it at run time. The renderer uploads the two UV sets as one four-wide attribute; the shader branch, the sampler and the uniforms compile out of any scene with no `lightMap`. The bake traces such a part with its colour times the mean colour of its base map, so a brick wall reflects brick coloured light and not white light.

Skipped, with the reason in `report.skipped`: transparent parts, a part with a map or layer map (clearcoat, anisotropy, sheen) that reads the second UV set (`TEXCOORD_1`), which the bake would replace with the lightmap atlas, a material tag that draws its own look (water, fire, foliage), skinned or morphing parts, a cloth sheet, and a node that hosts a hair or particle system (its geometry is rebuilt every frame and has no UVs; the recipe bake marks these, which fixed `scene_create` failing with "Textured geometry requires UV channel 0"). Skipped parts still block and reflect light.

GLB export writes `lightUvs` as `TEXCOORD_1` and the light map as the emissive texture on `texCoord` 1, with the base colour factor as `emissiveFactor`. glTF has no light map slot, so a base colour texture does not tint it there: the export is an approximation for viewers, not for reference renders. The path tracer ignores `lightMap` and `emissiveMap` on purpose: it traces indirect light itself, so reading a baked map would count the same light twice.

## Sky visibility alone

`bakeSkyVisibility(parts, lighting, options)` (or `bakeLightmaps` with `skyOnly: true`) shoots one cosine ray per sample from each texel and writes only the occlusion map of the parts that see under 98 percent of the sky. It writes no light and shades nothing, so it takes a second where a bake takes seconds to a minute, and density barely matters (0.5 and 1.5 texels per unit scored the same). On `dark-shaft` and `temple-hall` it gives about half of the improvement a full bake gives (see "Closed rooms without a bake" in `bench/reference/README.md`). The recipe does not use it: a recipe asks for a closed room's bake because `scene_inspect` reports `closed-room-without-bake`.

## Ground bounce without a bake

An open scene with a floor gets the light the floor bounces without a bake and without a frame of extra cost. `groundBounceEnvironment(parts, environment)` from `crucible/addons/ground-bounce` finds the floor (the lowest thin part that spans the scene, with a plain coloured, non-metal, opaque, untextured material) and returns the environment with an `irradianceSource` on its map: a copy whose lower half is `albedo * (keyColor * keyIntensity * max(lightDirection.y, 0) / pi + sky irradiance on a level surface)`. Only the diffuse light reads that copy, so walls and figures get the ground's light while the background and the reflections keep the real sky. The environment is returned unchanged when there is no such floor, a part is baked (its light map holds the bounce), the scene is a closed room, a point, spot or area light is present (the term counts the sun and the sky only), there is no map, or `environment.groundBounce` is `false`. `automaticAlbedo` gives the colour of a floor the preview adds when no part forms one. The floor is taken as unshadowed, level and infinite. `withGroundBounce(map, { albedo, keyColor, lightDirection })` is the same with the floor given by hand. On the `brick-flat` wall the mean luminance goes from 0.556 to 0.609 (Cycles 0.615); see "Ground bounce" in `bench/reference/README.md` for every scene.

## Irradiance grid

`bake: { preset: 'standard', irradianceGrid: true }` (or a node count from 8 to 48 along the longest side; `true` picks up to 48 along the longest side within 8,192 nodes, so the trace fits the bake's time limit) bakes a grid of diffuse light instead of lightmaps. `src/irradiance-grid.js` (a lazy module that loads with the bake) places a node every cell of the parts' bounds, and for each node traces the light that surfaces send toward it along the six axis directions with the bake's gatherer (emission and direct light at every hit, `bounces` reflections, about a quarter of the preset's samples). The six values become first order spherical harmonics per colour channel, stored in one RGBA16F 3D texture (three texels per node). A lit surface reads it with one trilinear lookup and its normal, so the warm light a sunlit floor sends up to the walls and the ceiling costs no ray per frame. A ray that leaves the scene adds nothing, so the sky stays with the environment map, and the grid replaces lightmaps for the scene. Probes still run.

`bake: { irradianceGrid: true, gridFog: true }` lets the grid's paths scatter inside the scene's `volumeFog` (opt in, off by default, so a bake without it keeps its bytes). A path scatters in the fog with the probability a photon would, adds the sun at each scattering, and goes on from the point (up to 8 scatterings), so the fog's bounce light reaches the walls. Use it for a sunlit closed room with fog. Measured against Cycles, it brings the sunlit halls closer and makes a dark shaft too bright, so leave it off there. It needs `irradianceGrid` and a scene with fog.

Nodes inside a solid (most rays hit the back of a face) are filled from their neighbours, and the lookup moves half a cell along the normal. A wall thinner than a cell can still leak light, and the grid is static: it is traced again when the parts, the lights or the bake change, and a part that moves does not move its bounce. The report is `bake.irradianceGrid` (`size`, `cellSize`, `nodes`, `solidNodes`, `seconds`). The sampler has its own texture unit, 16, so it works beside splat layers. A 3x3x3 [1 2 1] filter over the valid nodes' coefficients removes the low-frequency noise of the few samples each node gets.

## Reflection probes

A probe is the room around a point, traced once and prefiltered like an environment map (`createEnvironmentResources`), so a glossy part reflects the room and not only the sky. `src/reflection-probes.js` holds placement and the renderer link; `src/probe-trace.js` traces on the CPU with the bake's ray tracer (direct light, bounced light, emission; a ray that leaves the scene reads the environment map or the sky colours), 64 by 32 texels, 32 samples and 2 bounces, deterministic, about 0.2 to 0.3 s per probe. A part takes the nearest probe whose `radius` reaches the middle of its bounds, else the environment. A probe lights the specular term only: diffuse stays with the environment and the bake. No parallax correction (not built: a probe at the centre of a room is wrong near the walls).

```js
import { applyReflectionProbes } from 'crucible/addons/reflection-probes';
const { parts: probedParts } = applyReflectionProbes(parts, lighting, [{ position: [0, 1.5, 0], radius: 6 }], { environment, environmentMap: environment.map, rotation: environment.map.rotation });
```

In a recipe, `bake.probes` is `'room'` (one probe in the middle of the parts' bounds, kept only when at least 90 percent of its rays hit a part, so an open scene gets none) or a list of up to 4 `{ position, radius? }`; a recipe with `bake` gets `'room'` unless `probes` is set, and `false` opts out. A bake brings the probe along because it lowered the score of all three baked rooms below. The report has `bake.probes` (placed probes, `partsWithProbe`, `skipped`, `glb`). A probe is not written to GLB: glTF has no standard for it.

Cost: a scene without a probe loads none of this and its fragment shader is unchanged (the renderer links through the material field `environmentProbe`, which batches parts by probe, and one shader slot that only a probe scene fills). With a probe the prefilter runs once when the first batch that uses it draws, and nothing after.

Measured against Cycles (FLIP, GPU; `npm run reference -- --skip-blender --probes ...`, 2026-11-01): `lit-interior` 0.5055 to 0.4791, `brick-room` 0.5102 to 0.4828, `metal-room` 0.5128 to 0.4520. Open scenes get worse with a hand placed probe: `material-spheres` 0.1598 to 0.1740, `metal` 0.1868 to 0.2246 (the probe sits among the objects and each sphere reflects itself where it should reflect the others). With the bake on, the probe lowers the score in all three rooms (measured 2026-11-01, `--bake` against `--bake --probes`, GPU): `lit-interior` 0.1444 to 0.1213, `brick-room` 0.1515 to 0.1266, `metal-room` 0.1754 to 0.1537. An earlier note here said the picture was byte identical with and without a probe on a baked room. It was not: rendered side by side in one page, `metal-room` with a bake differs in 507,573 of 518,400 pixels (largest channel step 199) between the two, and the saved PNGs differ. The earlier report is not reproduced, and its cause was not found (a `--scene` run of `npm run reference` does not rescore, so an old score can be read as a new one).

Cost per frame (RTX 3060, `lit-interior`, medians of three alternating rounds of 200 frames, 960 by 540, 2026-11-01): 1.73 ms plain, 1.90 ms with the bake, 2.04 ms with bake and probe, 1.65 ms with a probe alone. The bake and the probe cost a little per frame (the spread between rounds of the same variant was 0.2 ms), so they do not make a frame faster. What the bake replaces is the path tracer for indirect light: 106.7 s for `lit-interior` at 64 samples on the CPU, or 238 s at 32 samples in the first measurement, against about 6 s of bake once.

## Limits

| Option | Default | Range | Meaning |
| --- | --- | --- | --- |
| `samples` | 128 | 1 to 512 | Paths per texel. |
| `bounces` | 3 | 1 to 4 | Reflections followed by each path. |
| `texelsPerUnit` | 6 | 0.5 to 64 | Lightmap density in world units. |
| `maxResolution` | 128 | 4 to 256 | Largest lightmap side for one part. |
| `maxSeconds` | 60 | 1 to 600 | Wall-clock limit. Passing it throws; a bake never returns a partial result. |

Also checked before any ray is traced: at most 256 parts, 200,000 triangles in total, 16 point lights, 1,000,000 texels and 400 million units of ray work (texels, samples, bounces and lights multiplied). Positions, indices, matrices, colours and lights must be finite and in range, and an error names the field.

The result is deterministic: the same parts, lights and options give the same bytes, with no `Math.random` and no clock in the output. `report.seconds` is the only value that varies from run to run.

## Measured

The `lit-interior` reference scene (25,648 texels at the defaults) bakes in about 6 s in the page on an RTX 3060 machine, running at below-normal priority. Its score against Cycles goes from 0.5055 to 0.1444 with the bake (`npm run reference -- --bake lit-interior`; details in `bench/reference/README.md`). Frame time on the same scene (960x540, 4 samples, RTX 3060, below-normal priority, 200 frames read back after each draw, two runs of each in alternating order): median 2.08 and 2.02 ms without the bake, 1.88 and 1.66 ms with it, so the bake costs no measurable draw time (one extra texture read per baked part; the spread between runs is load on the machine). `node bench/reference/frame-time.mjs lit-interior gpu` repeats it. The recipe path on a closed room with 8 boxes bakes 13,184 texels in 4.8 s at `standard`.

### GPU against CPU (issue #302)

`lit-interior` (28,784 texels at texelsPerUnit 6, 3 bounces), RTX 3060, headless Chrome, kernel already compiled, measured 2026-11-04 with `node bench/reference/bake-compare.mjs lit-interior '<variants>'`:

| Bake | Samples | Path steps | Seconds | Mean light against the CPU bake at 512 samples | Mean gap, share of that light |
| --- | --- | --- | --- | --- | --- |
| CPU | 512 | 44.2 M | 17.8 | 1.000 | 0 |
| CPU | 128 | 11.1 M | 6.7 | 1.002 | 0.018 |
| GPU | 128 | 11.1 M | 0.26 | 1.049 | 0.056 |
| GPU | 512 | 44.2 M | 0.70 | 1.054 | 0.055 |

The recipe preset `standard` resolves to 81 samples, 3 bounces and 4.86 texels per unit on this scene (4.7 M path steps, 1.7 s on the CPU), so the GPU bake at 512 samples runs 9.4 times those path steps in 0.70 s. The kernel compiles once per page and that takes 7.4 s, which comes on top of the first GPU bake of a page (a cold `run.mjs` row measured 32 s for the bake with the compile, other sessions using the machine). The GPU light is about 5 percent above the CPU's and the gap does not shrink with samples (0.056 at 128, 0.055 at 512, against 0.018 for the CPU's own noise at 128), so it is a bias, not noise. Its cause is the specular lobe, which the two backends model differently on purpose (see "Why the GPU light is brighter" below). Score of the baked `lit-interior` against Cycles (FLIP, 960 by 540, same Cycles frame): CPU bake 0.1129, GPU bake at 512 samples 0.0914.

#### Why the GPU light is brighter (issue #412)

Measured 2026-11-04 on a closed 8 m room with one lamp (6 walls, 4,098 to 1,836 texels each, `texelsPerUnit` 8, 3 bounces, RTX 3060). Light summed over all texels, GPU divided by CPU:

| Surfaces | GPU / CPU | Bounces and samples |
| --- | --- | --- |
| diffuse only (`ior` 1, no specular lobe) | 1.006 (floor 1.003, ceiling 1.001, walls 1.008 to 1.011) | 3 bounces, 512 samples |
| diffuse only, direct light of the first hit | 1.006 (floor 1.001, ceiling 1.000, walls 1.012 to 1.019) | 1 bounce, 512 samples |
| rough dielectric walls (`roughness` 1, default `ior` 1.5) | 1.029 (1.018 to 1.051 by part) | 3 bounces, 128 samples |
| the same with a glossy floor (`roughness` 0.25) | 1.048 (1.025 to 1.087 by part) | 3 bounces, 128 samples |

The CPU gatherer treats every part as a Lambertian surface of its diffuse albedo. The kernel evaluates the tracer's own material: the diffuse part shrinks by the Fresnel share and the specular lobe (a GGX lobe of F0 0.04 at the default `ior`, the colour for a metal) reflects light from the other surfaces towards the texel. With the lobe switched off the two backends agree to 0.6 percent over the room; the 0.1 to 1.9 percent that is left sits on the walls, not on floor and ceiling, does not move with the lamp radius (0.05 or 0.001), and is not isolated. Every other suspect from #412 was ruled out by that diffuse-only room: the first bounce's cosine weighting, emission and sky (neither is present), the bounce count (both follow `bounces` hits), and Russian roulette (starts after the third hit, so it never runs at 3 bounces or fewer). A texel offset or normal that was wrong would show on the diffuse room too, and it does not beyond the residual above.

Both are right for their own model. The GPU light is the one a path tracer such as Cycles also sees, which is why it scores nearer to Cycles on `lit-interior` (0.0914 against 0.1129); the CPU light is the diffuse-only reference. Use the CPU backend for a lightmap with no light from specular surfaces, and the GPU backend when rooms hold glossy floors, metal or clear coat. `tests/light-bake-backends.test.js` keeps the diffuse agreement under 1 percent and the GPU's extra light on a glossy room above 1.5 percent.

## When to rebake

The bake is traced at the authored pose and is cached by a key over the bake settings, the lights, the materials and the world matrix of every part. Any recipe edit that changes one of them traces again on the next build, so an edit never leaves a stale bake.

Motion is the exception: a motion track can move a light, the sun or a part after the bake was traced, and the baked light stays where it was. When a bake and motion both exist, `scene_inspect` compares the key at the sampled time with the baked key and reports a `bake-stale` diagnostic when they differ. A scene without motion, or at a time where nothing moved, pays nothing and gets no warning. Material animation is not part of the check.

To fix it, bake a pose that stays put (keep lit lights and parts still, or animate only unlit things), or set `bake.rebake` to `true` with `set-bake`. With `rebake`, a frame sampled at a pose whose key differs from the bake in use is lit by a bake traced at that pose: the lights, the sun and the part matrices as motion sets them. The bake is kept by that key for the last 4 poses (least recently used leaves first), so a seek back to a held pose, or a second render at the same time, traces nothing. `bake-stale` is gone because the bake is current, not because it is hidden. The cost is one full bake per new pose: on the closed test room at the `draft` preset, about 0.7 to 0.8 s each on a loaded machine (measured 2026-11-09), so a render that steps through many distinct poses (a moving lamp over 120 frames) pays that every frame; keep rebake for a few key poses or short moves, and leave it off when the scene is final. An edit that does not change the authored pose still reuses the cache.
