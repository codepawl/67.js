# Depth-clipped volume fog

Available from version `0.4.0`.

The fog code is an addon: `import '@codepawlhq/67js/addons/fog-shader'` before the first frame that draws a fog, or a renderer that draws one throws and names this import. Recipes load it by themselves (`await loadAgentSceneModules(recipe)`), and the MCP server and the film player already do.

Enable `{ hdr: true, depth: true }` when constructing an opaque, non-benchmark `Renderer67`. Active fog requires WebGL 2 `EXT_color_buffer_float`. Unsupported HDR negotiation rejects active fog. The depth option retains a resolved depth texture across frames and includes it in `memoryPlan`.

```js
const renderer = new Renderer67(canvas, parts, {
  hdr: true,
  depth: true,
  ground: false,
  environment: {
    lightDirection: [-0.35, 0.55, -0.85],
    volumeFog: {
      density: 0.065,
      minimum: [-5.7, 0.03, -4.7],
      maximum: [5.7, 4.5, 5.5],
      color: [0.9, 0.83, 0.7],
      steps: 24,
      maxDistance: 15,
    },
  },
});
renderer.render({ eye: [0, 2, 5], target: [0, 1, 0], time: 0 });
```

## Controls

`environment.volumeFog` defines one axis-aligned world-space volume. `frame.environment.volumeFog` replaces the whole constructor fog object for that frame. Omitted fields use the following defaults. Set `density: 0` to disable it.

| Field | Default | Accepted range |
| --- | --- | --- |
| `density` | `0` | `0…10`, extinction per scene unit |
| `minimum` | `[-100, 0, -100]` | Three components within ±100,000 |
| `maximum` | `[100, 20, 100]` | Three components within ±100,000; greater than minimum after Float32 rounding |
| `color` | `[0.8, 0.85, 0.9]` | Linear RGB, `0…1` |
| `ambient` | `[0.03, 0.035, 0.04]` | Linear RGB, `0…10` |
| `steps` | `16` | Integer `8…48` |
| `anisotropy` | `0.3` | `-0.9…0.9`; positive favors forward scattering |
| `noiseAmount` | `0.5` | `0…1`; zero gives uniform density |
| `noiseScale` | `0.3` | `0.001…100`, inverse scene units |
| `drift` | `[0.03, 0, 0]` | Three components within ±100, scene units per second |
| `maxDistance` | `100` | `0.01…10,000`, ray distance in scene units |
| `shadowAmbient` | derived | `0…1`; the share of `ambient` the fog keeps where the sun's shadow covers it. Left unset, 32 upward rays from the middle of the fog box decide: a closed room keeps 0.15, open ground under a sky keeps 1, and a partly covered scene lands between. Set it to override |
| `field` | none | A fog field, see below |
| `profile` | `'exponential'` | `'exponential'` or `'smoothstep'`; the vertical shape of a layer when a `field` is set |
| `flowStrength` | `1` | `0…100`; how far the noise travels along the field's velocity, as a share of velocity times `flowPeriod` |
| `flowPeriod` | `2` | `0.01…1,000` seconds; how often a noise lookup restarts |
| `detailOctaves` | `1` | Integer `1…3`; noise octaves at 1x, 2x and 4x `noiseScale`. Above 1 the frame compiles the detail step in |
| `detailAmount` | `0.5` | `0…1`; weight of the extra octaves against the base noise, which keeps its own weight |
| `warp` | `0` | `0…4`; domain warp strength in noise cells, for wisps and curls |
| `contrast` | `1` | `0…4`; stretches the noise around its middle, so thin gaps sit next to thick patches |
| `profileSoftness` | `0.5` | `0…0.95`; where the `'smoothstep'` layer top starts to fade, as a share of the layer height. Lower tapers from nearer the floor |
| `keyScattering` | `1` | `0…10`; scales the key light's in-scattering (the shadow-mapped god rays) and leaves `ambient` alone |
| `scatterOctaves` | `1` | Integer `1…4`; above 1 the key light's in-scatter sums octaves that approximate multiple scattering (Wrenninge et al. 2015). Octave n scatters `multiScatter`^n as much, sees `multiExtinction`^n of the extinction and has `multiAnisotropy`^n of the anisotropy. Each octave needs the optical depth to the sun, three extra density taps per step |
| `multiScatter`, `multiExtinction`, `multiAnisotropy` | `0.5`, `0.5`, `0.5` | `0…1` each; the octave factors above. They act only with `scatterOctaves` above 1 |
| `keyTransmittance` | `0` | `0…1`; how much of the fog between a point and the sun dims the key light scattered there (three taps along the light, to the box exit). 0 keeps today's look |
| `surfaceTransmittance` | `0` | `0…1`; the same dimming for the key light on a lit surface inside the box, so a dense haze dims a sunlit floor. 0 keeps today's look |

Values must be finite numbers. Active volume fog accepts finite frame time within ±1,000,000 seconds and a nonzero light direction with components within ±1,000,000. Noise samples absolute time, so backward seeks reproduce earlier density.

## Fog field: density and velocity per footprint cell

`volumeFog.field` is a 2D texture over the box's x/z footprint that the caller fills each frame, for fog that reacts to things (a character walks through it, a slam pushes it away). 67js only samples it; the simulation is the caller's.

```js
const data = new Float32Array(160 * 160 * 4); // RGBA, row 0 at the box's minimum z, column 0 at its minimum x
// r: density multiplier (1 = the fog as is, 0 = a hole), g: layer height in metres, b: velocity x, a: velocity z (metres per second)
renderer.setFogField({ width: 160, height: 160, data }); // stays until replaced; setFogField(null) clears it
// or per frame: environment: { volumeFog: { density: 1.2, minimum, maximum, profile: 'smoothstep', field: { width: 160, height: 160, data } } }
```

- Density at a point is `density * field.r * profile(y / field.g) * noise`, with `y` measured from `minimum[1]`. `profile` is `exp(-y / g)` for `'exponential'` and `1 - smoothstep(0.5, 1, y / g)` for `'smoothstep'`, a flat body with a soft, readable top. With a field, `heightFalloff` is not used: the field's layer height replaces it.
- The texture is RGBA16F, linear filtered and clamped at the edges, so the field may be coarse. `data` is a `Float32Array` of `width * height * 4` finite values; `width` and `height` are integers within `1…2048`. Anything else throws and names what it wanted.
- A frame with a field uploads it, so rewriting the same `Float32Array` between frames is enough. The same size writes into the existing texture (`texSubImage2D`); a new size allocates a new one. `setFogField` wins over a `field` in the frame or constructor environment.
- Flow: the noise lookup is carried along the field's velocity by two lookups that restart half a `flowPeriod` apart and cross-fade (Vlachos, "Water Flow in Portal 2", 2010), so detail swirls with the flow instead of drifting one way. It depends on frame time and the field only, so the same time and field give the same pixels after any seek. The constant `drift` still applies. Noise contrast dips slightly mid-fade, as in any flow map.
- A fog without a field is drawn by the program it had before, pixel for pixel. The first frame with a field or a light compiles its program before drawing.

## Point and spot lights in the fog

Every point and spot light of the frame (`environment.pointLights`, `spotLights`) scatters in the march: points first, then spots, at most 8. Each uses the light's range window and inverse square (the same as lit surfaces, with the light's radius floored at 0.1 m so the glow has no spike), the spot cone, its colour times intensity and the fog's Henyey-Greenstein phase. There are no shadows and no light linking in the fog. Light beyond the eighth is left out.

## Sky visibility of the fog

Pass `fogSkyVisibility` from `src/fog-sky-visibility.js` to `Renderer67` (the agent preview and the reference harness do) and the fog's ambient follows a per-point sky visibility instead of one share for the whole box. `skyVisibilityGrid` in `src/closed-room.js` shoots 24 fixed upward rays from the centre of each cell of a grid over the fog box (at most 2,048 cells and 32 along an axis), once per scene and fog box, and the result is uploaded as one 8-bit 3D texture. The post shader samples it with trilinear filtering in the shadowed fog: a point that sees any sky keeps all of the ambient, a point that sees none keeps 0.1 of it, and fog the sun reaches keeps all of it as before. Without the option, or when volume fog is off, the sampling is compiled out of the post shader and the frame is drawn by the program it had before. A scene of more than 150,000 triangles has no grid and draws as before. The rays run on the CPU: 0.03 s for `dark-shaft` (1,120 triangles) and 1.7 s for `temple-hall` (11,892 triangles) at scene build. A recipe that sets `shadowAmbient` keeps it and gets no grid.

The same option carries a second term, the light that surfaces give the fog. The renderer passes its frame `environment` to the option, and `fogBounceGrid` (`src/fog-bounce.js`) shoots 64 fixed rays from the centre of each cell of the same grid, takes the nearest surface each ray hits, and sums what that surface sends back: its emission plus the point lights that reach it times its albedo over pi (the light bake's `createDirectIrradiance`, with shadow rays). The mean over the rays is the radiance isotropic scattering at the cell sends to the eye. The grid is one `RGBA16F` texture, sky visibility in red and the bounce in green, blue and alpha, and the shader adds 0.6 of the bounce to the fog's scattering. A glowing window or a lamp therefore lights the fog around it, which the sky grid could not. Parts with an emissive map (a baked part carries its lightmap there) and the sun add nothing: the sun's bounce made `dark-shaft` worse (fog region 0.1282 to 0.1764 against Cycles), because the fog's ambient already stands in for it in a lit room. The scalar grid is isotropic, so it cannot follow the forward-scattering lobe (`anisotropy`) toward a window the camera looks at; that is why the weight is below 1. A scene with no emissive part and no point light builds an all-zero bounce and draws as before. Building it costs 0.3 s for `temple-hall` (11,892 triangles) and 0.07 s for `dark-shaft`, on top of the sky rays.

## Lighting and depth

The fullscreen march clips against resolved opaque depth, supports perspective and orthographic cameras, and stops at the volume boundary or maximum distance. It integrates Beer-Lambert extinction and directional single scattering with a Henyey-Greenstein phase function. It uses the existing directional shadow map and key-light color. Keep authored shadow bounds aligned with the light direction and covering the medium.

Parts also take `receiveShadow`, `holdout`, `shadowCatcher` and `visible`; see [agent-scene.md](agent-scene.md#visibility-and-render-flags). `part.castShadow: false` excludes a mesh from shadow rendering while keeping it visible and opaque in the color/depth pass. The flag defaults to true and must be boolean. Shadow-casting groups use separate batches. Changing a part's casting regime requires a new renderer. `updateParts()` rejects that change. A luminous window can omit its shadow, but remains an opaque emissive surface rather than transparent glass.

## Cost and limits

Resolved depth adds four estimated bytes per rendered pixel, or 2,073,600 bytes at 960 × 540. The planner reduces render dimensions when needed. The target is allocated at construction/resize, reused across frames and released by `dispose()`. The march adds no additional volume textures or geometry, but shading cost grows with covered pixels and step count.

This implements one bounded medium, a directional source with shadows and up to 8 unshadowed point and spot lights. Multiple scattering, attenuation toward the source, transparent depth, volume grids, particles, temporal accumulation and half-resolution rendering remain unfinished. The legacy film explosion is separate and does not use this depth-clipped medium. Fog runs after bloom extraction, so scattering itself does not feed bloom.

Measured at 1920 × 1080 with 24 steps on an RTX 3060 shared with other jobs, whole frame (a small scene, fog and read-back): the fog as before 3.6 to 3.7 ms; with a field 4.8 to 5.1 ms (about 1.3 ms more); with 8 point lights 7.3 to 7.4 ms (about 0.46 ms per light); both 8.6 to 8.8 ms. Numbers move with other jobs on the card.

Run `node scripts/smoke-volumetric.mjs` with the development server running for native GPU extinction, foreground clipping, directional shadow, long-distance ray, resource reuse and disposal checks. Run `node scripts/benchmark-volumetric.mjs` for a fixed laboratory comparison and deterministic noise seeking. These fixtures establish behavior, not cinematic trailer quality.

In a scene with an irradiance grid (`bake.irradianceGrid`) the bounce term is the grid's mean light at the cell instead of the fog's own 64 rays: the grid already holds the sun's bounce, the lights and the emission over several bounces, so the sun is not left out there. The fog's ambient then stands for the sky only (it follows the cell's sky visibility, with no floor for the sun's shadow), because the grid replaces what the ambient stood in for. Measured on the reference halls (FLIP against Cycles, lower is better): `temple-hall-a` 0.1454 to 0.1323, `temple-hall-b` 0.1211 to 0.1085, `temple-hall-c` 0.1078 to 0.0874, `temple-hall` 0.0576 to 0.0513. `dark-shaft`, a small room with dense fog, goes from 0.0569 to 0.0732: the grid's light in its shade is about three times the fog's old stand-in, and Cycles draws that shade darker still.

## Local volumes

`environment.localVolumes` holds up to 8 boxes, spheres or parts that absorb and emit light: candle haze, a smoke puff, a glowing cloud in one place. They need no `volumeFog`. With `scatter` at its default `0` they do not scatter, so the sun and the sky do not light them; they only dim what is behind them and add their own glow. Raise `scatter` to light them (see "Lit volumes"). A scene without `localVolumes` draws exactly as before and compiles nothing extra.

```json
{ "environment": { "localVolumes": [
  { "shape": "sphere", "center": [0, 1.2, 0], "radius": 0.8, "density": 3, "absorption": [1, 1, 1], "emission": [1, 0.45, 0.1], "emissionStrength": 4, "noiseAmount": 0.6, "noiseScale": 2 }
] } }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `shape` | `box` | `box` takes `size: [width, height, depth]`, `sphere` takes `radius`, `mesh` takes `part` |
| `center` | required for `box` and `sphere` | World position |
| `part`, `fit` | required, `bounds` | `mesh` only. `part` names a part of the scene; `fit` is `bounds` or `mesh` (see below) |
| `density` | `1` | `0` to `100`. Extinction per unit length at the core |
| `absorption` | `[1, 1, 1]` | Per colour channel share of the density, `0` to `1`. A larger value dims that channel more, so `[0.1, 0.6, 1]` removes blue first and leaves a warm tint |
| `emission`, `emissionStrength` | `[0, 0, 0]`, `1` | Glow colour and its radiance per unit length at the core, `0` to `1000`. Emission does not depend on `density`, so `density: 0` is a pure glow |
| `falloff` | `0.5` | `0` to `1`. The outer share of the volume over which the density fades to zero (`0` is a hard edge) |
| `scatter` | `0` | `0` to `1`. The share of the light the volume extinguishes that it scatters back instead of absorbing, lit by the key light and the sky (see "Lit volumes"). `0` draws exactly as before. Not allowed with `fit: "mesh"` |
| `noiseAmount`, `noiseScale` | `0`, `1` | `noiseAmount` `0` to `1` breaks the density up with value noise at `noiseScale` cells per unit: the profile is multiplied by `mix(1, 2 * noise, noiseAmount)`. The rasterizer and the CPU path tracer read the same field. A `fit: "mesh"` volume ignores it |
| `steps` | `16` | `4` to `32` samples through the volume; below about 12 a fine pixel-pitch dither shows in dense smoke (8 steps measured), the default 16 is clean |

Each volume is marched on its own between its entry and its exit, cut at the first surface, and the volumes are composited nearest entry first. Overlapping volumes are therefore an approximation. Local volumes are drawn before `volumeFog`, so a fog in front of a puff also dims it. They need the same renderer as the fog (`hdr: true`, `depth: true`, an opaque canvas) and are drawn in the post pass, so they are not in the lightmap bake: a scene bake (`bake` in a recipe) leaves them out, an emissive volume lights no baked surface and no volume dims the baked light, and the bake report names them in `skippedLocalVolumes` (index, shape, whether emissive) with a `warnings` line. A scene without local volumes bakes and reports exactly as before. Add a point light or an emissive part where the volume's glow should reach a wall. The path tracer traces them on `backend: "cpu"` with the same fields, noise included, and every other tracer entry point (backends `gpu`, `webgpu` and `native`, the progressive and both realtime tracers, the GPU light bake) throws `environment.localVolumes is traced by the CPU path tracer only` instead of leaving them out. The GPU tracers are refused, not ported: each would need a second march loop in its kernel and a volume table in every pack, for a feature the CPU tracer already draws. Cost grows with the covered pixels times `steps` times the number of volumes that the pixel's ray crosses; a ray that misses every volume pays only the interval test.

### Lit volumes

A volume with `scatter` above `0` returns, in each step, `scatter * (1 - exp(-extinction * step))` of the light it dims, per colour channel, times the light that arrives at that point: the sky term plus the key light. Smoke or haze in sun then reads bright on the side toward the sun and grey in shade, where a `scatter: 0` volume draws as a dark stain.

- The key light uses the same shadow map lookup (`keyVisibility`) and phase function (`henyeyGreenstein`, isotropic here) as `volumeFog`, times `exp(-depth * 5)` where `depth` is the volume's own optical depth between the point and the volume's far side toward the sun (three midpoint taps of its smooth profile, without the noise, so the noise does not speckle the shading). The direction of those taps is the sun's with its elevation cut to a tenth (`LOCAL_VOLUME_SUN_FLATTEN`): a low sun reaches a smoke box through its top face as fast as through its side, which made the top edge glow as bright as the sunward edge and hid the gradient across the form, and the many scatters of a real smoke spread the light sideways anyway. The factor 5 (`LOCAL_VOLUME_SHADOW_STRENGTH` in `src/local-volumes.js`) counts the depth more than once so the shaded side stays dark; the key light is also scaled by `LOCAL_VOLUME_KEY_GAIN` (8), the many scatters of a thick smoke that one isotropic scatter leaves far dimmer. Together they make the sunward side clearly brighter than the shaded side. Only the key light and the sky light a volume: point, spot and area lights do not.
- The sky term is the mean of `skyTop` and `skyBottom` times `ambientIntensity` in the rasterizer, and the mean radiance of `environment.map` in the CPU path tracer. With an environment map the rasterizer still reads `skyTop` and `skyBottom`. It passes through the volume's own depth too: the mean of `exp(-depth)` over the up direction and the four horizontal directions, one midpoint tap each of the smooth profile, so the middle of a thick smoke is darker than its rim instead of glowing as evenly as the edge. It is then scaled by `LOCAL_VOLUME_SKY_GAIN` (0.2): the sky lights the whole volume evenly, so a larger share veils the form the sun gives it and washes out what sits inside.
- The CPU path tracer uses the same model on `backend: "cpu"`: the sky term, a shadow ray toward the sun, and the same three taps. The sun's colour is `keyColor` there.
- A scene with a lit volume draws the key light's shadow map for the post pass, as a fog does. A volume with `scatter: 0` pays nothing extra per step.
- Measured (`tests/local-volume-scatter.test.js`, a density 1.2 smoke box under a side sun over an even grey sky, seen from above; 64 px rasterizer on SwiftShader against the 32 px, 16 sample CPU tracer): the worst of 64 regions differed by 0.0001 of linear radiance and the whole frame matched to four places (0.3351 both), inside the 0.01 and 0.005 tolerances. The half toward the sun read 0.341 and the shaded half 0.329 in both renderers. On the 960 x 540 smoke still (sun from the right, a 3.2 x 2.4 x 3.2 box) the right third of the smoke is about 14 to 17 percent brighter than the left third in displayed luma; the sun sits in front of the box, so no setting of the two factors takes that far past 20 percent without clipping the sunlit side. The volume pass costs about 2 ms a frame at scatter 0.8 against 0.7 ms at scatter 0. Round 3 (#859): the depth the light crosses counts the faded skin at up to three times its density (`LOCAL_VOLUME_LIGHT_DEPTH_SATURATION`), because a sun ray running along the faded top skin met almost no density and lit it far above the core, which drew a bright rim; the key gain is 3 (a thin smoke returns at most what a sunlit surface of the same albedo does), the shadow strength 3 and the sky gain 0.5. The fade of a box is measured past its core box, so it is round at the corners; the largest-ratio fade drew mitred creases along the box diagonals. A smoke with `falloff` 0.7 and `noiseAmount` 0.5 has no visible box outline.

### Mesh volumes

`shape: "mesh"` takes its place and size from a part, so smoke can fill a room or a modelled shape without writing its numbers twice.

```json
{ "environment": { "localVolumes": [ { "shape": "mesh", "part": "hall", "fit": "mesh", "density": 1.5, "falloff": 0 } ] } }
```

- `fit: "bounds"` (the default) uses the part's bounding box in its own frame, carried through its matrix: an oriented box, tight for a rotated or scaled part. It draws in the rasterizer and the CPU path tracer, and `falloff` fades its edges as for a box.
- `fit: "mesh"` uses the closed mesh itself. The CPU path tracer walks the ray from crossing to crossing, so an L-shaped room or two separate shells are filled exactly, and a ray that leaves the mesh and returns crosses both pieces. The mesh has no distance field, so `falloff` is ignored (the density is the same everywhere inside), and so is `noiseAmount`.
- The rasterizer draws the closed mesh in a mesh pass before the post pass: each `fit: "mesh"` part is drawn without culling into a float buffer, adding the distance of every back face and subtracting that of every front face along each pixel's ray, each clamped to the first opaque surface. That sum is the length of the ray inside the mesh, exact for any number of shells and any shape, so there is no shell limit; the post shader then integrates the volume over that length in closed form (the light behind is dimmed by `exp(-density * absorption * length)`, the emission adds `emission * (1 - exp(-k * length)) / k`). `steps` has no effect on a mesh fit, because nothing is stepped. Volumes are still composited nearest entry first. On the L-room test (`tests/local-volume-mesh-raster.test.js`, density 1) the rasterizer's transmittance stays within 0.03 of the CPU tracer's (the test tolerance; measured differences were 0.0014 or less) and the notch of the L is exactly clear.
- The rasterizer needs the mesh to be closed and every face to wind the same way (either outward or inward; it detects which): an open mesh throws `environment.localVolumes[n].part "x" is not a closed mesh (k open edges)`, and faces wound against each other throw `... has faces wound against each other (k edges)`. It needs `EXT_float_blend` and a buffer as wide as the canvas and as tall as the canvas times the number of `fit: "mesh"` volumes (RG32F, 8 bytes per pixel each; at 1920 x 1080 that is 16.6 MB per volume), and throws with the limit when the device cannot make it. Geometry nearer than the camera's near plane is clipped, so a ray loses the stretch between the eye and the near plane; the automatic near plane counts only visible parts, so a hidden volume part that sits nearer the camera than everything visible needs an explicit camera `near`. A mesh that crosses the far plane keeps the stretch up to it (the missing back face is made up from the surface or far distance), so smoke fades at the far plane like any other volume. A scene with no `fit: "mesh"` volume allocates nothing and draws nothing extra.
- A part that is `visible: false` is not drawn by the rasterizer and is left out of the traced geometry when a mesh volume names it, so a hidden part can shape smoke without becoming a wall.
- The part must be rigid (not skinned) and have volume. A mesh with open edges has no inside: `fit: "mesh"` throws an error with the part name and the number of open edges. A `part` that names nothing throws `environment.localVolumes[n].part "x" names no part in the scene` with the part names.
- The mesh walk follows at most 64 surface crossings per ray (32 segments inside), so the cost stays bounded; the `steps` of the volume are shared between its segments by length.

### Reference render and frame time

`node bench/reference/local-volumes.mjs gpu` draws a smoky room (a haze box with noise and a glowing noisy puff, `bench/reference/images/local-volumes.png`) and the same room without volumes (`local-volumes-plain.png`), and times both: 960 x 540, 4x MSAA, median of 200 frames with readback, three rounds with the order alternating. On the RTX 3060 shared with other jobs (2026-11-10) the room without volumes took 1.34, 1.25 and 1.07 ms, and with the two volumes 2.13, 2.11 and 1.54 ms, so the pair costs about 0.5 to 0.9 ms at this size (noisy; treat it as a range).

### Not covered yet

The noise is `localVolumeNoise` in `src/fog-shader.js` and `src/local-volume-noise.js`: trilinear value noise on a hash made of multiplies, adds and `fract` only, which rounded the same way on SwiftShader, where it was measured; it is unchecked on hardware GPUs. The fog's `cloudNoise` hashes with `sin`, whose error grows with its argument: on SwiftShader its lattice values differed from a 32-bit JavaScript port by up to 0.3, so the two renderers drew different clouds. The JavaScript port rounds every step to 32 bits. `tests/local-volume-noise.test.js` draws a noisy box (`density` 1.2, `falloff` 0.3, `noiseAmount` 0.9, `noiseScale` 3) in both renderers and compares the light let through in 8 by 8 regions: on SwiftShader the worst region differed by 0.003 and the mean of the whole frame by 0.0008, and the test allows 0.01 and 0.005. The rasterizer starts each pixel's march at an interleaved gradient noise offset (`localVolumeJitter`; a sine hash left clumps of error that read as grain at 8 steps, measured: mid-frequency energy 1.06 with the hash against 0.42 with the gradient noise, 0.41 with no jitter at all, and no grain left at 16 steps or more) and the tracer with its sampler, so single pixels differ by a few percent. Volumes with `noiseAmount` drew with the fog's sine noise before this change, so their pattern moved; the mean density is unchanged. Lighting baked surfaces from a volume's emission is not planned (#809): the bake reports the limit instead.
