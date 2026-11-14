# Crucible guide

Build a scene once. Make it interactive. Export the frame or film.

Crucible is a WebGL2 graphics toolkit with shared geometry, deterministic animation and a bounded media pipeline. It is not API-compatible with Three.js and does not provide a Blender-style modeling editor.

## Render a PNG from a script without MCP

A coding agent that has no MCP client can still produce an image from the installed package.
The renderer needs a browser, so the script serves one page over HTTP and reads the canvas back through `playwright-core`, which the package already depends on.
It needs an installed Google Chrome. Use `executablePath` instead of `channel` for another Chromium. Run it from the folder that holds `node_modules`.
The import map assumes the alias install (`node_modules/crucible`). After a plain `npm install @codepawlhq/crucible`, use `node_modules/@codepawlhq/crucible` in the map instead.

```js
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const page = `<!doctype html>
<script type="importmap">{ "imports": { "crucible": "/node_modules/crucible/build/67.module.js" } }</script>
<canvas width="512" height="512"></canvas>
<script type="module">
  import { CrucibleRenderer, box } from 'crucible';
  const parts = [{
    name: 'Box',
    geometry: box(),
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    material: { color: [0.8, 0.3, 0.2], metallic: 0, roughness: 0.35, emission: 0 },
  }];
  const canvas = document.querySelector('canvas');
  new CrucibleRenderer(canvas, parts, { samples: 4, memoryBudgetMiB: 256 }).render({ eye: [3, 2.5, 4], target: [0, 0, 0] });
  window.pngDataUrl = canvas.toDataURL('image/png');
</script>`;

const server = createServer(async (request, response) => {
  if (request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html' }).end(page);
    return;
  }
  try {
    const file = await readFile(`.${request.url}`);
    response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(file);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const browser = await chromium.launch({ channel: 'chrome' });
const tab = await browser.newPage();
await tab.goto(`http://127.0.0.1:${server.address().port}/`);
await tab.waitForFunction(() => window.pngDataUrl);
const dataUrl = await tab.evaluate(() => window.pngDataUrl);
await writeFile('box.png', Buffer.from(dataUrl.split(',')[1], 'base64'));
await browser.close();
server.close();
```

The canvas is read in the same task as the render, so no `preserveDrawingBuffer` option is needed.
The frame clears to a dark grey behind the scene. Pass `background: [red, green, blue]` or `[red, green, blue, alpha]` (each `0` to `1`) as a renderer option, or call `renderer.setBackground(color)` between frames; `setBackground(null)` restores the grey. With `transparent: true` the canvas clears to nothing unless you give a `background`, whose alpha then shows the page behind the canvas. A scene sky or environment background still covers it, and the scene recipe's background field does not reach this option yet.
The `matrix` is a column-major 4x4 transform, and `box()` is a unit cube centred on the origin.
The MCP server (`crucible-mcp`) is the route for scene recipes, review grids and video, and `npm run render` in a source checkout exports video.

## Addons and limits

Core exports are available from `crucible`:

| Export | Purpose |
| --- | --- |
| VERSION | Build version from the package metadata |
| CrucibleRenderer | WebGL2 rendering and owned GPU resources |
| box, cylinder, sphere, torus | Shared primitive geometry |
| exportGlb | Geometry and basic material export |
| RENDER_PRESETS | Dimensions, MSAA, FPS and budgets for media |
| planRenderSize | Plan dimensions against the estimated allocation budget |
| estimateFrameBytes | Estimate targets and staging for a frame |
| assemblyOffset | Compute section and small-detail displacement |
| cameraView, fitOrthographicHeight | Axis cameras and fitted bounds |
| EFFECT_PRESETS, resolveEffects | Named looks and validated effect settings |
| createAnimationClip, sampleAnimationClip, createAnimationPlayer | Validate tracks, sample time and bind part animation |

`planRenderSize` accepts width, height, pixelRatio, samples, memoryBudgetMiB, geometryBytes, textureBytes, hdr, bloom, shadowResolution and maximumSize. It returns actual dimensions, estimatedBytes and reduced status. `estimateFrameBytes(width, height, samples, shadowResolution, { hdr, bloom })` estimates target storage. Neither function measures total VRAM.

`crucible/addons/model`: createModel. `crucible/addons/nature`: createNatureWorld. `crucible/addons/motion`: createMotionScene.

`crucible/addons/canvas2d`: 2D recipes. `crucible/addons/gltf`: optional asset decoding. These are separate imports to keep the core smaller.

The [three.js bridge](https://github.com/codepawl/crucible/blob/main/docs/three-bridge.md) imports a three.js object tree as parts and exports parts back to three.js objects and GLB.

Other people's addons follow the [addon contract](addons.md): a peer dependency on Crucible, the `crucible-addon` keyword and a `crucible` manifest.

Crucible targets WebGL2. Version `0.4.0` includes the APIs below. Check the installed package version and release metadata before using them.

## Release and source availability

Published npm `0.4.0` includes modeling, sculpting, static mesh queries, shrinkwrap, surface patches, animation mixing, skinning, morphs, physics and lighting.
Retained [surface attachments](https://github.com/codepawl/crucible/blob/main/docs/surface-attachment.md) are introduced in `0.4.1` and are absent from published npm `0.4.0`.
Source checkouts can contain unreleased changes beyond their package version.

The [release metadata](/release.json) identifies the published package and browser module.
The checkout's `CHANGELOG.md` lists released features; the files in `changes/` hold the notes of unreleased work.
The [GLB snapshot contract](/export-glb.md) describes geometry, colors, UVs, HDR emission and current morph weights.
Module contracts define their own resource limits and disposal requirements.
