# Assemblies and interaction

An assembly lets you take an object apart for inspection. Each part keeps its assembled matrix, and a frame field `assemblyAmount` from 0 to 1 pushes the parts out along their section offsets. The same maths is exported as `assemblyOffset`, so a viewer and an export agree.

## Explode a model

Three layers sit in a stack. Drag the slider to separate them, drag the picture to orbit, and use the wheel to zoom. The console prints each part's offset from `assemblyOffset`.

```js live poster=assembly-explode
import { Renderer67, box, assemblyOffset } from '67js';

function placeAt(x, y, z, sx, sy, sz) {
  return new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1]);
}
const shape = box(0.04, 3);
const parts = [
  {
    name: 'Frame', geometry: shape, matrix: placeAt(0, 0.4, 0, 2, 0.5, 1.2),
    material: { color: [0.35, 0.4, 0.5], metallic: 0, roughness: 0.6 },
    assembly: { layer: 'interior', section: 'Structural frame', offset: [0, -1.2, 0], detailOffset: [0, -0.2, 0] },
  },
  {
    name: 'Battery', geometry: shape, matrix: placeAt(0, 0.9, 0, 1.2, 0.4, 0.8),
    material: { color: [0.9, 0.7, 0.2], metallic: 0, roughness: 0.5 },
    assembly: { layer: 'interior', section: 'Battery cassette', offset: [0, 0, 0], detailOffset: [0, 0.3, 0] },
  },
  {
    name: 'Roof', geometry: shape, matrix: placeAt(0, 1.35, 0, 2.1, 0.12, 1.3),
    material: { color: [0.85, 0.35, 0.25], metallic: 0, roughness: 0.4 },
    assembly: { layer: 'exterior', section: 'Roof panel', offset: [0, 1.4, 0], detailOffset: [0, 0.3, 0] },
  },
];

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const renderer = new Renderer67(canvas, parts);
const orbit = { yaw: 0.7, pitch: 0.4, distance: 7, amount: 0.6 };
function draw() {
  const flat = Math.cos(orbit.pitch) * orbit.distance;
  const eye = [Math.sin(orbit.yaw) * flat, Math.sin(orbit.pitch) * orbit.distance + 0.8, Math.cos(orbit.yaw) * flat];
  renderer.render({ eye, target: [0, 0.8, 0], fov: 40, assemblyAmount: orbit.amount });
}

const slider = document.createElement('input');
slider.type = 'range';
slider.min = 0;
slider.max = 1;
slider.step = 0.01;
slider.value = orbit.amount;
slider.setAttribute('aria-label', 'Assembly amount');
slider.style.cssText = 'position:fixed;left:8px;bottom:8px;width:40%';
slider.addEventListener('input', () => { orbit.amount = Number(slider.value); draw(); });
slider.addEventListener('change', () => {
  for (const part of parts) console.log(`amount ${orbit.amount.toFixed(2)}`, part.name, assemblyOffset(part, orbit.amount));
});
document.body.append(slider);

canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  orbit.yaw -= event.movementX * 0.01;
  orbit.pitch = Math.min(1.4, Math.max(0.05, orbit.pitch + event.movementY * 0.01));
  draw();
});
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  orbit.distance = Math.min(14, Math.max(3, orbit.distance * Math.exp(event.deltaY * 0.001)));
  draw();
}, { passive: false });
new ResizeObserver(() => { renderer.resize(); draw(); }).observe(canvas);
for (const part of parts) console.log(part.name, 'offset at 1:', assemblyOffset(part, 1));
addEventListener('pagehide', () => renderer.dispose());
```

The scene is static, so the code draws only after input. It does not run an animation loop.

## The assembly field

Explodable parts carry `assembly: { layer, section, offset, detailOffset }`. Base matrices stay assembled. Section offsets separate first, and small detail offsets separate later in the amount range.

| Field | Values | Meaning |
| --- | --- | --- |
| `layer` | `'exterior'` or `'interior'` | Lets you filter a layer out, for example to see inside. |
| `section` | A known section name such as `Roof panel`, `Structural frame` or `Battery cassette` | Groups parts and sets the direction and lift of the section layout. An unknown section throws `No detail layout for assembly section`. |
| `offset` | `[x, y, z]` | The section's travel at amount 1. |
| `detailOffset` | `[x, y, z]` | The extra travel of a small detail, later in the range. |
| frame `assemblyAmount` | 0 to 1 | How far apart the parts are. |

`assemblyOffset(part, amount)` returns the same offset, so an exporter can write the exploded pose. Parts with an `assembly` are not culled.

## Interaction checklist

Filter parts by `layer` and recreate the renderer after disposing its predecessor. The object studio implements pointer capture for orbit, wheel zoom, keyboard arrows and a slider. Render only after a change when the scene is static. Use a `ResizeObserver` to call `resize()` and redraw. Offer keyboard controls and honor `prefers-reduced-motion`.

## Common mistakes

- Using a section name the layout does not know. Use the names from the object studio or add the layout in the source.
- Changing a part's matrix to explode it. Keep the base matrix assembled and animate `assemblyAmount`.
- Setting `touch-action` too late. Without `touchAction = 'none'` a finger drag scrolls the page instead of orbiting.
- Hiding a layer by editing the list without rebuilding the renderer.
