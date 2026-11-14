# Vegetation

`crucible/addons/vegetation` grows seeded trees, bushes and grass, scatters them on terrain and switches detail by distance.
It is available from version `0.10.0`. Everything returns plain renderer parts: geometry, a matrix and a material.

```js
import { CrucibleRenderer } from 'crucible';
import { scatterVegetation, selectLevels } from 'crucible/addons/vegetation';

const forest = scatterVegetation({
  area: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
  density: 0.016,
  terrainHeight: (x, z) => Math.sin(x * 0.1) * 1.5,
  slopeLimit: 30,
  exclusion: (x, z) => Math.hypot(x, z) < 8,
  mix: { broadleaf: 3, birch: 1.5, conifer: 2, bush: 2.5 },
  leaves: 'cards',
  seed: 11,
});
const view = selectLevels(forest.instances, camera.eye, { cullDistance: 120 });
const renderer = new CrucibleRenderer(canvas, [terrain, ...view.parts], options);
```

## Trees

`createTree(species | { species, height, leaves }, seed)` grows one tree. Species: `broadleaf`, `birch`, `conifer`, `palm`, `bush`.
The same species and seed always give the same tree.

The skeleton is a parametric recursive branching model: each generation has a length, wander, tropism (up or droop), taper and child spread.
It was chosen over space colonization because a species is a short readable preset, the cost is known before growing, and conifer whorls and palm fronds fit the same code.
Branches are swept tubes with parallel-transported rings, a taper, a root flare below the ground line and bark UVs (`u` around, `v` along, one tile per 0.6 m).
Leaves sit on terminal twigs, face outward and up with jitter, and carry vertex colors that darken toward the crown center, so the canopy has depth.
Shading normals blend toward the crown, so a flat card lights like part of a rounded crown.

The tree has four levels of detail, each listing parts with a `role`, `geometry`, `material` and `tintable` flag:

| Level | Content | Default switch distance |
| --- | --- | --- |
| 0 | Full skeleton, every leaf site | up to 38 m |
| 1 | Twigs dropped, fewer sides, one third of the leaves 1.7 times larger | 38 to 95 m |
| 2 | Trunk and main limbs, crown as merged clumps (low-poly blobs or crossed cards) | 95 to 150 m |
| 3 | The same with a third of the rings on each limb, three or four sides and crown clumps 1.5 times wider | beyond 150 m |

Measured triangle counts for seed 4 (level 0 / 1 / 2 / 3):

| Species | `cards` | `mesh` |
| --- | --- | --- |
| broadleaf | 5.8k / 1.8k / 0.5k / 0.3k | 24.0k / 7.9k / 3.2k / 3.0k |
| birch | 7.9k / 2.3k / 0.6k / 0.4k | 21.9k / 7.0k / 2.8k / 2.6k |
| conifer | 18.5k / 4.7k / 2.2k / 0.9k | 63.9k / 19.8k / 3.4k / 2.2k |
| palm | 3.8k / 1.0k / 0.9k / 0.4k | 11.8k / 3.7k / 2.9k / 2.4k |
| bush | 3.1k / 1.1k / 0.4k / 0.2k | 10.9k / 3.7k / 1.8k / 1.8k |

In the shadow map, foliage has its own thinner layers (`shadowLods` on the foliage part: a third of the leaves 1.7 times larger, then an eighth 2.8 times larger), and the bark has a trunk with half the sides and one with a third of the rings. The renderer picks one by the size of a shadow texel.

Cards are single-sided now that the renderer honors `doubleSided`; the old duplicated back faces cost 22 to 41 percent of level 0 (broadleaf 7.4k to 5.8k, birch 10.7k to 7.9k, conifer 26.1k to 18.5k, palm 6.4k to 3.8k, bush 4.7k to 3.1k).

## Scanned bark

`createTree({ species, barkTextures, barkTileSize })` and `scatterVegetation({ barkTextures })` take scanned bark as texture descriptors (see [Material maps](/material-maps.md)):
one set `{ color, normal, roughness }` for every species, or an object keyed by species (`{ broadleaf: set, conifer: set, palm: set }`; species without an entry keep procedural bark).
Every descriptor needs repeat wrapping. `roughness` goes to `metallicRoughnessMap`, which reads roughness from G and metallic from B, so repack a grey roughness scan as `(1, roughness, 0)` first or the bark turns metallic. `public/textures` holds `bark_willow_02`, `pine_bark` and `palm_tree_bark` (CC0, see its CREDITS.md); the demo maps broadleaf to willow, conifer to pine and palm to palm bark, and leaves birch procedural white.

Scanned bark gets world-scale UVs: `v` runs along the branch and `u` around it at `barkTileSize` meters per tile (default 0.8), computed per ring so a trunk and a twig have the same texel density and square texels.
Rings wide enough for 1.5 tiles or more wrap a whole number of tiles, so they have no seam. Thinner rings keep the exact scale and put their seam on the underside, away from the usual view. Without `barkTextures` the procedural bark keeps its whole-number repeats and 0.6 m tile.

## Scanned leaves

`createTree({ species, leafTextures })` and `scatterVegetation({ leafTextures })` swap the procedural leaf cards for scanned ones. `loadLeafTextures('/textures/leaves')` from `crucible/addons/texture-set` returns `{ broadleaf, birch, bush, conifer }`, each `{ color, normal, crown }`, ready to pass straight in:

```js
import { loadLeafTextures } from 'crucible/addons/texture-set';

const leafTextures = await loadLeafTextures('/textures/leaves');
const forest = scatterVegetation({ area, leafTextures, barkTextures, seed: 11 });
```

`color` is RGBA with the leaf mask in alpha and the twig at the bottom edge; `normal` is an OpenGL tangent-space map that the `foliage` tag applies on top of its canopy normal at `normalScale` 0.7; `crown` is the dense clump used for level 2. Species without an entry (palm, grass) keep procedural cards, and `leaves: 'mesh'` ignores the option. Geometry is identical either way, so switching textures never changes triangle counts.

The cards in `public/textures/leaves` are composited by `scripts/build-leaf-cards.py` from three CC0 ambientCG leaf atlases (beech LeafSet024 for broadleaf and birch, LeafSet022 for bush, cedar sprays LeafSet019 for conifer): it cuts every leaf from its atlas, lays leaves alternately along a curved twig (or sprays into a narrow branch tip), rotates the normal vectors with each leaf, and bleeds colour into the transparent pixels so mipmaps have no dark fringe. Each card is 512 px, about 40 to 90 KB in WebP.

## Leaves: cards or mesh

`leaves: 'cards'` (default) uses an RGBA leaf texture (procedural, or scanned with `leafTextures`) (`material.map`) on crossed, slightly curved cards with the `foliage` tag (`grass` for grass cards), `alphaMode: 'mask'`, `alphaCutoff: 0.5` and `doubleSided: true`.
Cards rely on the renderer's alpha masking with alpha-to-coverage under MSAA; with `samples: 1` their edges fall back to a hard cutout.
Cards hold one face each and `doubleSided` draws the back. For the `foliage` and `grass` tags the fragment shader does not flip the normal on a back face, so the canopy-leaning shading normal lights both sides alike and the existing back-lighting term adds translucency.
`leaves: 'mesh'` builds real leaf silhouettes (ovate, fir spray, palm leaflet) as folded, drooping meshes with the `foliage` tag. It needs no alpha support and costs about twice the triangles.

Wind: the vertex shader sways only the `foliage` and `grass` tags, and those tags accept a base-colour `map` with alpha mask, a `normalMap` and `doubleSided` (other maps stay unsupported). Cards, mesh leaves and grass blades sway; bark (a standard material) stays still.
The displacement is a pure function of `frame.time`, `frame.wind` (default 0.3), the vertex's local position and its uv: a slow sway that grows with height and with distance from the tree's axis (branch tips swing more than the crown centre, both capped at 2.5 m and 3 m so leaves stay near their twigs) plus a faster flutter that grows toward each leaf's tip (`uv.y` 0).
The shadow vertex shader applies the same function, and the renderer redraws the shadow map whenever `frame.time` or `frame.wind` changes while a `foliage` or `grass` batch casts shadows, so shadows follow the leaves. This costs one extra shadow pass per frame for scenes with swaying foliage.

## Grass and flowers

`createGrassClump({ blades, height, radius, style, seed })` builds `blades` (curved tapered blades with the `grass` tag, level 1 has half the blades) or `cards` (three crossed alpha cards).
`createFlowerPatch({ flowers, height, color, seed })` builds stems, six petals and a center; color lives in vertex colors.
`createGrassField(options)` is `scatterVegetation` with a grass and flower mix at 2.5 clumps per square meter.

## Scattering

`scatterVegetation({ area, density, terrainHeight, slopeLimit, exclusion, seed, mix, variants, leaves, scale, spacing })`:

- Poisson-disk spacing (Bridson with restarts, so exclusion zones cannot strand regions). `density` is instances per square meter; spacing defaults to `sqrt(0.6 / density)`.
- `slopeLimit` is in degrees, measured from `terrainHeight` over a 1.2 m span. `exclusion(x, z)` returns true to keep a spot clear.
- `mix` weighs species (`broadleaf`, `birch`, `conifer`, `palm`, `bush`, `grass`, `flowers`); low-frequency noise groups species into stands.
- `variants` (default 3) variants per species are shared by every instance, so the renderer batches each part by geometry identity. Instances differ by yaw, scale and tint.

It returns `{ instances, parts, variants, counts }`; `parts` shows every instance at level 0.

## Level of detail

`selectLevels(instances, eye, { distanceScale, hysteresis, cullDistance })` sets each instance's level from its distance to `eye`.
A level changes only after the distance passes its threshold by `hysteresis` (default 0.12), so instances on a boundary do not flicker.
It returns `{ parts, changed, levelCounts, culled, triangles }`. Part objects are cached per instance and level, so unchanged instances keep their identity.
When `changed` is true, build a new renderer from the new parts. Grass switches at 24 m; set `cullDistance` to drop far instances.

`vegetationParts(variant, matrix, level, name)` places one tree or clump yourself.

## Recipes and MCP

A recipe node with a `vegetation` field grows and scatters these trees, with wind, seasons and imported trees; see "Vegetation" in [Agent scenes](https://crucible.codepawl.com/agent-scene.md). `scatterVegetation` is called with the terrain's own `heightAt`, so the instances match the addon for the same options.
`levelForDistance(distance, variant, { distanceScale, cullDistance })` is the stateless form of `selectLevels`: no hysteresis, so the level is a pure function of the distance.

## Impostors and cross-fade

Both are off by default, so a scene keeps its picture and its hysteresis until it asks.

```js
import { prepareImpostors, selectLevels } from 'crucible/addons/vegetation';

prepareImpostors(forest.variants);                 // bake now, so no frame pays for it
const view = selectLevels(forest.instances, camera.eye, { impostors: { from: 3 }, fade: 0.06, cullDistance: 900 });
```

`pixelError: { pixels, height, fov }` sets the switch distances from an error in screen pixels instead of metres. The default distances (38, 95 and 150 m) hold for 4 pixels on a 1080 pixel high view with a 60 degree vertical field of view; `pixelErrorScale` returns the factor for any other view, and the factor grows with the instance's scale. It works with `fade`, with `impostors` and with the plain selection.

`impostors` (`true` or `{ from, frameSize, level }`) draws every tree from level `from` on (default 3, beyond 150 m) as one card instead of its mesh. `from: 2` starts at 95 m. Bushes and palms take it too; grass and flowers do not. The result gains `impostors` (cards drawn) and `fading` (instances in a cross-fade).

An impostor is baked per tree variant on first use, or by `prepareImpostors(variants)`. `bakeImpostorAtlas` draws the tree from 8 by 8 directions of a hemi-octahedral grid (the upper hemisphere, so a view from below the horizon shows the horizon view) into a colour atlas (sRGB, alpha is the leaf mask) and a normal atlas (linear, the tangent space of that view, green up), each 96 px a frame, on the CPU in plain JavaScript: it runs in Node and the browser alike and the pixels repeat exactly. It bakes level 3 of the tree, the mesh the card replaces, so the card keeps the same silhouette (`level` picks another). Instance tint multiplies the colour like it does on the meshes.

The card is a quad with the `impostor` material tag. The vertex shader (`src/impostor-shader.js`) turns it to the eye, finds the four atlas views around the view direction in the tree's own frame (so yaw is respected) and sways its top by `frame.wind`; the standard fragment shader then lights it with the sun, the sky and the shadow map like any other surface, using the baked normals. The fragment shader draws each pixel from one of those four views, chosen by their bilinear weights against a screen pattern (a stochastic blend: one sample a pixel, with the mip level and normal basis taken from the card's own uv so they stay smooth), so a camera circling a tree moves through the views without steps. In the shadow pass the "eye" is the light, so the card casts the tree's shadow as the sun sees it, cutout by the baked leaf mask. The card counts 2 triangles.

`fade` (a fraction of the switch distance, default 0.06 when `impostors` is on) cross-fades two neighbouring levels over a band of that fraction either side of each threshold: both draw, with a mask material whose `opacityBias` carries the dither coverage (the dither code and the card shader register on import of the addon, so scenes without it do not carry them), and whose coverage in eighths of the way is complementary (a pixel the outgoing level drops is drawn by the incoming one, from the same interleaved-gradient pattern of the screen position). The level and the step come from the distance alone, so a camera position always draws the same picture and a seek repeats. Selection with `fade` or `impostors` keeps no hysteresis, since the band does its job; `changed` is true when any instance moved to another level or step. Shadows draw every level of a fade at full coverage.

Measured (Node, 2026-11-03), 5,223 trees (broadleaf, birch, conifer, bush, 3 variants each) on a 1,550 m square with the eye at its middle at 2 m, so every distance from 0 to 1,100 m occurs:

| Selection | Triangles |
| --- | --- |
| Levels only | 2,684,078 |
| `impostors: { from: 3 }` | 524,870 |
| `impostors: { from: 2 }` | 358,790 |

Baking one variant each of the five species takes 0.6 to 0.7 s in Node on the CPU (about 0.14 s a variant; 0.1 s a variant with mesh leaves), and 1.4 to 2.6 s for nine variants in headless Chrome on SwiftShader. `npm run smoke:vegetation-impostors` draws a forest with every level, with cards and with fades, and writes the pictures to `artifacts/`.

Measured (2026-11-04, headless Chrome on SwiftShader, `scripts/measure-vegetation-forest.mjs`), the same 5,223 trees seen from the forest edge at 960 by 540: 2,552,514 triangles with every tree at its level and 366,062 with cards from level 3 (5,083 cards). The mean FLIP error of the card picture against the full-level picture is 0.0073 (`scripts/flip-pair.py`). That bounds, loosely, the change in a reference score against Cycles; it is not that score, since no Blender forest scene exists yet, so the 0.005 limit of issue #324 is still open. The forest is open ground, not `large-outdoor` terrain.

`tests/vegetation-pop.test.js` dollies a camera past the card boundary of one tree and measures the mean RGB change between frames: the largest step with the fade is 0.083 and a hard switch at the same place is 0.299, so the test fails above 0.1 or above 0.4 of the hard switch (plain camera motion changes a frame by 0.006 on average). Baking the 12 variants of the forest took 1.3 s in headless Chrome on SwiftShader; the baker runs on the CPU, so the GPU does not change it.

The depth of each view is used to resolve hidden surfaces while baking but is not stored, so the card has no parallax: a tree seen from a changing angle blends views but does not shift its branches.

## Measured

On the demo clearing (125 trees and bushes, 1,941 grass clumps and 129 flower patches, camera at the clearing edge), headless Chrome with GPU:
`mesh` leaves with level of detail draw 2.28M triangles in 65 draws (3.78M without level of detail); `cards` draw 1.15M. Building the scene takes about 1 s; a frame takes under 0.2 s.
Meshes and textures are built in plain JavaScript, so tests run in Node.

## Limits

- Cards need the renderer's alpha mask to look right. Without `leafTextures` the leaf textures are 128 px procedural sprigs that look flat from under a few metres; the scanned cards hold up to about 1 m. Palm fronds have no scanned card yet. The conifer card is a cedar spray, so it reads as a flat branch tip rather than separate needles.
- Level changes pop unless `selectLevels` gets `fade`; level 2 crowns are blobs or crossed cards, and baked impostors exist only when asked for (see Impostors and cross-fade).
- Species are fixed presets; there is no wind-bent skeleton or collision with other trees. Seasonal colour exists only in recipes (the `season` field), not in the addon call.
- In recipes, tags `foliage` and `grass` accept a `tag` override on placed assets, so an imported tree sways; its leaf shading and alpha coverage stay those of the renderer.
