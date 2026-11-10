# Local lights and volume fog

Version `0.4.0` supports local lighting through the renderer's `environment` option and per-frame environment overrides. `pointLights` accepts at most 16 world-space lights with linear RGB colors. `keyIntensity`, `fillIntensity` and `ambientIntensity` control the existing studio lighting.

The workflow has three steps:

1. Set the environment's lighting controls when creating the renderer.
2. Supply the complete `frame.environment.pointLights` list to animate local lights.
3. Inspect exposure and material response at a fixed sample time.

## Move a point light

In the scene below, the studio lights are turned down, so the point light does most of the work. Drag in the picture to move the light across the floor. The slider sets the intensity, and the box turns on a shadow for the light. Every frame passes the whole `pointLights` list in `frame.environment`.

```js live poster=lights-point
import { Renderer67, box, sphere } from '67js';

function placeAt(x, y, z, width, height, depth) {
  return new Float32Array([width, 0, 0, 0, 0, height, 0, 0, 0, 0, depth, 0, x, y, z, 1]);
}

const cube = box(0.04, 3);
const white = { color: [0.8, 0.8, 0.8], metallic: 0, roughness: 0.6 };
const parts = [
  { name: 'Floor', geometry: box(0, 1), matrix: placeAt(0, -0.1, 0, 9, 0.2, 9), material: white },
  { name: 'Wall', geometry: box(0, 1), matrix: placeAt(0, 0.8, 0, 0.2, 1.6, 3.5), material: { color: [0.7, 0.55, 0.45], metallic: 0, roughness: 0.6 } },
  { name: 'Cube left', geometry: cube, matrix: placeAt(-1.8, 0.4, 0.9, 0.8, 0.8, 0.8), material: { color: [0.3, 0.5, 0.8], metallic: 0, roughness: 0.4 } },
  { name: 'Cube right', geometry: cube, matrix: placeAt(1.8, 0.4, -0.6, 0.8, 0.8, 0.8), material: { color: [0.8, 0.35, 0.3], metallic: 0, roughness: 0.4 } },
  { name: 'Bulb', geometry: sphere(16, 10), matrix: placeAt(-1.4, 1.2, 0, 0.12, 0.12, 0.12), material: { color: [1, 0.8, 0.5], metallic: 0, roughness: 0.3, emission: 3 } },
];
const bulb = parts[4];
const light = { x: -1.4, z: 0, intensity: 8, castShadow: false };

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const renderer = new Renderer67(canvas, parts, {
  ground: false,
  hdr: true,
  pixelRatio: 1.25,
  environment: { keyIntensity: 0.05, fillIntensity: 0.05, ambientIntensity: 0.1 },
});

function draw() {
  bulb.matrix.set(placeAt(light.x, 1.2, light.z, 0.12, 0.12, 0.12));
  renderer.updateParts(parts);
  renderer.render({
    eye: [0, 5.5, 6.5],
    target: [0, 0.2, 0],
    fov: 38,
    environment: {
      pointLights: [{
        position: [light.x, 1.2, light.z],
        color: [1, 0.75, 0.45],
        intensity: light.intensity,
        radius: 0.08,
        range: 9,
        castShadow: light.castShadow,
      }],
    },
  });
}

function moveLight(event) {
  const bounds = canvas.getBoundingClientRect();
  light.x = (((event.clientX - bounds.left) / bounds.width) * 2 - 1) * 4;
  light.z = (((event.clientY - bounds.top) / bounds.height) * 2 - 1) * 3.5;
  draw();
}
canvas.addEventListener('pointerdown', event => {
  canvas.setPointerCapture(event.pointerId);
  moveLight(event);
});
canvas.addEventListener('pointermove', event => {
  if (canvas.hasPointerCapture(event.pointerId)) moveLight(event);
});

const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;left:12px;bottom:12px;display:grid;gap:6px;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
const intensityRow = document.createElement('label');
intensityRow.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between';
const intensity = document.createElement('input');
Object.assign(intensity, { type: 'range', min: 0, max: 30, step: 0.5, value: light.intensity });
intensity.addEventListener('input', () => {
  light.intensity = Number(intensity.value);
  draw();
});
intensity.addEventListener('change', () => console.log(`intensity ${light.intensity}`));
intensityRow.append('Intensity', intensity);
const shadowRow = document.createElement('label');
shadowRow.style.cssText = 'display:flex;gap:8px;align-items:center';
const shadow = document.createElement('input');
shadow.type = 'checkbox';
shadow.addEventListener('change', () => {
  light.castShadow = shadow.checked;
  draw();
  console.log(`castShadow ${light.castShadow}, cpu ${renderer.cpuMilliseconds.toFixed(2)} ms`);
});
shadowRow.append(shadow, 'castShadow');
panel.append(intensityRow, shadowRow);
document.body.append(panel);

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
draw();
console.log(`lights: 1 of 16, triangles ${renderer.triangles}, cpu ${renderer.cpuMilliseconds.toFixed(2)} ms`);
```

The light falls off with the inverse square of the distance, so doubling the distance gives a quarter of the light. With the wall between the bulb and the right cube, the cube still catches light when `castShadow` is off. Tick the box and the wall shadows it. Move the light with the mouse to see the pool of light slide over the floor and the wall.

Light updates add no geometry, texture, framebuffer or draw pass. Each renderer retains one set of light uniform arrays, which hold 75 floats, and shading cost grows with the active lights and the covered pixels.

Absolute-time animation keeps light movement independent of seek order. Excessive brightness clips at the finite half-float HDR target limit of 65,504 before bloom and tone mapping.

### Point light fields

Each light supplies `position`. Optional fields default to white `color`, `intensity: 1`, `radius: 0.05` and unlimited `range: 0`.

| Field | Range | Meaning |
| --- | --- | --- |
| `position` | within ±1,000,000 scene units | World-space position. |
| `color` | components from 0 to 1 | Linear RGB. |
| `intensity` | 0 to 100,000 | Candela for a point source. The pipeline is not calibrated to photographic exposure. |
| `radius` | 0.001 to 1,000,000 | Limits the near-source attenuation. It does not create an area emitter or soften shadows. |
| `range` | 0, or 0.001 to 1,000,000 | Zero keeps unlimited falloff. A positive range fades the light to zero with `(max(1 - (distance / range)^4, 0))^2`. |
| `castShadow` | boolean | Draws the light's depth into a shared shadow atlas. |

Studio controls: `keyIntensity`, `fillIntensity` and `ambientIntensity` each go from 0 to 100 and default to 1. `keyColor` replaces the key light's linear RGB color, with components from 0 to 1,000. Set all three intensities to zero to isolate local lights on standard PBR surfaces. These controls do not disable the sky, emission, fog or the special floor, fire and smoke shading.

Pass the entire list in `frame.environment.pointLights` to replace the constructor list. An empty list removes all local lights, and omitted fields keep the constructor defaults. Validation runs before the light arrays change, so an invalid later light leaves the previous lighting state intact. The [lighting contract](/lighting.md) defines intensity, radius, range and validation limits, and covers spot and area lights.

A point light with `castShadow: true` takes six tiles of a shadow atlas of 24 tiles (a 24 MiB depth texture, allocated on first use), so at most four point lights can cast shadows. Without `castShadow` a point light can illuminate through walls. The original directional shadow map stays in use for the key light.

## Volume fog

`environment.volumeFog` defines one axis-aligned world-space volume of fog that scatters the sun's light. Active fog requires `hdr: true`, `depth: true` and supported floating-point targets: WebGL 2 `EXT_color_buffer_float`, and an opaque, non-benchmark renderer. The depth texture contributes to the render memory estimate.

The scene has pillars and a low sun. The slider sets the density, and `frame.environment.volumeFog` replaces the whole fog object for each frame. Drag to turn the camera. The log prints the memory the depth texture adds.

```js live poster=fog-volume
import { Renderer67, box, cylinder } from '67js';

function placeAt(x, y, z, width, height, depth) {
  return new Float32Array([width, 0, 0, 0, 0, height, 0, 0, 0, 0, depth, 0, x, y, z, 1]);
}

const pillar = cylinder(24, 0, 1);
const stone = { color: [0.75, 0.72, 0.68], metallic: 0, roughness: 0.7 };
const parts = [{ name: 'Floor', geometry: box(0, 1), matrix: placeAt(0, -0.1, 0, 12, 0.2, 10), material: { color: [0.4, 0.4, 0.42], metallic: 0, roughness: 0.8 } }];
for (let column = 0; column < 4; column++) {
  parts.push({ name: `Pillar ${column}`, geometry: pillar, matrix: placeAt(-3.6 + column * 2.4, 1.5, -1, 0.7, 3, 0.7), material: stone });
}

const fog = {
  density: 0.05,
  minimum: [-5.7, 0.03, -4.7],
  maximum: [5.7, 4.5, 4.7],
  color: [0.9, 0.83, 0.7],
  steps: 24,
  maxDistance: 20,
};
const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const renderer = new Renderer67(canvas, parts, {
  hdr: true,
  depth: true,
  ground: false,
  pixelRatio: 1,
  environment: {
    lightDirection: [-0.35, 0.55, -0.85],
    volumeFog: fog,
  },
});
const orbit = { yaw: 0.25, pitch: 0.18, distance: 9 };

function draw() {
  const flat = Math.cos(orbit.pitch) * orbit.distance;
  const eye = [Math.sin(orbit.yaw) * flat, Math.sin(orbit.pitch) * orbit.distance + 1, Math.cos(orbit.yaw) * flat];
  renderer.render({ eye, target: [0, 1.3, 0], fov: 42, time: 0, environment: { volumeFog: { ...fog } } });
}

canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  orbit.yaw -= event.movementX * 0.008;
  orbit.pitch = Math.min(0.9, Math.max(0.02, orbit.pitch + event.movementY * 0.008));
  draw();
});

const row = document.createElement('label');
row.style.cssText = 'position:fixed;left:12px;bottom:12px;display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
const slider = document.createElement('input');
Object.assign(slider, { type: 'range', min: 0, max: 0.3, step: 0.01, value: fog.density });
slider.addEventListener('input', () => {
  fog.density = Number(slider.value);
  draw();
});
slider.addEventListener('change', () => console.log(`density ${fog.density}, cpu ${renderer.cpuMilliseconds.toFixed(2)} ms`));
row.append('Density', slider);
document.body.append(row);

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
draw();
const plan = renderer.memoryPlan;
console.log(`render size ${plan.width} x ${plan.height}, estimated ${(plan.estimatedBytes / 1048576).toFixed(1)} MiB, depth texture ${plan.width * plan.height * 4} bytes, HDR ${renderer.capabilities.hdr}`);
```

The fog marches from the camera through the volume for every pixel, clips against the resolved opaque depth, and stops at the boundary of the box or at `maxDistance`. It integrates Beer-Lambert extinction and directional single scattering with a Henyey-Greenstein phase function, using the key light's color and the existing directional shadow map. The shadows of the pillars cut dark wedges out of the lit haze. Keep authored shadow bounds aligned with the light direction and covering the medium.

Set `density: 0` to turn the fog off. Noise samples absolute time, so a backward seek reproduces earlier density.

### Volume fog fields

`frame.environment.volumeFog` replaces the whole constructor fog object for that frame, and omitted fields use these defaults.

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

Values must be finite numbers. Active volume fog accepts finite frame time within ±1,000,000 seconds and a nonzero light direction with components within ±1,000,000.

Resolved depth adds four estimated bytes per rendered pixel, or 2,073,600 bytes at 960 × 540. The planner reduces render dimensions when needed. The target is allocated at construction and resize, reused across frames and released by `dispose()`. Shading cost grows with covered pixels and step count.

`part.castShadow: false` excludes a mesh from shadow rendering while keeping it visible and opaque, for example a luminous window that should not block the sun. The flag must be boolean, and changing a part's casting regime needs a new renderer, because `updateParts()` rejects it.

The ambient of the fog can follow a per-point sky visibility and a bounce from the surfaces, instead of one share for the whole box. Pass `fogSkyVisibility` from `src/fog-sky-visibility.js` to `Renderer67` (the agent preview and the reference harness do). In a scene with an irradiance grid (`bake.irradianceGrid`) the bounce term is the grid's mean light at the cell, and the fog's ambient stands for the sky only. The [volume fog contract](https://github.com/codepawl/67.js/blob/main/docs/volumetric.md) covers these terms, the cost and the limits.

This is one bounded medium with one directional scattering source. Point-light scattering, multiple scattering, attenuation toward the source, transparent depth, volume grids, particles, temporal accumulation and half-resolution rendering are not built. Fog runs after bloom extraction, so scattering itself does not feed bloom.

With `world: true` the default `environment.fogDensity` is 0.006 per unit, which hazes a model 100 to 600 units wide into milky haze. Set a lower `fogDensity` for a large scene.

## Common mistakes

- **Sending only the lights that changed.** `frame.environment.pointLights` replaces the whole list, so send every light each frame, or all other lights go dark.
- **More than 16 point lights.** The limit is 16 per frame. Spot lights (8) and area lights (7) have their own counts, and shadow-casting point lights are limited to four.
- **Expecting walls to block a light.** A point light shines through walls unless it has `castShadow: true`.
- **Setting `radius` for a soft shadow or an area light.** Radius only limits near-source attenuation.
- **Fog without `hdr: true` and `depth: true`.** Active fog needs both, and floating-point targets.
- **Passing a partial fog object in a frame and expecting merged values.** It replaces the constructor's fog object, and omitted fields return to the defaults, so spread your fog object into it.
- **A fog box that is too big for `maxDistance`.** The march stops at `maxDistance`, so a long volume fades out early. Raise it, and raise `steps` if the haze bands.
