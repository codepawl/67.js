# Spume liquid playback

`crucible/addons/spume` plays back a liquid bake from [Spume](https://github.com/codepawl/spume), the CodePawl GPU liquid solver.
Spume bakes offline on an NVIDIA GPU with Python and NVIDIA Warp. The browser never runs the solver: this addon reads the baked cache folder and turns each frame into ordinary rigid Crucible parts.

```js
import { CrucibleRenderer } from 'crucible';
import { loadSpumeCache, createSpumePlayer } from 'crucible/addons/spume';

const cache = await loadSpumeCache('/caches/geyser/');
const player = createSpumePlayer(cache, { loop: true });
const renderer = new CrucibleRenderer(canvas, [...sceneParts, ...player.partsAt(0)], { hdr: true, samples: 4 });

function draw(seconds) {
  renderer.replaceParts([...sceneParts, ...player.partsAt(seconds)]);
  renderer.render({ eye: [13, 5.5, 15], target: [0, 4.6, 0] });
}
```

## Baking a cache

Bake from a Spume checkout. Units are metres, +Y up, the floor at y = 0, which matches Crucible.

```bash
uv run python run.py --out out/geyser --name geyser --pressure cg --iterations 20
```

A low-resolution check takes seconds after the first kernel compile:

```bash
uv run python run.py --out out/test --cell 0.2 --width 6 --height 12 --frames 40 --mesh-cell 0.25
```

Serve the output folder next to the page. It holds `meta.json`, one `frame_NNNN.glb` per frame and the whitewater files `spray.bin`, `spray_ids.bin` and `spray_kinds.bin`.
Spume's README lists inflows, obstacles, outflow boxes and every solver option.

## Loading

`loadSpumeCache(source)` accepts a folder URL or an `async (fileName) => ArrayBuffer | null` reader, so the same cache loads from a server, from disk in Node or from a dropped folder.
It validates `meta.json`, reads every frame file and keeps frames int16-packed until they are played, which is about a fifth of the decoded size.
Caches from Spume 0.1 have no `spray_kinds.bin`; their points count as spray.

The frame files are not general glTF. Positions are int16 spread over each frame's own min..max box, so standard loaders, including `crucible/addons/gltf`, read them at the wrong scale. Use `decodeSpumeFrame(bytes)` for one frame: it returns `{ positions, normals, indices }` as `Float32Array`, `Float32Array` and `Uint32Array` in metres.

## Playing

`createSpumePlayer(cache, options)` returns:

| Member | Meaning |
| --- | --- |
| `partsAt(seconds)` | Parts for the frame shown at that time: the liquid mesh, plus whitewater when the frame has any |
| `partsForFrame(index)` | The same by frame number |
| `frameIndexAt(seconds)` | The frame number for a time, clamped or wrapped |
| `frameCount`, `fps`, `duration` | From `meta.json` |

| Option | Default | Effect |
| --- | --- | --- |
| `matrix` | identity | Places the bake. Positions are relative to the first opening's centre on the floor (`meta.origin`). |
| `waterMaterial` | `DEFAULT_WATER_MATERIAL` | Any rigid, untextured material. The default uses the `liquid` tag with `color: [0.56, 0.84, 0.88]`, the light one metre of water lets through. |
| `sprayMaterial` | `DEFAULT_SPRAY_MATERIAL` | Material for whitewater. The default uses the `foam` tag; per-point vertex colours tint foam and bubbles. |
| `spray` | `{ radius: 0.014, shutter: 1 / 60, kinds: ['spray', 'foam'], maxPoints: 12000 }` | Whitewater droplets, or `null` for liquid only. Bubbles are hidden by default. |
| `loop` | `false` | Wrap time instead of holding the last frame. |
| `cachedFrames` | `4` | Decoded frames kept for reuse. Scrubbing back and forth over a few frames costs nothing after the first decode. |

Each droplet is stretched along its velocity by the distance it covers while the shutter is open, the motion blur a camera gives fast spray. Without it, spray reads as white beads. Set `shutter: 0` for round droplets, or a longer shutter for heavier streaks.
Each point keeps the size its stable Spume id gives it, so whitewater does not flicker between frames.
When a frame holds more points than `maxPoints`, the addon thins them evenly across the plume rather than dropping the tail.
`buildSprayGeometry(cache, frameIndex, spray)` builds the whitewater mesh alone.

## Rendering contract

The player returns new geometry for each new frame. Pass it through `renderer.replaceParts` with the rest of the scene.
Textured, skinned and morphed parts (trees, characters, imported assets) can share the renderer as long as they stay in the list unchanged: their batches are retained and only new geometry is uploaded and validated. Adding or removing such parts still needs a new renderer.
Whitewater parts set `castShadow: false`; the liquid casts shadows.

The `liquid` and `foam` tags draw after the opaque scene. Tune them with `frame.liquid` or `environment.liquid`:

```js
renderer.render({ eye, target, liquid: { thickness: 0.8, ior: 1.33, refraction: 1, scattering: 1, foamOpacity: 0.55, foamSoftness: 1 } });
```

`thickness` is the depth in metres a body of liquid has where it faces the camera; it thins toward the silhouette. Thicker liquid absorbs more of the scene behind it.
Do not use the `water` tag for Spume meshes: it flattens normals into a rippled pond.

## Cost

Measured on the slab bake (README example at 10 cm cells, 60 frames, 79 thousand liquid particles, up to 12,177 liquid vertices and 12,000 droplets shown), RTX 3060, Chrome:
`replaceParts` with a fresh frame took 7 to 13 ms and the render about 0.5 ms; the cache is 7.1 MB of frames.
Decoding a frame takes about 1.3 ms and building its droplets about 4.5 ms in Node. Lower `maxPoints` first when a large bake drops frames, and raise `cachedFrames` for scrubbing.

## Limits

A liquid refracts only opaque parts, not other liquids or itself, and its thickness is an estimate for convex bodies rather than a measured depth.
Frames are shown as stored, without interpolation between them.
The addon does not run, schedule or cancel bakes. Bake with Spume's command line or its Blender add-on.
