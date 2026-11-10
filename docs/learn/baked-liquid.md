# Baked liquid

`67js/addons/spume` plays back liquid that the Spume GPU solver baked offline. It is available from version `0.10.0`. The browser does not simulate anything: it loads a cache of frames and shows the frame for a time, so scrubbing and looping are free.

## Cache, frame, time

The docs host has no baked cache to serve, so the example writes a small one in memory in Spume's own file format: a `meta.json` and one `frame_NNNN.glb` per frame, with positions packed as int16 over each frame's own bounding box and normals as int8. It then loads that cache with `loadSpumeCache` through a reader function, which is the same call that loads a folder from a server, and plays it with `createSpumePlayer`. The cache is a rippling water surface over a stone slab. Drag the slider to scrub. Tick Loop to wrap time instead of holding the last frame. The console prints the cache size, the frame index for a time and how long each `replaceParts` took.

```js live poster=spume-playback
import { Renderer67, box } from '67js';
import { loadSpumeCache, createSpumePlayer } from '67js/addons/spume';

// Bake: a ripple that spreads from the middle. In the real workflow the Spume solver does this offline.
const fps = 20;
const frameCount = 40;
const gridSide = 25;
const halfWidth = 3;
function surfaceHeight(x, z, seconds) {
  const distance = Math.hypot(x, z);
  return 0.22 * Math.sin(2.4 * distance - 5 * seconds) / (1 + 0.6 * distance) + 0.05 * Math.sin(3 * x + 2 * seconds);
}
function bakeFrame(seconds) {
  const positions = [];
  const normals = [];
  const step = 0.01;
  for (let row = 0; row < gridSide; row++) {
    for (let column = 0; column < gridSide; column++) {
      const x = -halfWidth + column / (gridSide - 1) * halfWidth * 2;
      const z = -halfWidth + row / (gridSide - 1) * halfWidth * 2;
      positions.push(x, 0.5 + surfaceHeight(x, z, seconds), z);
      const slopeX = (surfaceHeight(x + step, z, seconds) - surfaceHeight(x - step, z, seconds)) / (2 * step);
      const slopeZ = (surfaceHeight(x, z + step, seconds) - surfaceHeight(x, z - step, seconds)) / (2 * step);
      const length = Math.hypot(slopeX, 1, slopeZ);
      normals.push(-slopeX / length, 1 / length, -slopeZ / length);
    }
  }
  const indices = [];
  for (let row = 0; row < gridSide - 1; row++) {
    for (let column = 0; column < gridSide - 1; column++) {
      const corner = row * gridSide + column;
      indices.push(corner, corner + gridSide, corner + 1, corner + 1, corner + gridSide, corner + gridSide + 1);
    }
  }
  return { positions, normals, indices };
}

// Pack one frame like Spume's export: int16 positions over the frame's own min..max box, int8 normals, a binary glTF.
function padToFour(bytes, fill = 0) {
  const padded = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4).fill(fill);
  padded.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return padded;
}
function encodeFrame({ positions, normals, indices }) {
  const minimum = [0, 1, 2].map(axis => Math.min(...positions.filter((unused, index) => index % 3 === axis)));
  const maximum = [0, 1, 2].map(axis => Math.max(...positions.filter((unused, index) => index % 3 === axis)));
  const span = maximum.map((value, axis) => Math.max(value - minimum[axis], 1e-6));
  const packedPositions = Int16Array.from(positions, (value, index) => Math.round((value - minimum[index % 3]) / span[index % 3] * 65535 - 32768));
  const packedNormals = Int8Array.from(normals, value => Math.round(value * 127));
  const indexBytes = padToFour(Uint16Array.from(indices));
  const positionBytes = padToFour(packedPositions);
  const normalBytes = padToFour(packedNormals);
  const description = {
    asset: { version: '2.0', generator: 'docs example' },
    buffers: [{ byteLength: indexBytes.length + positionBytes.length + normalBytes.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: indexBytes.length },
      { buffer: 0, byteOffset: indexBytes.length, byteLength: positionBytes.length },
      { buffer: 0, byteOffset: indexBytes.length + positionBytes.length, byteLength: normalBytes.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5123, count: indices.length, type: 'SCALAR' },
      { bufferView: 1, componentType: 5122, count: positions.length / 3, type: 'VEC3', min: minimum, max: maximum },
      { bufferView: 2, componentType: 5120, normalized: true, count: normals.length / 3, type: 'VEC3' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 1, NORMAL: 2 }, indices: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const json = padToFour(new TextEncoder().encode(JSON.stringify(description)), 32);
  const binary = new Uint8Array([...indexBytes, ...positionBytes, ...normalBytes]);
  const total = 12 + 8 + json.length + 8 + binary.length;
  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, json.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.set(json, 20);
  view.setUint32(20 + json.length, binary.length, true);
  view.setUint32(24 + json.length, 0x004e4942, true);
  glb.set(binary, 28 + json.length);
  return glb.buffer;
}

const files = { 'meta.json': new TextEncoder().encode(JSON.stringify({ name: 'ripple', fps, frameCount, frameFile: 'frame_%04d.glb' })).buffer };
for (let frame = 0; frame < frameCount; frame++) {
  files[`frame_${String(frame).padStart(4, '0')}.glb`] = encodeFrame(bakeFrame(frame / fps));
}
const totalBytes = Object.values(files).reduce((sum, bytes) => sum + bytes.byteLength, 0);

const cache = await loadSpumeCache(async fileName => files[fileName] ?? null);
const player = createSpumePlayer(cache, { loop: false });
console.log(`cache: ${player.frameCount} frames at ${player.fps} fps, ${player.duration.toFixed(2)} s, ${(totalBytes / 1024).toFixed(1)} KiB in ${Object.keys(files).length} files`);

const scenery = [{ name: 'Slab', geometry: box(0.1, 3), matrix: new Float32Array([6.4, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 6.4, 0, 0, -0.1, 0, 1]), material: { color: [0.45, 0.43, 0.4], metallic: 0, roughness: 0.8 } }];
const canvas = document.querySelector('#scene');
const renderer = new Renderer67(canvas, [...scenery, ...player.partsAt(0)]);
const timings = [];
const state = { seconds: 0.5, playing: true, loop: false };
let last = performance.now();

function draw() {
  const start = performance.now();
  renderer.replaceParts([...scenery, ...player.partsAt(state.seconds)]);
  timings.push(performance.now() - start);
  renderer.render({ eye: [0, 4, 8], target: [0, 0.5, 0], fov: 40 });
}

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;bottom:8px;display:flex;gap:10px;align-items:center;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
const toggle = document.createElement('button');
toggle.textContent = 'Pause';
const slider = document.createElement('input');
slider.type = 'range';
slider.min = 0;
slider.max = player.duration;
slider.step = 0.01;
slider.value = state.seconds;
const loopLabel = document.createElement('label');
const loopBox = document.createElement('input');
loopBox.type = 'checkbox';
loopLabel.append(loopBox, 'loop');
bar.append(toggle, slider, loopLabel);
document.body.append(bar);
toggle.addEventListener('click', () => { state.playing = !state.playing; toggle.textContent = state.playing ? 'Pause' : 'Play'; last = performance.now(); });
loopBox.addEventListener('change', () => { state.loop = loopBox.checked; console.log('loop', state.loop); });
slider.addEventListener('input', () => { state.playing = false; toggle.textContent = 'Play'; state.seconds = Number(slider.value); draw(); });
slider.addEventListener('change', () => console.log(`t=${state.seconds.toFixed(2)} s -> frameIndexAt ${player.frameIndexAt(state.seconds)}`));

let nextReport = 1;
function frame(now) {
  if (state.playing) {
    state.seconds += (now - last) / 1000;
    state.seconds = state.loop ? state.seconds % player.duration : Math.min(state.seconds, player.duration);
    slider.value = state.seconds;
    draw();
  }
  last = now;
  if (state.playing && timings.length && performance.now() / 1000 > nextReport) {
    const average = timings.reduce((sum, value) => sum + value, 0) / timings.length;
    console.log(`replaceParts averaged ${average.toFixed(2)} ms over ${timings.length} frames`);
    timings.length = 0;
    nextReport = performance.now() / 1000 + 2;
  }
  requestAnimationFrame(frame);
}
new ResizeObserver(() => renderer.resize()).observe(canvas);
requestAnimationFrame(frame);
addEventListener('pagehide', () => renderer.dispose());
```

The player is made with `loop: false`, so time past the last frame holds it, and the example wraps time itself when you tick Loop. A real cache also holds whitewater points per frame, which the player draws with the `foam` material next to the `liquid` mesh that refracts the slab.

## Play a real cache from a folder

1. Bake a cache folder with Spume's `run.py` or its Blender add-on.
2. Load it with `loadSpumeCache(folderUrl)`.
3. Create a player with `createSpumePlayer(cache, { matrix, loop })`.
4. Each frame, call `renderer.replaceParts([...sceneParts, ...player.partsAt(seconds)])` and render.

```bash
uv run python run.py --out out/geyser --name geyser --pressure cg --iterations 20
```

A low-resolution check takes seconds after the first kernel compile: `uv run python run.py --out out/test --cell 0.2 --width 6 --height 12 --frames 40 --mesh-cell 0.25`. Units are metres with +Y up and the floor at y = 0, which matches 67js. Serve the output folder next to the page. It holds `meta.json`, one `frame_NNNN.glb` per frame and the whitewater files `spray.bin`, `spray_ids.bin` and `spray_kinds.bin`.

```js
const cache = await loadSpumeCache('/caches/geyser/');
const player = createSpumePlayer(cache, { matrix: placeAt(0, 0, 0), loop: true });
```

`loadSpumeCache(source)` accepts a folder URL or an `async (fileName) => ArrayBuffer | null` reader, so the same cache loads from a server, from disk in Node or from a dropped folder. It validates `meta.json`, reads every frame file and keeps frames int16-packed until they are played, which is about a fifth of the decoded size. The frame files are not general glTF: positions are int16 spread over each frame's own min..max box, so standard loaders, including `67js/addons/gltf`, read them at the wrong scale. Use `decodeSpumeFrame(bytes)` for one frame.

Skinned and morphed parts may stay in the list unchanged while frames are replaced. Adding or removing them needs a new renderer. Textured parts can be added and removed once `import '@codepawlhq/67js/addons/replace-textured-parts'` has run. Without it they must stay unchanged. The addon deletes a texture when no part uses it any more and keeps one another part still binds.

## Options

| Member or option | Meaning |
| --- | --- |
| `partsAt(seconds)` | Parts for the frame shown at that time: the liquid mesh, plus whitewater when the frame has any. |
| `partsForFrame(index)` | The same by frame number. |
| `frameIndexAt(seconds)` | The frame number for a time, clamped or wrapped. |
| `frameCount`, `fps`, `duration` | From `meta.json`. |
| `matrix` | Default identity. Places the bake; positions are relative to the first opening's centre on the floor (`meta.origin`). |
| `waterMaterial` | Default `DEFAULT_WATER_MATERIAL`, any rigid untextured material. The default uses the `liquid` tag with `color: [0.56, 0.84, 0.88]`. |
| `sprayMaterial` | Default `DEFAULT_SPRAY_MATERIAL`. The default uses the `foam` tag, with per-point vertex colours for foam and bubbles. |
| `spray` | Default `{ radius: 0.014, shutter: 1 / 60, kinds: ['spray', 'foam'], maxPoints: 12000 }`, or `null` for liquid only. Bubbles are hidden by default. |
| `loop` | Default `false`. Wraps time instead of holding the last frame. |
| `cachedFrames` | Default `4`. Decoded frames kept for reuse, so scrubbing over a few frames costs nothing after the first decode. |

## Cost

Measured on the slab bake (the README example at 10 cm cells, 60 frames, 79 thousand liquid particles, up to 12,177 liquid vertices and 12,000 droplets shown) on an RTX 3060 in Chrome: `replaceParts` with a fresh frame took 7 to 13 ms and the render about 0.5 ms. The cache is 7.1 MB of frames. Decoding a frame takes about 1.3 ms and building its droplets about 4.5 ms in Node. Lower `maxPoints` first when a large bake drops frames, and raise `cachedFrames` for scrubbing (docs/spume.md).

## Limits

- A liquid refracts only opaque parts, not other liquids or itself, and its thickness is an estimate for convex bodies.
- Frames are shown as stored, without interpolation between them.
- The addon does not run, schedule or cancel bakes. Bake with Spume's command line or its Blender add-on.

The [Spume contract](https://github.com/codepawl/67.js/blob/main/docs/spume.md) covers the cache format, whitewater options, placement and measured cost.

## Common mistakes

- Loading a frame file with the glTF loader. The int16 packing needs `decodeSpumeFrame`.
- Forgetting `loop: true` and wondering why the liquid freezes on the last frame.
- Mixing the liquid with parts that change topology without a new renderer.
- Leaving `maxPoints` high on a large bake. Lower it first.
