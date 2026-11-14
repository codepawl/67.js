# Mesh blend

Where a rock sinks into terrain or a trunk into the ground, the two meshes meet in a hard, straight seam. Mesh blend is a screen-space pass (the idea of the MeshBlend plugin for Unreal) that mixes the colour of the surface a part cuts into over a short distance. A part opts in with `blend: { radius }`, the distance in metres:

```json
{ "id": "rock-1", "geometry": "rock", "material": "stone", "blend": { "radius": 0.15 } }
```

Mark the rocks, trunks and roots, and the terrain too if you want its colour to take on the rock's. A node without `blend` draws as before: a scene with no `blend` part renders the same pixels as one without the addon, and loads none of it. `set-node` takes `blend` like any node field.

## How it works

For each pixel of a blend part, the pass looks at 24 taps on a spiral within `radius` (converted to pixels at that distance, 1 to 40 pixels). A tap counts when it shows another part (an object ID differs), its surface point lies within three radii of this pixel (a depth match: a silhouette against the sky or a far wall never counts), and the two surfaces are not parallel (a normal discontinuity, rebuilt from the depth). The part IDs come from the lit pass itself: while a part has `blend`, the main shader writes the ID into a second colour attachment of the multisample framebuffer (the `meshBlend` shader feature, so a scene without `blend` compiles no extra output), and the stage resolves it. WebGL2 cannot multisample an integer target, so the resolve averages the samples of an edge pixel; the ID is three bytes plus a checksum byte, and an edge pixel that fails the checksum is read as no part (it is already an antialiased mix of both sides). The share of taps that count, weighted toward the pixel, sets how much of the other part's colour mixes in. It does not blend across a part's own edges.

## Cost and limits

- No second draw of the geometry: the cost is the extra RGBA8 attachment (multisample, resolved, cleared each frame) and one fullscreen pass that returns at once for every pixel outside a blend part. Measured on an RTX 3060 at 1080p (4x MSAA, a terrain with five sunk rocks and a trunk, 12 rounds of 120 frames, GPU timer query): 0.665 ms of GPU time with the addon installed and no blend part, 0.932 ms with blend, a cost per round of 0.26 to 0.30 ms (median 0.27 ms; 0.25 to 0.58 ms on a card shared with other jobs). Before issue #489 it was about 0.55 ms: the tap loop computed a square root, sine and cosine per tap, and the two normals rebuilt from depth kept that work alive. What is left is about 0.035 ms each for the attachment and its resolve, 0.07 ms for the fullscreen pass itself and the rest in the taps. `node bench/reference/mesh-blend.mjs --only-cost` repeats it and prints the wall clock and GPU time per round.
- Needs a renderer with `depth: true`; the render passes addon is not needed. The MCP preview has depth.
- Opaque and cutout parts only. A blended part writes no ID, and translucent water or glass drawn over a blend part leaves that pixel unblended or with a stale ID (the liquid programs do not write the attachment).
- A blend part mixes toward the part on the other side of its seam; the other part changes only if it has `blend` too. Marking both gives the soft seam from both sides.
- A seam under about one pixel wide (a tiny radius far from the camera) is left alone. The path tracer does not run the pass.
- The part ID is the draw order of opaque instances. Culling packs the visible instances of a batch (one geometry and material) inside its own ID range, so a batch whose parts all share one radius and draw at one level keeps its frustum culling. A batch that mixes radii, or one with LOD levels (each level draw restarts the instance numbers), is drawn without culling or level selection while the pass is on, so its IDs stay in order; a large instanced forest of mixed radii pays that. More than 16 million parts is not supported (the ID has 24 bits).
- In a recipe, a wrong `blend` value (`radius` outside 0.005 to 2, an unknown field) is reported when the preview draws the frame, with the message of the field.

## Code

```js
import { installMeshBlend } from '@codepawlhq/crucible/addons/mesh-blend';

const renderer = installMeshBlend(new CrucibleRenderer(canvas, parts, { depth: true, hdr: true }));
// parts: [{ name, geometry, material, matrix, blend: { radius: 0.15 } }, ...]
```

Install it before `installLineArt` so the lines draw over the blended colour. `renderer.meshBlend.radii` is a `Map` from part name to radius for hosts whose parts do not carry the option (the recipe preview fills it from the nodes). `bench/reference/mesh-blend.mjs` renders the before and after still of a terrain with sunk rocks and a trunk, checks the pixels against main and measures the frame.
