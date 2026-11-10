# Import and export models

67js reads and writes GLB, the binary form of glTF 2.0. Blender, Maya, Sketchfab and most model sites export it. The importer is the addon `67js/addons/gltf`, so a scene without models does not download it.

## Load a GLB file

`loadGltf(url)` returns an asset. `asset.parts` is a list of ordinary parts, ready for `Renderer67`. The example loads a robot from this site and frames it from its size.

```js live poster=gltf-robot
import { Renderer67 } from '67js';
import { loadGltf } from '67js/addons/gltf';

// The smallest box that holds every vertex of every part, in world units.
function boundsOf(parts) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const { geometry, matrix } of parts) {
    const positions = geometry.positions;
    for (let index = 0; index < positions.length; index += 3) {
      const [x, y, z] = [positions[index], positions[index + 1], positions[index + 2]];
      for (let axis = 0; axis < 3; axis++) {
        const world = matrix[axis] * x + matrix[axis + 4] * y + matrix[axis + 8] * z + matrix[axis + 12];
        minimum[axis] = Math.min(minimum[axis], world);
        maximum[axis] = Math.max(maximum[axis], world);
      }
    }
  }
  return { minimum, maximum };
}

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const asset = await loadGltf('/wall-e.glb');
const renderer = new Renderer67(canvas, asset.parts, { hdr: true });
const { minimum, maximum } = boundsOf(asset.parts);
const center = minimum.map((value, axis) => (value + maximum[axis]) / 2);
const size = Math.max(...maximum.map((value, axis) => value - minimum[axis]));
let turn = 0.6;

function draw() {
  const distance = size * 1.9;
  const eye = [center[0] + Math.sin(turn) * distance, center[1] + size * 0.35, center[2] + Math.cos(turn) * distance];
  renderer.render({ eye, target: center, fov: 35 });
}

canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  turn -= event.movementX * 0.01;
  draw();
});
new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
```

`loadGltf` accepts a URL string, a `URL`, a `Blob` or a `File` from an `<input type="file">`. For an `ArrayBuffer` or a glTF JSON string, use `parseGltf(data, options)`. A `.gltf` file with separate `.bin` and texture files loads from its URL, because the importer finds the other files next to it. The result has these fields:

| Field | Meaning |
| --- | --- |
| `parts` | The parts, with world matrices, shared geometry and decoded textures. |
| `animations` | The animation clips in the file. |
| `applyAnimation(seconds, clipIndex)` | Poses the parts at a time and returns them for `renderer.updateParts`. |
| `warnings` | Features of the file that the importer skipped. |
| `dispose()` | Releases the decoded images. |

The importer reads meshes, vertex colors, the five PBR texture channels, alpha modes, double-sided materials, skins, morph targets and animation. It has its own parser and does not use three.js. The [asset contract](/gltf.md) lists the supported extensions, the decoders for compressed files and the size limits.

> **Tip:** A model from Poly Haven or a similar site often comes as a folder with a `.gltf` file, a `.bin` file and textures. `loadGltf` reads that folder from its URL. To make one GLB file of it, run `npx @gltf-transform/cli copy model.gltf model.glb`.

## Play an animation

If `asset.animations` is not empty, pose the asset at a time in each frame:

```js
function frame(milliseconds) {
  renderer.updateParts(asset.applyAnimation(milliseconds / 1000, 0));
  renderer.render({ eye, target });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

The second argument is the index of the clip. Skinned characters work the same way. [Skeletal and morph animation](#skeletal-and-morph-animation) and [Humanoid retargeting and crowds](#humanoid-retargeting-and-crowds) explain rigs, blending and moving one clip onto another character.

## Save a picture or a model

The canvas holds the last frame until the browser paints. Draw a frame, then read the canvas in the same task. `exportGlb(parts)` returns the parts as a GLB `ArrayBuffer`. Click the buttons in the example to save both files.

```js live poster=export-buttons
import { Renderer67, box, sphere, exportGlb } from '67js';

const placeAt = (x, y, z, size) => new Float32Array([size, 0, 0, 0, 0, size, 0, 0, 0, 0, size, 0, x, y, z, 1]);
const parts = [
  { name: 'Cube', geometry: box(), matrix: placeAt(-0.6, 0.5, 0, 1), material: { color: [0.2, 0.55, 0.38], metallic: 0, roughness: 0.55 } },
  { name: 'Ball', geometry: sphere(), matrix: placeAt(0.9, 0.45, 0.2, 0.45), material: { color: [1, 0.72, 0.3], metallic: 1, roughness: 0.25 } },
];
const canvas = document.querySelector('#scene');
const renderer = new Renderer67(canvas, parts);
const draw = () => renderer.render({ eye: [0, 2, 4.5], target: [0, 0.4, 0] });

function save(blob, fileName) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}

function button(label, onClick) {
  const element = document.createElement('button');
  element.textContent = label;
  element.style.cssText = 'position:fixed;top:12px;padding:8px 14px;border:0;border-radius:10px;background:#ececec;color:#171717;font:14px system-ui';
  element.style.left = `${12 + document.querySelectorAll('button').length * 120}px`;
  element.addEventListener('click', onClick);
  document.body.append(element);
}

button('Save PNG', () => {
  draw();
  canvas.toBlob(blob => save(blob, 'scene.png'), 'image/png');
});
button('Save GLB', () => {
  save(new Blob([exportGlb(parts)], { type: 'model/gltf-binary' }), 'scene.glb');
});

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
```

`toBlob` reads the canvas at its real size, which is the CSS size times `pixelRatio`. For a picture of a fixed size, set the canvas size before you draw, or use `npm run render` from a checkout ([Images and films](#images-and-films)).

The GLB keeps the geometry, the shared meshes, the colors, the UVs, the emission and the current morph weights. It is a snapshot of the static scene, not a full round trip of textures and animation. For an exploded view, apply `assemblyOffset` to copies of the matrices before the export. The [GLB snapshot contract](/export-glb.md) lists every stored channel.

## Release the asset

Release the renderer first, then the asset:

```js
renderer.dispose();
asset.dispose();
```
