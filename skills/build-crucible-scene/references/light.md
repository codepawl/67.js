# Light: sun, lamps, caps, bounce, flush faces

<!-- skill-navigation:start -->
This is the [Light: sun, lamps, caps, bounce, flush faces](#light-sun-lamps-caps-bounce-flush-faces) reference. Read [Caps](#caps) and [Units](#units) before adding lamps.
Then read the task's section: [A lamp, a spot and a panel](#a-lamp-a-spot-and-a-panel), [Move the sun](#move-the-sun),
[Bounce light in a closed room](#bounce-light-in-a-closed-room) or [Flush faces flicker (z-fighting)](#flush-faces-flicker-z-fighting).
<!-- skill-navigation:end -->

Calls follow the conventions in `look.md`. `tests/skill-examples.test.js` applies every block, so they stay valid.

## Caps

| Light | Where | Cap |
|---|---|---|
| Sun (one key light) | `environment.lightDirection`, `keyColor`, `keyIntensity` | 1 |
| Point | `environment.pointLights` | 16 |
| Spot | `environment.spotLights` | 8 |
| Area | `environment.areaLights` | 7 |

A list over its cap fails the whole batch with a message that names the cap. Each list replaces the previous one,
so send every light you want to keep (`[]` removes all). Baked bounce light uses up to 6 of the 16 point slots when a
sun lights a closed room (`environment.sunBounce`, `0` turns it off).
The sun casts shadows. Point and spot lights cast them only with `castShadow: true` (default false) and area lights
never do. Without it a light shines through walls, so a lamp outside a room still lights it: set `castShadow`, move
it inside, lower `intensity` or give it a `range`.

## Units

`pointLights[].intensity` is candela-like: light at distance `d` is `intensity / d^2`, so a lamp 3 m away needs about
10 times the value of one 1 m away. Spot and area use the same scale (`intensity` 0 to 100000); `color` is linear RGB
0 to 1, so keep color for hue and put brightness in `intensity`. The sun is `keyColor * keyIntensity`.

## A lamp, a spot and a panel

Tool `scene_apply`:

```json
{ "expectedRevision": 1, "operations": [
  { "type": "set-environment", "environment": {
    "setup": "overcast", "keyIntensity": 0.3,
    "pointLights": [ { "position": [0, 2.2, 0], "color": [1, 0.75, 0.5], "intensity": 14, "range": 8, "castShadow": true } ],
    "spotLights": [ { "position": [3, 3, 3], "direction": [-1, -1, -1], "angle": 0.6, "penumbra": 0.3, "intensity": 60, "castShadow": true } ],
    "areaLights": [ { "position": [0, 3, -2], "direction": [0, -1, 0], "width": 2, "height": 1, "intensity": 8 } ]
  } }
] }
```

`direction` points where the light travels. Check the cap and result with `scene_inspect` (`diagnostics`).

## Move the sun

`lightDirection` points from the ground to the sun, so `[-1, 4, 1]` is high noon-ish and `[-4, 0.3, 1]` is near the
horizon. The shadow follows the direction; widen `shadow.extent` when the shadow clips at the edge.

```json
{ "expectedRevision": 2, "operations": [
  { "type": "set-environment", "environment": { "lightDirection": [-4, 0.5, 1], "keyColor": [3.4, 1.6, 0.8], "keyIntensity": 1 } },
  { "type": "set-shadow", "shadow": { "extent": 8, "distance": 12, "far": 30 } }
] }
```

Animating any of these lights, the sun, sky or effects is in `film-and-animation.md`.

## Bounce light in a closed room

A closed room or any scene lit by point lights is dark where light does not reach, and `scene_inspect` reports the
`closed-room-without-bake` diagnostic. Add a bake. `preset` is `draft` (fast try) or `standard`.

```json
{ "expectedRevision": 3, "operations": [
  { "type": "set-bake", "bake": { "preset": "standard" } }
] }
```

`irradianceGrid` (true, or 8 to 48 nodes) replaces lightmaps with a baked grid of bounced diffuse light for every part.
`gridFog: true` adds the scene's volume fog to that grid, which fixes dark shafts and fog that looks too bright in a
sunlit closed room. It needs `irradianceGrid`; without it the call fails with "bake.gridFog needs bake.irradianceGrid".

```json
{ "expectedRevision": 4, "operations": [
  { "type": "set-bake", "bake": { "preset": "standard", "irradianceGrid": true, "gridFog": true } }
] }
```

The bake runs when the scene builds and again only when parts, lights, materials or the bake change.
A motion track that moves a light, the sun or a part leaves the baked light behind: `scene_inspect` then reports
`bake-stale`. Keep lit lights and parts still, or set `bake.rebake` true: each pose motion samples is baked (the last 4 are kept), about 0.7 s each on a small room, so use it for a few poses.
`scene_inspect` shows `bake.seconds`, `bake.skipped` (alpha, skins, morphs, hair and cloth are left as they were) and
`bake.used`. Without rebake it bakes the rest pose, so a light moved by a motion track does not move its baked light. `"bake": null`
(`set-bake`) removes it.

## Flush faces flicker (z-fighting)

The fix is automatic. Depth precision needs no setting, and faces that lie flush or a few millimetres apart, inside
one mesh or across parts, are ranked per triangle at draw time so the face in front always wins; geometry never moves.
`scene_inspect` returns `flush.ranked`, the number of parts that got ranks. Do not offset, nudge or thicken faces by hand,
and do not add `decal` to fix a flicker: near-flush faces (glass a centimetre off a wall, nested facades) are ranked or cut
from the drawn copy for you, and the parts stay as you made them. Whatever the pass could not settle comes back as
`coplanar-overlap` diagnostics, the largest first, each with a `reason` and a `fix`. No diagnostic means nothing is left.
You only act on those:

- `reason: "rank-overflow"` means more than 15 faces are stacked a small gap apart, wider than the gap that is cut away,
  so the deepest may flicker far away: remove the duplicate faces (usually a layer exported twice). The other reasons
  (`double-sided-gap`, `unchecked`, `collapsed-node`) carry their own `fix`.
- To choose which of two flush nodes wins, set `decal: true` on the one on top (a sticker on a surface) or `depthLayer`
  (1 to 4) to stack several.
- `environment.resolveCoplanar: false` opts out; `scene_inspect` then lists each flush pair as `coplanar-overlap`.

```json
{ "expectedRevision": 5, "operations": [
  { "type": "set-environment", "environment": { "resolveCoplanar": false } }
] }
```

Meshes that meet: a rock sunk into ground gets `blend: { "radius": 0.15 }` on its node for a soft seam.
