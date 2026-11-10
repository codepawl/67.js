# Grass fields

`67js/addons/grass` is in the current source and not yet published. It covers terrain with clumped, curved blades in tiles, with distance level of detail. Each tile is one part and one draw, and a coarser level keeps a fixed subset of the same blades, so a tile that changes level does not reshuffle.

## Tiles and levels of detail

The example calls `createGrass` for a 40 by 40 m meadow with a path cleared by `mask`. The slider walks the eye along the field: tiles near it keep every blade and tiles farther out keep 35 percent and then 12 percent, as the default levels say. A coarser level keeps a fixed subset of the same blades, so a tile that changes level does not reshuffle. The buttons rebuild the field with another preset. The console prints `grass.stats()` and the build time, and says when `update(eye)` returned true.

```js live poster=grass-tiles
import { Renderer67 } from '67js';
import { createGrass } from '67js/addons/grass';

const area = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
const mask = (x, z) => (Math.abs(z) < 0.8 ? 0 : 1);
const state = { eyeX: -14, preset: 'meadow' };

function eye() {
  return [state.eyeX, 1.3, 0];
}
function build(preset) {
  const started = performance.now();
  const built = createGrass({ preset, area, mask, density: 120, eye: eye() });
  console.log(`${preset}: built in ${Math.round(performance.now() - started)} ms`, built.stats());
  return built;
}

let grass = build(state.preset);
const canvas = document.querySelector('#scene');
const renderer = new Renderer67(canvas, grass.parts, { world: true });

function draw() {
  renderer.render({ eye: eye(), target: [state.eyeX + 12, 0.3, 4], fov: 60, wind: 0.3 });
}

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;bottom:8px;display:flex;gap:8px;align-items:center;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
const slider = document.createElement('input');
slider.type = 'range';
slider.min = -16;
slider.max = 16;
slider.step = 0.5;
slider.value = state.eyeX;
slider.setAttribute('aria-label', 'Eye position along the field');
slider.addEventListener('input', () => {
  state.eyeX = Number(slider.value);
  if (grass.update(eye())) {
    renderer.replaceParts(grass.parts);
    console.log('update(eye) = true', grass.stats());
  }
  draw();
});
bar.append(slider);
for (const preset of ['meadow', 'lawn', 'savanna', 'wild']) {
  const button = document.createElement('button');
  button.textContent = preset;
  button.addEventListener('click', () => {
    grass = build(preset);
    renderer.replaceParts(grass.parts);
    draw();
  });
  bar.append(button);
}
document.body.append(bar);
new ResizeObserver(() => { renderer.resize(); draw(); }).observe(canvas);
draw();
addEventListener('pagehide', () => renderer.dispose());
```

`update(eye)` returns true only when a tile changed level, so rebuild the part list then and not every frame.

## Grow a real field

1. Create the field with `createGrass({ preset, area, terrainHeight, mask, eye })`. Presets are `meadow`, `lawn`, `savanna` and `wild`.
2. Add `grass.parts` to the renderer and pass `wind` in each frame.
3. When `grass.update(eye)` returns true, call `renderer.replaceParts` with the new part list.

With a terrain from `createTerrain`, pass its `heightAt` as `terrainHeight` and put its parts next to the grass:

```js
const grass = createGrass({ preset: 'meadow', area, terrainHeight: terrain.heightAt, mask, eye });
const renderer = new Renderer67(canvas, [...terrain.parts, ...grass.parts], { world: true, memoryBudgetMiB: 512 });
```

Tint the ground under the grass with `grass.groundColor`. On a splat terrain, darken every layer the grass covers, not only the grass layer, because soil under a sward sits in the blades' shade and a bright floor between blades is what makes a field look fake.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `area` | required | `{ minX, maxX, minZ, maxZ }` in metres. |
| `preset` | `'meadow'` | `meadow`, `lawn`, `savanna` or `wild`. Every other option overrides it. |
| `terrainHeight` | `() => 0` | Ground height at `(x, z)`. |
| `mask` | none | Coverage from 0 to 1. Zero clears paths, and partial values thin and shorten the grass. |
| `density` | from preset | Blades per square metre at full detail. |
| `height`, `bend`, `width` | from preset | `[min, max]` blade height in metres, tip bend 0 to 1, root width in metres. |
| `clumpSize`, `clumpStrength` | from preset | Clump cell size in metres and how strongly blades follow their clump. |
| `dryness`, `patchiness`, `stalks` | from preset | Dry share, field-scale variation (0 gives an even field), seed stalk share (`lawn` has none). |
| `base`, `tip`, `dry` | from preset | Linear RGB colours of the root, the green tip and the dry tip. |
| `tileSize` | `4` | Tile edge in metres. Each tile is one part and one draw. |
| `levels` | `GRASS_LEVELS` | Distance, kept share, segments and width scale per level. |
| `cullDistance` | last level's distance | Tiles farther than this are dropped. |
| `castShadow` | `false` | Blade shadows cost a full extra pass of every blade. Blades still receive shadows. |
| `eye`, `seed` | area centre, `1` | Initial camera position and random seed. |

`createGrass` returns `{ parts, update(eye), material, stats(), groundColor, settings }`. `stats()` returns tile counts per level, triangles, vertices and an estimate of geometry bytes. The default levels are 0 up to 10 m (all blades, 4 segments, 1x width), 1 from 10 to 26 m (35 percent, 2 segments, 2x) and 2 from 26 to 60 m (12 percent, one triangle, 4.5x).

## Cost

On the demo meadow (80 by 100 m, eye 1.3 m above the ground, RTX 3060, headless Chrome), an eye height of 1.3 m showed 344 tiles, 1.21 M triangles and about 94 MB of geometry, built in 3.0 s. At 7 m the field showed 316 tiles, 0.74 M triangles and about 61 MB, built in 2.1 s. Thin patches drop blades, so the default meadow builds about 12 percent faster than the same field with `patchiness: 0` (measured in Node). Set `memoryBudgetMiB` high enough for the grass geometry, and lower `density` or `cullDistance` for phones.

## Clutter and baked light

`67js/addons/clutter` is in the current source and not yet published. It scatters pebbles, rocks, twigs and fallen leaves over terrain in the same streamed tiles. Pick a `preset` (`meadow`, `forest`, `riverbed`, `scree`), pass `terrainHeight`, and add `clutter.parts` next to the grass. The [clutter contract](https://github.com/codepawl/67.js/blob/main/docs/clutter.md) lists options and budgets.

`67js/addons/light-bake` is in the current source and not yet published. `bakeLightmaps(parts, lights, options)` ray traces the light that bounces between surfaces into a lightmap texture for each part, and returns new parts that draw it through the emissive map. Direct light stays live. The [light bake contract](https://github.com/codepawl/67.js/blob/main/docs/light-bake.md) lists the limits.

## Limits

- Blades are flat strips, so seen exactly edge-on they thin out.
- Tiles change level with a pop, not a cross-fade.
- Wind has one fixed direction, and there is no interaction with characters or vehicles.

The [grass contract](https://github.com/codepawl/67.js/blob/main/docs/grass.md) lists options, levels, measured budgets and limits.

## Common mistakes

- Calling `replaceParts` every frame. Call it when `update(eye)` returns true.
- Leaving `castShadow` on for a large field. It doubles the blade cost.
- A `mask` that never reaches 0 on a path, so grass grows on it.
- Forgetting to raise `memoryBudgetMiB` for a dense field.
- Lighting the ground bright under the grass, so the gaps look like bare soil.
