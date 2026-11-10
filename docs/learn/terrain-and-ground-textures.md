# Terrain and ground textures

`67js/addons/terrain` builds a chunked, seeded heightfield with distance level of detail. `67js/addons/texture-set` loads CC0 scans and a four-layer ground material draws them with slope, height and mask rules, height-based edge blending, triplanar cliffs and anti-tiling. Both are available from version `0.10.0`.

## Try the real terrain

`createTerrain` builds the ground in chunks and swaps each chunk between detail levels as the eye moves. The example below calls it with a noise height, one circular hole and three levels. Drag to orbit, change the distance, and move the red ball with the slider. The console prints `heightAt` for the ball, whether it is over the hole, and after each `update(eye)` how many chunks changed level and how many triangles the ground holds.

```js live poster=terrain-rules
import { Renderer67, sphere } from '67js';
import { createTerrain } from '67js/addons/terrain';

const material = { color: [0.3, 0.5, 0.22], metallic: 0, roughness: 0.9 };
const terrain = createTerrain({
  size: 240, chunks: 8, resolution: 16, levels: 3, seed: 7, material,
  height: { amplitude: 9, mountainAmplitude: 22, featureSize: 70 },
  holes: [{ center: [20, 12], radius: 7 }],
});
const marker = {
  name: 'Marker', geometry: sphere(24, 16), material: { color: [0.9, 0.2, 0.2], metallic: 0, roughness: 0.4 },
  matrix: new Float32Array(16),
};
function placeMarker(x) {
  const z = 12;
  const y = terrain.heightAt(x, z);
  marker.matrix.set([0.6, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0.6, 0, x, y + 0.6, z, 1]);
  console.log(`heightAt(${x}, ${z}) = ${y.toFixed(2)} m, over a hole: ${terrain.isHole(x, z)}`);
}
placeMarker(0);

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const renderer = new Renderer67(canvas, [...terrain.parts, marker], { world: true });
const state = { yaw: 0.5, pitch: 0.5, distance: 40 };
console.log(`${terrain.triangleCount} triangles, chunk size ${terrain.chunkSize} m, bounds`, terrain.bounds);

function draw() {
  const flat = Math.cos(state.pitch) * state.distance;
  const eye = [Math.sin(state.yaw) * flat, Math.sin(state.pitch) * state.distance + 2, Math.cos(state.yaw) * flat];
  const changed = terrain.update(eye);
  if (changed.length) {
    renderer.replaceParts([...terrain.parts, marker]);
    console.log(`${changed.length} chunks changed level, ${terrain.triangleCount} triangles, levels`, terrain.chunkLevels().join(''));
  }
  renderer.render({ eye, target: [0, 2, 0], fov: 45 });
}

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;bottom:8px;display:flex;gap:12px;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
for (const [label, min, max, start, apply] of [
  ['distance', 8, 200, state.distance, value => { state.distance = value; }],
  ['ball x', -40, 40, 0, value => { placeMarker(value); renderer.updateParts([marker]); }],
]) {
  const wrap = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min;
  input.max = max;
  input.value = start;
  input.addEventListener('input', () => { apply(Number(input.value)); draw(); });
  wrap.append(label + ' ', input);
  bar.append(wrap);
}
document.body.append(bar);
canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  state.yaw -= event.movementX * 0.01;
  state.pitch = Math.min(1.3, Math.max(0.1, state.pitch + event.movementY * 0.01));
  draw();
});
new ResizeObserver(() => { renderer.resize(); draw(); }).observe(canvas);
addEventListener('pagehide', () => renderer.dispose());
```

Slide the ball to x = 20: it sits over the hole, and `heightAt` still returns a number, because it ignores holes. That is why the common mistakes below say to check `isHole` first.

## Ground textures and splat rules

The docs host has no CC0 scans to load, so the splat part of the call stays a plain block. The rules work per vertex in the shader. A layer with a `slope` range takes the steep parts, a `height` range takes a band of altitude, and a layer with no rule takes what the others leave. Put grass first with no rule, rock second with a slope rule and snow last with a height rule.

1. Load a texture set per layer, then give the layers to one material: `const set = await loadTextureSet('/textures/leafy_grass')`, `material.layers = [{ ...set, scale: 3 }, ...]` and `material.splat = { rules }`.
2. Create the heightfield with that material, as in the example above. Every entry of `terrain.parts` shares it.
3. Pass `terrain.heightAt` to `scatterVegetation` and to vehicles, and call `renderer.replaceParts` when `terrain.update(eye)` returns parts.

```js
import { loadTextureSet } from '67js/addons/texture-set';

const material = { color: [1, 1, 1], metallic: 0, roughness: 1, tag: 'standard' };
material.layers = [
  { ...await loadTextureSet('/textures/leafy_grass'), scale: 3 },
  { ...await loadTextureSet('/textures/rock'), scale: 4, triplanar: true },
];
material.splat = { rules: [undefined, { slope: [32, 90], slopeSoftness: 6 }] };
```

## Options

`createTerrain({ size = 512, resolution = 32, chunks = 8, levels = 4, height, seed = 1, material, lodDistance, eye })` returns `{ parts, heightAt, normalAt, bounds, update, triangleCount, chunkSize, chunkLevels }`.

| Option | Meaning |
| --- | --- |
| `size` | The ground spans x and z from `-size / 2` to `size / 2`. |
| `chunks`, `resolution`, `levels` | `chunks` per side, each with `resolution` cells at level 0. `resolution` must divide by `2 ** (levels - 1)`. Level `n` uses `resolution / 2 ** n` cells. |
| `height` | A function `(x, z) => metres`, a square `Float32Array` of metres (see `heightmapFromImageData(imageData, amplitude)`), or noise options such as `amplitude` (14), `mountainAmplitude` (46), `featureSize` (160 m), `octaves`, `gain`, `lacunarity`, `warp`, `baseHeight` and `mountainMask(x, z)`. |
| `lodDistance` | Distance of the first level change, default 1.6 chunk sizes, doubling per level. |
| `holes` | Up to 64 `{ center: [x, z], radius }` circles that leave no surface. `terrain.isHole(x, z)` tells whether a point is inside one. |

`heightAt(x, z)` walks the same triangles as the level 0 mesh, so it matches the rendered surface there, and coordinates outside the ground clamp to the edge. `normalAt` interpolates smooth grid normals. `update(eye)` returns the parts whose geometry changed, and edges shared with a coarser neighbour snap onto it, so there are no cracks and no skirts. UVs are world metres `(x, z)`.

| Splat layer field | Meaning |
| --- | --- |
| `color`, `normal`, `roughness`, `height` | Descriptors from `loadTextureSet`. Missing ones fall back to mid grey, a flat normal, roughness 1 and height 0.5. |
| `scale` | Metres per texture tile (default 4). |
| `tint` | RGB multiplier on colour. |
| `normalStrength` | Scales the normal map tilt (default 1). |
| `triplanar` | Projects from the sides on steep slopes, so cliffs do not stretch. |

`material.splat.rules` has one entry per layer: `slope: [min, max]` in degrees, `height: [min, max]` in metres, each with `slopeSoftness` (4) and `heightSoftness` (1.5), and `mask: 'r' | 'g' | 'b' | 'a'` with `invertMask`. A layer with no rule takes what the others leave, so put grass first with no rule. Other `splat` options include `heightBlend` (0.22), `heightInfluence` (1), `triplanarStart` and `triplanarEnd` (38 and 52 degrees), `variation` (0 to 2, default 1), `edgeNoise` (0 to 2, default 1) and `parallax` (0 to 0.15 m, default 0.03). The [terrain contract](https://github.com/codepawl/67.js/blob/main/docs/terrain.md) lists every option.

## Cost

Measured on Windows with an RTX 3060, headless Chrome, 1600 by 900, 4x MSAA, HDRI, shadows and bloom, a 600 m terrain with 10 by 10 chunks at resolution 32 and 1,000 to 1,750 trees (docs/terrain.md):

| Camera | Terrain triangles | Scene triangles | Batches | Frame |
| --- | --- | --- | --- | --- |
| Low, close to the path | 50,432 | 1.23 M | 164 | 13.8 ms |
| High, whole scene | 12,896 | 0.53 M | 124 | 9.0 ms |

Splat textures took 68 MiB of 74 MiB of texture memory at 1K per layer. They live in three texture arrays (colour, normal, and roughness with height), resized to the largest source with mipmaps and up to 8x anisotropic filtering.

## Limits

- Up to four layers, and one splat material per draw, so all chunks share one. Eight 1K layers would take about 136 MiB against the 74 MiB above.
- The terrain is a heightfield, so there are no overhangs, caves or bridges, apart from `holes`.
- Changing `layers` or `splat` after the renderer exists needs a new renderer.
- Materials batch together only when they share the same `layers` array and `splat` object. Build them once.

## Common mistakes

- A splat material with a `map`, `normalMap` or a special tag such as `floor`. Use a standard PBR tag and no maps.
- A `resolution` that does not divide by `2 ** (levels - 1)`.
- One material per chunk. Chunks must share one material, or each chunk becomes its own draw.
- Standing something on `heightAt` inside a hole. `heightAt` ignores holes, so check `isHole` first.
- Calling `replaceParts` every frame. Do it only when `update(eye)` returns changed parts.
