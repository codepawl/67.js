# Depth prepass

Glaze can draw the depth of its opaque batches first, with the colour mask off, and then shade only the fragments that are still in front. It is off by default, because on dense scans it costs more than it saves.

```js
const renderer = new CrucibleRenderer(canvas, parts, { depthPrepass: 'auto' }); // true, false (default) or 'auto'
renderer.setDepthPrepass(true);   // change it later
renderer.depthPrepassActive;      // whether the last frame drew it
```

- `true` draws it whenever the frame has opaque batches that qualify.
- `'auto'` draws it only for frames with at most 0.03 opaque triangles per canvas pixel and at least 100,000 of them: large triangles that overlap. The limit is a guess; see the numbers below.
- `false` never draws it.

## What takes part

Opaque batches whose colour shader never discards. Cutout (`mask`), blend, additive, translucent, splat, impostor and fading batches, batches with a material snippet, render passes, the water mirror and the benchmark renderer draw as before.

The prepass uses a second program with the colour pass's own vertex shader, so skinning, morph targets, wind, depth ranks and camera-relative reversed depth go through the same code. `invariant gl_Position` makes the two programs write the same depth. The colour pass then tests `LEQUAL` (`GEQUAL` in reversed depth) with depth writes off. Two opaque faces at exactly the same depth, which z-fight anyway, may swap which one shows.

## Measured

Headless Chrome on ANGLE D3D11, 1280 by 720, 4x MSAA, HDR, one shared card, so absolute milliseconds move by up to 3x between runs. Frames alternated off, on, prepass only inside one run, and the medians below are GPU ms of a whole frame. `bench/glaze-passes/run.mjs` with `"alternate":true` reproduces them.

| Scene | Triangles per pixel | Off | On | Prepass alone |
| --- | ---: | ---: | ---: | ---: |
| Monster (1.6M triangles) | 1.7 | 9.5 | 12.0 | 3.3 |
| Lone Monk (5.6M) | 6.0 | 31.3 | 39.9 | 7.7 |
| Classroom (0.6M) | 0.7 | 14.9 | 18.6 | 6.6 |
| Classroom at 3840 by 2160 | 0.07 | 29.4 | 29.7 | 15.7 |

The colour pass after the prepass is cheaper only where triangles overlap (Classroom: 14.9 down to 12.0 ms). On the two scans it barely changes (Monster 9.5 to 8.7, Monk 31.3 to 32.1): their cost is the number of sub-pixel triangles under 4x MSAA, which every front-facing triangle still pays in the colour pass and the depth pass pays again. So the prepass is a loss at 1 to 6 triangles per pixel and breaks even near 0.07.
