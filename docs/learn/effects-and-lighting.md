# Effects and lighting

Every renderer starts with a studio light rig: one key light that casts shadows, two fill lights and a soft ambient light. You can turn the key light, change the strength of each light, add local lamps, switch to an outdoor sky, and grade the final picture.

## Move the sun

`environment.lightDirection` points from the scene toward the key light. Set it on the renderer, or override it in one frame with `frame.environment`. Drag across the picture below to move the light, and watch the shadows.

```js live poster=lighting-sun
import { Renderer67, box, sphere, cylinder } from '67js';

const placeAt = (x, y, z, width, height = width) => new Float32Array([width, 0, 0, 0, 0, height, 0, 0, 0, 0, width, 0, x, y, z, 1]);
const parts = [
  { name: 'Column', geometry: cylinder(48), matrix: placeAt(-1, 0.9, 0, 0.3, 1.8), material: { color: [0.8, 0.78, 0.72], metallic: 0, roughness: 0.7 } },
  { name: 'Block', geometry: box(), matrix: placeAt(0.4, 0.35, 0.3, 0.7), material: { color: [0.3, 0.45, 0.62], metallic: 0, roughness: 0.5 } },
  { name: 'Ball', geometry: sphere(), matrix: placeAt(1.3, 0.3, -0.4, 0.3), material: { color: [0.9, 0.55, 0.2], metallic: 0, roughness: 0.35 } },
];

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const renderer = new Renderer67(canvas, parts);
let sunAngle = 0.9;

function draw() {
  const lightDirection = [Math.cos(sunAngle) * 4, 5, Math.sin(sunAngle) * 4];
  renderer.render({ eye: [0, 2.6, 5], target: [0, 0.5, 0], environment: { lightDirection } });
}

canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  sunAngle += event.movementX * 0.01;
  draw();
});
new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
```

These `environment` fields set the strength of the studio lights. Each one defaults to 1.

| Field | Effect |
| --- | --- |
| `keyIntensity` | The key light, which casts the shadows. `keyColor` sets its color in linear RGB. |
| `fillIntensity` | The two fill and rim lights. |
| `ambientIntensity` | The soft light from all sides and the reflection of the studio. |

Set all three to 0 to see only your own lamps. The sky, emission and fog still show.

## Lamps and glow

`environment.pointLights` adds up to 16 local lights. Each light has a `position`, a linear `color`, an `intensity`, a `radius` and a `range` in meters. To make the bulb itself glow, give its part `emission`, and add bloom in the frame.

```js live poster=lighting-lamp
import { Renderer67, box, sphere } from '67js';

const placeAt = (x, y, z, width, height = width, depth = width) => new Float32Array([width, 0, 0, 0, 0, height, 0, 0, 0, 0, depth, 0, x, y, z, 1]);
const bulbPosition = [0, 1.3, 0];
const parts = [
  { name: 'Table', geometry: box(0.02), matrix: placeAt(0, 0.4, 0, 2.4, 0.08, 1.4), material: { color: [0.36, 0.24, 0.16], metallic: 0, roughness: 0.55 } },
  { name: 'Bulb', geometry: sphere(), matrix: placeAt(...bulbPosition, 0.12), material: { color: [1, 0.8, 0.55], metallic: 0, roughness: 0.3, emission: 6 } },
  { name: 'Cup', geometry: box(0.2), matrix: placeAt(0.6, 0.6, 0.2, 0.3, 0.32, 0.3), material: { color: [0.85, 0.85, 0.82], metallic: 0, roughness: 0.25 } },
  { name: 'Book', geometry: box(0.05), matrix: placeAt(-0.6, 0.5, 0.1, 0.7, 0.12, 0.5), material: { color: [0.2, 0.32, 0.5], metallic: 0, roughness: 0.7 } },
];

const canvas = document.querySelector('#scene');
const renderer = new Renderer67(canvas, parts, {
  hdr: true,
  environment: {
    keyIntensity: 0.05,
    fillIntensity: 0.05,
    ambientIntensity: 0.15,
    pointLights: [{ position: bulbPosition, color: [1, 0.72, 0.45], intensity: 6, radius: 0.12, range: 6 }],
  },
});

new ResizeObserver(() => {
  renderer.resize();
  renderer.render({
    eye: [0, 1.9, 3.2],
    target: [0, 0.6, 0],
    exposure: 1.1,
    effects: { bloom: { strength: 0.35, threshold: 1, radius: 1.2 }, vignette: 0.2 },
  });
}).observe(canvas);
```

The studio lights are almost off, so the warm point light lights the table. The bright bulb is above the bloom `threshold`, so it glows. Point lights have no local shadows and can light through walls. `radius` softens the falloff near the light. It does not make an area light. The [lighting contract](/lighting.md) has spot lights, area lights, local shadows and light linking.

## Grade the picture

The frame takes `exposure` and an `effects` object. Start with neutral values and change one at a time.

```js
renderer.render({
  eye: [3, 2, 4], target: [0, 0, 0], exposure: 1,
  effects: {
    bloom: { strength: 0.18, threshold: 0.9, radius: 1.2 },
    saturation: 1, contrast: 1.04, temperature: 0.03, vignette: 0.12, grain: 0,
  },
});
```

| Effect | Range | Default |
| --- | --- | --- |
| `bloom.strength` | 0 to 2 | 0 |
| `bloom.threshold` | 0 to 10 | 1 |
| `bloom.radius` | 0.1 to 4 | 1 |
| `saturation`, `contrast` | 0 to 2, 0.1 to 2 | 1 |
| `temperature` | -1 (cool) to 1 (warm) | 0 |
| `vignette` | 0 to 1 | 0 |
| `grain` | 0 to 0.1 | 0 |

`EFFECT_PRESETS` has the ready looks `neutral`, `cinematic` and `vivid`. `resolveEffects(effects)` checks your settings and fills in the defaults. Bloom uses retained half-resolution targets, which the memory estimate includes. Bloom cannot add detail that the geometry or the lights do not have.

### Depth of field, motion blur and render passes

Depth of field and camera motion blur live in `67js/addons/camera-effects`, so the core carries none of their shader text. Call `installCameraEffects(renderer)` on a renderer made with `depth: true`. Then set `effects.depthOfField: { blur: 0.6, focusDistance: 4 }` or `effects.motionBlur: { shutter: 0.1 }`.

Motion blur also needs `frame.previousCamera` (`eye`, `target`, `up` and the lens fields) for the camera at `time - shutter`. Derive it from the frame time, so the result repeats on every seek. Each effect compiles and allocates its targets on the first frame that turns it on. The memory estimate does not include these targets.

`renderer.render({ ...camera, pass: 'depth' })` draws a raw pass instead of the lit image: `albedo`, `normal`, `emission`, `depth` (with `passDepthRange` meters, default 100) or `objectId`. Passes draw without multisampling into their own target. `renderer.passObjectNames()` lists the part behind each object ID. The pass branch of the main shader compiles on the first pass request. MCP render jobs write passes to files. See [agent render jobs](/agent-render-jobs.md#render-passes).

## Outdoor sky

For an outdoor scene, set `world: true` and `ground: false` on the renderer, and add your own ground. Outdoor `environment` accepts these fields:

- `skyTop` and `skyBottom`: the sky gradient in display RGB.
- `fogColor`: the fog color in linear RGB.
- `fogDensity`: 0.006 when unset. For a scene wider than about 200 m, it is 1.2 divided by the scene diagonal.
- `lightDirection` and `daylight`: the sun direction and the amount of daylight.

Frames can override the environment and supply `time`, `wind`, `waterRipple` and `rippleTime`. [HDR environment lighting](#hdr-environment-lighting) lights a scene from a photo of a real sky, and [Local lights and volume fog](#local-lights-and-volume-fog) adds light shafts.
