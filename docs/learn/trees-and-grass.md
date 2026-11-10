# Trees and grass

`67js/addons/vegetation` grows seeded trees with real branches and leaf cards, plus grass and flowers. It is available from version `0.10.0`. It scatters instances with Poisson-disk spacing, shares a few variants per species so the renderer can batch them, and picks a level of detail per instance from the camera.

## Scatter, then pick detail by distance

The example calls `scatterVegetation` for a seeded scatter with a slope limit and an exclusion zone, then `selectLevels` for the detail of each tree from the camera. Drag to orbit and scroll to move closer: the near trees get the detailed crown, the far ones a coarse one. The slider changes the density. The console prints what the two calls return: counts per species, level counts, culled instances and triangles. Leaf cards use the built-in 128 px sprites here, because the docs host has no scanned leaf textures.

```js live poster=trees-scatter
import { Renderer67 } from '67js';
import { scatterVegetation, selectLevels } from '67js/addons/vegetation';

const terrainHeight = (x, z) => 1.5 * Math.sin(x * 0.18) * Math.cos(z * 0.15);
const exclusion = (x, z) => Math.hypot(x, z) < 3.5;
const area = { minX: -25, maxX: 25, minZ: -25, maxZ: 25 };

function scatter(density) {
  const started = performance.now();
  const forest = scatterVegetation({
    area, density, terrainHeight, slopeLimit: 14, exclusion, seed: 11,
    mix: { broadleaf: 3, birch: 1, bush: 2 }, variants: 2,
  });
  console.log(`density ${density} per m²:`, forest.counts, `${Math.round(performance.now() - started)} ms`);
  return forest;
}

const state = { density: 0.02, yaw: 0.7, distance: 30, pitch: 0.5 };
let forest = scatter(state.density);

function eye() {
  const flat = Math.cos(state.pitch) * state.distance;
  return [Math.sin(state.yaw) * flat, Math.sin(state.pitch) * state.distance + 2, Math.cos(state.yaw) * flat];
}

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
let view = selectLevels(forest.instances, eye());
const renderer = new Renderer67(canvas, view.parts, { world: true });
console.log('first view:', { levelCounts: view.levelCounts, culled: view.culled, triangles: view.triangles });

function draw() {
  const position = eye();
  view = selectLevels(forest.instances, position);
  if (view.changed) {
    renderer.replaceParts(view.parts);
    console.log('levels changed:', { levelCounts: view.levelCounts, culled: view.culled, triangles: view.triangles });
  }
  renderer.render({ eye: position, target: [0, 1, 0], fov: 45 });
}

canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  state.yaw -= event.movementX * 0.01;
  state.pitch = Math.min(1.3, Math.max(0.1, state.pitch + event.movementY * 0.01));
  draw();
});
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  state.distance = Math.min(45, Math.max(5, state.distance * Math.exp(event.deltaY * 0.001)));
  draw();
}, { passive: false });

const slider = document.createElement('input');
slider.type = 'range';
slider.min = 0.01;
slider.max = 0.06;
slider.step = 0.005;
slider.value = state.density;
slider.setAttribute('aria-label', 'Trees per square metre');
slider.style.cssText = 'position:fixed;left:8px;bottom:8px;width:40%';
slider.addEventListener('change', () => {
  state.density = Number(slider.value);
  forest = scatter(state.density);
  view = selectLevels(forest.instances, eye());
  renderer.replaceParts(view.parts);
  console.log('after scatter:', { levelCounts: view.levelCounts, triangles: view.triangles });
  draw();
});
document.body.append(slider);
new ResizeObserver(() => { renderer.resize(); draw(); }).observe(canvas);
draw();
addEventListener('pagehide', () => renderer.dispose());
```

Levels change only after a distance passes a threshold by `hysteresis`, so a tree on the boundary does not flicker between two crowns while you orbit.

## Grow the real forest with scanned leaves

The scanned leaf cards need the CC0 files, which the docs host does not serve, so this call stays a plain block. It is the example above with `leafTextures` added:

```js
import { loadLeafTextures } from '67js/addons/texture-set';

const forest = scatterVegetation({
  area: { minX: -60, maxX: 60, minZ: -60, maxZ: 60 },
  density: 0.04,
  terrainHeight: terrain.heightAt,
  slopeLimit: 30,
  exclusion: (x, z) => Math.hypot(x, z) < 4,
  mix: { broadleaf: 3, birch: 1, bush: 2 },
  leafTextures: await loadLeafTextures('/textures/leaves'),
});
```

1. Scatter with `scatterVegetation({ area, density, terrainHeight, slopeLimit, exclusion, mix, leaves })`.
2. Pick detail per camera with `selectLevels(forest.instances, eye)`.
3. Pass `view.parts` to `Renderer67` and rebuild when `view.changed` is true.

Cards (`leaves: 'cards'`, the default) are single-sided, alpha-masked, double-sided `foliage` textures that sway with the wind. `'mesh'` leaves cost about twice the triangles. Pass `barkTextures` for scanned bark and `leafTextures: await loadLeafTextures('/textures/leaves')` for scanned leaf cards.

## Options

`scatterVegetation({ area, density, terrainHeight, slopeLimit, exclusion, seed, mix, variants, leaves, scale, spacing })` returns `{ instances, parts, variants, counts }`.

| Option | Meaning |
| --- | --- |
| `area` | The ground rectangle. |
| `density` | Instances per square metre. Spacing defaults to `sqrt(0.6 / density)` (Poisson-disk, Bridson with restarts, so exclusion zones cannot strand regions). |
| `terrainHeight` | `(x, z) => y`. Pass `terrain.heightAt`. |
| `slopeLimit` | Degrees, measured from `terrainHeight` over a 1.2 m span. |
| `exclusion(x, z)` | Returns true to keep a spot clear. |
| `mix` | Weights per species: `broadleaf`, `birch`, `conifer`, `palm`, `bush`, `grass`, `flowers`. Low-frequency noise groups species into stands. |
| `variants` | Default 3 variants per species, shared by every instance so the renderer batches by geometry identity. Instances differ by yaw, scale and tint. |
| `leaves` | `'cards'` (default) or `'mesh'`. |

`selectLevels(instances, eye, { distanceScale, hysteresis, cullDistance })` returns `{ parts, changed, levelCounts, culled, triangles }`. A level changes only after the distance passes its threshold by `hysteresis` (default 0.12), so instances on a boundary do not flicker. Grass switches at 24 m. Set `cullDistance` to drop far instances, `fade` for a screen-door cross-fade, and `impostors` for a last level that draws one baked card per tree. `vegetationParts(variant, matrix, level, name)` places one tree or clump yourself.

## Cost

On the demo clearing (125 trees and bushes, 1,941 grass clumps and 129 flower patches, camera at the clearing edge, headless Chrome with a GPU), `mesh` leaves with level of detail drew 2.28M triangles in 65 draws, against 3.78M without level of detail. `cards` drew 1.15M. Building the scene took about 1 s and a frame took under 0.2 s (docs/vegetation.md). The [vegetation contract](https://github.com/codepawl/67.js/blob/main/docs/vegetation.md) lists species, triangle budgets and limits.

## Common mistakes

- Making a new geometry per tree. Share the variants, or every tree is its own draw.
- Calling `replaceParts` when `changed` is false.
- Expecting wind-bent skeletons or collisions between trees. Species are fixed presets without either.
- Using cards for a close-up. Without `leafTextures` the leaf sprites are 128 px and look flat from under a few metres; scanned cards hold up to about 1 m.
- Forgetting `exclusion` on a path or a house, and finding trees growing through it.
