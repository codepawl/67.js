# HDR environment lighting

Pass `environment: { map }` to light and reflect from an equirectangular HDR image. `loadHdri(url)` from `crucible/addons/hdri` parses a Poly Haven `.hdr` file, and `createEnvironmentMap` accepts your own float data. Without a map, rendering is unchanged. The [lighting contract](/lighting.md#environment-maps-ibl) covers rotation, background display, memory and limits.

```js
import { CrucibleRenderer } from 'crucible';
import { loadHdri } from 'crucible/addons/hdri';

const map = await loadHdri('/studio_small_09_1k.hdr', { intensity: 1, rotation: 0.6 });
const renderer = new CrucibleRenderer(canvas, parts, { hdr: true, environment: { map } });
```

`loadHdri(url, options)` fetches and parses a Radiance `.hdr` (RGBE, `-Y height +X width`, flat or run-length scanlines) and returns the descriptor. Poly Haven CC0 HDRIs at 1k or 2k work well, and larger files only cost load time. The examples below build the map from data so that they need no download.

## Build a map and turn it

`createEnvironmentMap({ width, height, data, intensity, rotation, showBackground, backgroundBlur })` takes a `Float32Array` of linear RGB or RGBA, top row first. The image centre looks toward -Z. The example paints a small sky with a bright sun, and the sphere row reflects it. Drag to orbit, and use the slider to turn the map with `{ ...map, rotation }`: maps spread from one created map reuse their GPU textures, so rotation animates for free.

```js live poster=hdr-rotate
import { CrucibleRenderer, sphere, createEnvironmentMap } from 'crucible';

// A 128 x 64 sky: blue zenith, pale horizon, dark ground and one very bright sun.
function paintSky(width, height) {
  const data = new Float32Array(width * height * 3);
  const sun = [0.55, 0.5, -0.67];
  const sunLength = Math.hypot(...sun);
  for (let row = 0; row < height; row++) {
    const elevation = (0.5 - (row + 0.5) / height) * Math.PI;
    for (let column = 0; column < width; column++) {
      const azimuth = ((column + 0.5) / width - 0.5) * Math.PI * 2;
      const direction = [Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation)];
      const up = Math.max(direction[1], 0);
      let color = direction[1] >= 0
        ? [0.75 - 0.6 * Math.sqrt(up), 0.82 - 0.5 * Math.sqrt(up), 0.9 - 0.2 * Math.sqrt(up)]
        : [0.1, 0.09, 0.08];
      const alignment = Math.max(0, (direction[0] * sun[0] + direction[1] * sun[1] + direction[2] * sun[2]) / sunLength);
      const glare = 60 * Math.pow(alignment, 300);
      color = [color[0] + glare, color[1] + glare * 0.9, color[2] + glare * 0.7];
      data.set(color, (row * width + column) * 3);
    }
  }
  return data;
}

const width = 128;
const height = 64;
const map = createEnvironmentMap({ width, height, data: paintSky(width, height), intensity: 1, showBackground: true, backgroundBlur: 0.2 });

const geometry = sphere(48, 30);
const parts = [0, 1, 2, 3].map(index => ({
  name: `Ball ${index}`,
  geometry,
  matrix: new Float32Array([0.7, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0.7, 0, (index - 1.5) * 1.7, 0.7, 0, 1]),
  material: { color: [0.9, 0.82, 0.7], metallic: index < 3 ? 1 : 0, roughness: [0.05, 0.3, 0.6, 0.5][index] },
}));

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const renderer = new CrucibleRenderer(canvas, parts, {
  ground: false,
  hdr: true,
  pixelRatio: 1.25,
  environment: { map, keyIntensity: 0, fillIntensity: 0 },
});
const orbit = { yaw: 0.2, pitch: 0.15, distance: 7 };
let rotation = 0;

function draw() {
  const flat = Math.cos(orbit.pitch) * orbit.distance;
  const eye = [Math.sin(orbit.yaw) * flat, Math.sin(orbit.pitch) * orbit.distance + 0.7, Math.cos(orbit.yaw) * flat];
  renderer.render({ eye, target: [0, 0.7, 0], fov: 40, environment: { map: { ...map, rotation } } });
}

canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  orbit.yaw -= event.movementX * 0.008;
  orbit.pitch = Math.min(1.2, Math.max(-0.2, orbit.pitch + event.movementY * 0.008));
  draw();
});

const row = document.createElement('label');
row.style.cssText = 'position:fixed;left:12px;bottom:12px;display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
const slider = document.createElement('input');
Object.assign(slider, { type: 'range', min: 0, max: 6.28, step: 0.02, value: 0 });
slider.addEventListener('input', () => {
  rotation = Number(slider.value);
  draw();
});
slider.addEventListener('change', () => console.log(`rotation ${rotation.toFixed(2)} rad, cpu ${renderer.cpuMilliseconds.toFixed(2)} ms`));
row.append('Rotation', slider);
document.body.append(row);

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
draw();
console.log(`map ${map.width} x ${map.height}, ${map.channels} channels, ${(map.data.byteLength / 1024).toFixed(0)} KiB of float data`);
console.log(`render memory estimate ${(renderer.memoryPlan.estimatedBytes / 1048576).toFixed(1)} MiB, HDR ${renderer.capabilities.hdr}`);
```

Turn the slider and the sun glints slide around the three polished metal spheres, the sharpest on the one with roughness 0.05. The fourth sphere is a dielectric: it takes its soft light from the map's diffuse term. The log shows the size of the float data and the render memory estimate, which includes the prefiltered chain.

## Compare studio lighting and the map

Set `map: null` in a frame to return to studio lighting, and set the map again to switch back. The row below goes from a mirror to a rough metal. The checkbox toggles the map, and the slider scales its `intensity`.

```js live poster=hdr-compare
import { CrucibleRenderer, sphere, createEnvironmentMap } from 'crucible';

const width = 64;
const height = 32;
const data = new Float32Array(width * height * 3);
for (let row = 0; row < height; row++) {
  const elevation = (0.5 - (row + 0.5) / height) * Math.PI;
  for (let column = 0; column < width; column++) {
    const azimuth = ((column + 0.5) / width - 0.5) * Math.PI * 2;
    // A warm band of light low on one side, a cool sky above, and a bright strip lamp.
    const sky = Math.max(Math.sin(elevation), 0);
    const lamp = Math.abs(azimuth - 0.9) < 0.25 && Math.abs(elevation - 0.5) < 0.12 ? 25 : 0;
    data.set([0.2 + 0.3 * sky + lamp, 0.3 + 0.3 * sky + lamp, 0.45 + 0.4 * sky + lamp * 0.8], (row * width + column) * 3);
  }
}
const map = createEnvironmentMap({ width, height, data });

const geometry = sphere(48, 30);
const parts = [0, 1, 2, 3, 4].map(index => ({
  name: `Roughness ${index}`,
  geometry,
  matrix: new Float32Array([0.8, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0.8, 0, (index - 2) * 1.8, 0.8, 0, 1]),
  material: { color: [0.95, 0.9, 0.85], metallic: 1, roughness: index / 4 },
}));

const canvas = document.querySelector('#scene');
const renderer = new CrucibleRenderer(canvas, parts, { ground: false, hdr: true, pixelRatio: 1.25 });
const state = { useMap: true, intensity: 1 };

function draw() {
  renderer.render({
    eye: [0, 1.6, 8],
    target: [0, 0.8, 0],
    fov: 36,
    environment: { map: state.useMap ? { ...map, intensity: state.intensity } : null },
  });
}

const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;left:12px;bottom:12px;display:grid;gap:6px;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
const checkRow = document.createElement('label');
checkRow.style.cssText = 'display:flex;gap:8px;align-items:center';
const check = document.createElement('input');
check.type = 'checkbox';
check.checked = true;
check.addEventListener('change', () => {
  state.useMap = check.checked;
  draw();
  console.log(state.useMap ? 'environment map on' : 'map: null, studio lighting');
});
checkRow.append(check, 'Environment map');
const intensityRow = document.createElement('label');
intensityRow.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between';
const slider = document.createElement('input');
Object.assign(slider, { type: 'range', min: 0, max: 3, step: 0.05, value: 1 });
slider.addEventListener('input', () => {
  state.intensity = Number(slider.value);
  draw();
});
slider.addEventListener('change', () => console.log(`map intensity ${state.intensity}`));
intensityRow.append('Intensity', slider);
panel.append(checkRow, intensityRow);
document.body.append(panel);

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
draw();
console.log(`${parts.length} spheres, roughness 0 to 1, one prefiltered map of ${width} x ${height}`);
```

The mirror sphere shows the strip lamp as a sharp stripe. As roughness grows, the reflection blurs into a soft glow, because the renderer samples a GGX-prefiltered chain, by roughness. Without a map the same spheres show the procedural studio reflection, and the result is pixel-identical to a renderer that never had a map.

## What a map changes

When a map is set:

- Standard PBR surfaces take specular reflection by roughness from a GGX-prefiltered chain and diffuse ambient from L2 spherical harmonics, with a split-sum BRDF lookup. `ambientIntensity` and occlusion maps still scale it.
- Liquid reflections sample the same chain.
- `showBackground: true` draws the map behind the scene in studio and world mode, blurred by `backgroundBlur`. It is skipped on transparent canvases.
- Key, fill and point lights still add direct light. Set `keyIntensity` and `fillIntensity` to zero to light a scene from the map alone, as the first example does.
- The procedural floor, water tag, fire and smoke keep their own shading.

Set `environment.map` in the constructor or in `frame.environment`. Passing a different map prefilters it on first use, and `map: null` returns to studio lighting.

### Options

| Field of `createEnvironmentMap` | Default | Meaning |
| --- | --- | --- |
| `width`, `height` | required | Integers: width 4 to 16384, height 2 to 16384. |
| `data` | required | `Float32Array` of linear RGB or RGBA, top row first, finite values only. Its length is `width * height * 3` or `* 4`. |
| `intensity` | `1` | Number from 0 to 1000. |
| `rotation` | `0` | Radians, turns the map about the vertical axis. |
| `showBackground` | `false` | Boolean. Draw the map behind the scene. |
| `backgroundBlur` | `0` | Number from 0 to 1. |

`loadHdri(url, options)` accepts `intensity`, `rotation`, `showBackground`, `backgroundBlur`, `signal` and `fetchImplementation`.

Prefiltering runs once when a map is first used, not per frame: about 30 ms for a 512x256 map on an RTX 3060 after shader compilation, plus about 0.6 s of first-use shader compile. The renderer keeps a half-float chain of at most 1024 wide (about 8 MB for 1024x512, 1.4 MB for 512x256) and a 128x128 BRDF lookup, and counts both in the memory budget. The source upload is freed after prefiltering. A 2048x1024 source briefly needs about 11 MB of GPU memory and 32 MB of CPU memory while loading. Maps need `EXT_color_buffer_float`, and without it the constructor throws.

Limits: the diffuse term uses L2 spherical harmonics, so a very small intense sun gives soft, slightly ringing diffuse light and no shadow. Use the key light for sun shadows. Reflections have no parallax or occlusion, and the procedural water tag does not use the map.

## Common mistakes

- **Forgetting `hdr: true`.** The examples all create the renderer with `hdr: true`, because a bright sun needs floating-point targets. Maps also need `EXT_color_buffer_float`.
- **Leaving the key and fill lights on and expecting a map-only look.** Set `keyIntensity` and `fillIntensity` to zero.
- **Expecting a sun shadow from the map.** A map gives soft diffuse light and reflections, and no shadow. Use the key light for that.
- **A data array of the wrong length.** The length must match `width * height * 3` or `* 4`, with no NaN or Infinity.
- **Creating a new map for every rotation step.** Spread the one created map, `{ ...map, rotation }`, and the GPU textures are reused. A different map costs a new prefilter.
- **Expecting parallax in reflections.** A map reflects an infinitely distant room, so the reflection never shifts when an object moves.
