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

`part.castShadow: false` excludes a mesh from shadow rendering while keeping it visible and opaque in the color/depth pass. The flag defaults to true and must be boolean. Shadow-casting groups use separate batches. Changing a part's casting regime requires a new renderer. `updateParts()` rejects that change. A luminous window can omit its shadow, but remains an opaque emissive surface rather than transparent glass.

## Cost and limits

Resolved depth adds four estimated bytes per rendered pixel, or 2,073,600 bytes at 960 × 540. The planner reduces render dimensions when needed. The target is allocated at construction/resize, reused across frames and released by `dispose()`. The march adds no additional volume textures or geometry, but shading cost grows with covered pixels and step count.

This implements one bounded medium, a directional source with shadows and up to 8 unshadowed point and spot lights. Multiple scattering, attenuation toward the source, transparent depth, volume grids, particles, temporal accumulation and half-resolution rendering remain unfinished. The legacy film explosion is separate and does not use this depth-clipped medium. Fog runs after bloom extraction, so scattering itself does not feed bloom.

Measured at 1920 × 1080 with 24 steps on an RTX 3060 shared with other jobs, whole frame (a small scene, fog and read-back): the fog as before 3.6 to 3.7 ms; with a field 4.8 to 5.1 ms (about 1.3 ms more); with 8 point lights 7.3 to 7.4 ms (about 0.46 ms per light); both 8.6 to 8.8 ms. Numbers move with other jobs on the card.

Run `node scripts/smoke-volumetric.mjs` with the development server running for native GPU extinction, foreground clipping, directional shadow, long-distance ray, resource reuse and disposal checks. Run `node scripts/benchmark-volumetric.mjs` for a fixed laboratory comparison and deterministic noise seeking. These fixtures establish behavior, not cinematic trailer quality.

In a scene with an irradiance grid (`bake.irradianceGrid`) the bounce term is the grid's mean light at the cell instead of the fog's own 64 rays: the grid already holds the sun's bounce, the lights and the emission over several bounces, so the sun is not left out there. The fog's ambient then stands for the sky only (it follows the cell's sky visibility, with no floor for the sun's shadow), because the grid replaces what the ambient stood in for. Measured on the reference halls (FLIP against Cycles, lower is better): `temple-hall-a` 0.1454 to 0.1323, `temple-hall-b` 0.1211 to 0.1085, `temple-hall-c` 0.1078 to 0.0874, `temple-hall` 0.0576 to 0.0513. `dark-shaft`, a small room with dense fog, goes from 0.0569 to 0.0732: the grid's light in its shade is about three times the fog's old stand-in, and Cycles draws that shade darker still.
