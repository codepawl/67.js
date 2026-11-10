# Materials and color

A material tells the renderer how light hits a part. 67js uses physically based shading (PBR), the model of Blender, Unreal and the glTF format. So the values from those tools mean the same thing here.

## The four basic fields

| Field | Values | Effect |
| --- | --- | --- |
| `color` | three numbers from 0 to 1 | The base color in linear RGB. Required. |
| `metallic` | 0 to 1 | 0 is a dielectric such as paint, plastic or wood. 1 is metal. Required. |
| `roughness` | 0 to 1 | 0 is polished, 1 is fully matte. Required. The renderer keeps a minimum of `0.075`. |
| `emission` | 0 or more | The strength of the light that the surface gives off. Optional, the default is 0. |
| `emissiveColor` | three numbers from 0 to 1 | The color of that light in linear RGB. Optional, the default is `color`. |

The chart below has a dielectric row in front and a metal row behind. Roughness goes from 0 on the left to 1 on the right. Drag to turn it.

```js live poster=materials-chart
import { Renderer67, sphere } from '67js';

const ball = sphere(48, 24);
const parts = [];
for (let column = 0; column < 5; column++) {
  for (const metallic of [0, 1]) {
    const x = (column - 2) * 0.95;
    const z = metallic ? -0.6 : 0.6;
    parts.push({
      name: `Ball ${column} ${metallic}`,
      geometry: ball,
      matrix: new Float32Array([0.4, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0.4, 0, x, 0.4, z, 1]),
      material: { color: metallic ? [0.95, 0.64, 0.32] : [0.75, 0.16, 0.14], metallic, roughness: column / 4 },
    });
  }
}

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const renderer = new Renderer67(canvas, parts);
let turn = 0;

function draw() {
  const eye = [Math.sin(turn) * 5.2, 2.6, Math.cos(turn) * 5.2];
  renderer.render({ eye, target: [0, 0.3, 0], fov: 36 });
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

A metal takes its reflection color from `color`, so gold, copper and steel differ by `color` only. A dielectric shows its `color` under a white reflection.

## Colors are linear

`color` and `emissiveColor` are linear RGB, not the sRGB values of CSS and color pickers. If you copy `#d94f2b` as `[0.85, 0.31, 0.17]`, the part looks too light and grey. Convert an sRGB hex color first:

```js
function linearColor(hex) {
  const channels = hex.replace('#', '').match(/../g).map(pair => parseInt(pair, 16) / 255);
  return channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
}

const material = { color: linearColor('#d94f2b'), metallic: 0, roughness: 0.5 };
```

## Textures

A texture is a descriptor: an object with an `image` and a `colorSpace`. The image can be an `HTMLImageElement`, an `ImageBitmap` or a canvas. Textures sample `geometry.uvs`, so the geometry needs two UV values for each vertex. `sphere()` and `torus()` have UVs.

```js live poster=materials-texture
import { Renderer67, sphere } from '67js';

// Draw a checkerboard on a 2D canvas and use it as the color map.
const pattern = document.createElement('canvas');
pattern.width = 256;
pattern.height = 128;
const pen = pattern.getContext('2d');
for (let row = 0; row < 8; row++) {
  for (let column = 0; column < 16; column++) {
    pen.fillStyle = (row + column) % 2 ? '#f2efe6' : '#2f6f8f';
    pen.fillRect(column * 16, row * 16, 16, 16);
  }
}

const globe = {
  name: 'Globe',
  geometry: sphere(64, 32),
  matrix: new Float32Array([0.8, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0.8, 0, 0, 0.8, 0, 1]),
  material: { color: [1, 1, 1], metallic: 0, roughness: 0.45, map: { image: pattern, colorSpace: 'srgb' } },
};

const canvas = document.querySelector('#scene');
const renderer = new Renderer67(canvas, [globe]);
new ResizeObserver(() => {
  renderer.resize();
  renderer.render({ eye: [2.2, 1.6, 3], target: [0, 0.75, 0] });
}).observe(canvas);
```

`map` multiplies `color`, so keep `color` white to show the image as it is. A material can have five texture channels:

| Field | Color space | Effect |
| --- | --- | --- |
| `map` | `'srgb'` | Multiplies the base color. |
| `normalMap` | `'linear'` | Adds surface detail that catches the light. `normalScale` sets its strength. |
| `metallicRoughnessMap` | `'linear'` | Multiplies roughness by G and metallic by B. |
| `occlusionMap` | `'linear'` | Darkens indirect light by R. `occlusionStrength` sets its strength. |
| `emissiveMap` | `'srgb'` | Multiplies `emissiveColor * emission`. |

The glTF addon makes these descriptors for you when it loads a GLB file. Reuse one descriptor object for many parts, because each new descriptor uploads a new texture. To change the pixels of an uploaded texture, import `@codepawlhq/67js/addons/texture-update` and call `renderer.updateTexture(descriptor, { image, region })`. The [material maps contract](https://github.com/codepawl/67.js/blob/main/docs/material-maps.md) lists the sampler settings and the limits.

## Transparency and both sides

`material.alphaMode` is `'opaque'` (the default), `'mask'` or `'blend'`. With `'mask'`, a pixel with alpha under `alphaCutoff` (default 0.5) is cut out, and shadows follow the cut. With `'blend'`, the part is drawn last, from back to front, and does not write depth. `material.opacity` (default 1) multiplies the alpha of the base map.

`material.doubleSided` (default false) turns off back-face culling and lights both faces. Use it for leaves, paper and cloth.

> **Warning:** `alphaMode`, `doubleSided` and the texture descriptors are batch state. `updateParts` cannot change them. Make a new renderer to change them. `updateParts` can change `color`, `metallic`, `roughness`, `emission`, `emissiveColor` and the matrix.

## Material tags

`material.tag` selects special shading. A part without a tag uses ordinary PBR shading.

| Tag | Effect |
| --- | --- |
| `unlit` | A flat color without light. Use it for 2D and for labels. |
| `floor` | The studio floor. |
| `armor` | Allows the studio finish overrides `armorColor` and `armorSurface` in the frame. |
| `water` | Animated normals and ripples. Flat water on horizontal surfaces only. |
| `liquid` | Shaped water that refracts, darkens with thickness and reflects the sky. |
| `foam` | Soft droplets for whitewater. |
| `foliage`, `grass` | Wind. They accept a `map` with an alpha mask, a `normalMap` and `doubleSided` for leaf cards. |
| `terrain`, `moss` | Surface variation for ground. |
| `fire`, `smoke` | Effects for films. |

A renderer that draws a `water`, `foliage`, `grass`, `terrain`, `moss`, `fire` or `smoke` part needs `import '@codepawlhq/67js/addons/world-material-shader'` first. A renderer that draws a transmissive, `liquid` or `foam` part needs `import '@codepawlhq/67js/addons/liquid-shader'`. The terrain, vegetation, grass, clutter and film addons and the MCP server import them for you.

The `color` of a `liquid` is the light that one meter of liquid lets through, so `[0.56, 0.84, 0.88]` is clear blue-green water. Tune liquid and foam with `frame.liquid` or `environment.liquid`: `{ thickness: 0.5, ior: 1.33, refraction: 1, scattering: 1, foamOpacity: 0.55, foamSoftness: 1 }`. A liquid refracts opaque parts only.

## High dynamic range

With `hdr: true`, the renderer keeps colors above 1 for bloom and exposure. HDR needs the `EXT_color_buffer_float` extension. If the device does not have it, the renderer falls back to normal range. Read `renderer.capabilities.hdr` and `renderer.capabilities.hdrFallbackReason` to see the result.
