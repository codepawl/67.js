# Ground clutter

`crucible/addons/clutter` scatters pebbles, rocks, twigs and fallen leaves over terrain.
It is in the current source and not yet published.

```js
import { createClutter } from 'crucible/addons/clutter';

const clutter = createClutter({
  preset: 'forest',
  area: { minX: -40, maxX: 40, minZ: -70, maxZ: 30 },
  terrainHeight: terrain.heightAt,
  eye,
  seed: 5,
});

const renderer = new CrucibleRenderer(canvas, [...terrain.parts, ...grass.parts, ...clutter.parts], { world: true, ground: false });

// When the camera moves:
if (clutter.update(eye)) renderer.replaceParts([...terrain.parts, ...grass.parts, ...clutter.parts]);
```

## How it is made

- A stone is a sphere displaced by smooth noise. Rocks are also cut by four random planes, which gives them flat, chipped faces. Pebbles stay round.
- A stone sinks a third to a half of its height into the ground and tilts with the terrain.
- Vertex colours give each stone its own tone and hue, from blue-grey to rust. Blotches follow the stone's own space. The underside is darker and soil clings near the ground line.
- Rocks carry the renderer's [moss layer](/material-maps.md): rough, sheened cushions on their tops, shaded as moss rather than painted on. Pebbles stay bare.
- Twigs are tapered tubes that lie on the ground and follow it. Leaves are small cupped strips in a palette of dry browns.
- Items gather into patches of about 7 m (`clumping`), so the ground does not read as an even sprinkle.
- Everything is vertex-coloured and untextured. Each tile has at most three parts, rocks, pebbles and litter, and all stream through `renderer.replaceParts`.

Clutter shows best on paths, clearings, riverbanks and forest floor. Under a dense meadow most of it hides in the grass. To fill a path, pass the inverse of the grass mask as the clutter `mask`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `area` | required | `{ minX, maxX, minZ, maxZ }` in metres. |
| `preset` | `'meadow'` | `meadow`, `forest`, `riverbed` or `scree`. Every other option overrides the preset. |
| `terrainHeight` | `() => 0` | Ground height at `(x, z)`. Pass `terrain.heightAt`. |
| `mask` | none | Coverage at `(x, z)` from 0 to 1. |
| `pebbles`, `rocks`, `twigs`, `leaves` | from preset | Items per square metre. |
| `pebbleSize`, `rockSize` | `[0.012, 0.05]`, `[0.08, 0.38]` | Radius range in metres. Most stones fall near the small end. |
| `moss` | from preset | Moss cover on rocks, 0 to 1. It sets the rock material's `moss`. |
| `clumping` | `0.6` | How strongly items gather into patches, 0 to 1. |
| `stoneColor`, `mossColor`, `soilColor`, `twigColor` | earth tones | Linear RGB. |
| `leafColors` | four dry browns | A list of linear RGB colours. Each leaf picks one. |
| `castShadow` | `true` | Stones cast shadows. Twigs and leaves never do. |
| `tileSize`, `levels`, `cullDistance` | `4`, `CLUTTER_LEVELS`, last level | Tiling and level of detail. |
| `eye`, `seed` | area centre, `1` | Initial camera position and random seed. |

`createClutter` returns `{ parts, update(eye), stats(), materials, settings }`.

## Level of detail

| Level | Distance | Kept | Stone mesh |
| --- | --- | --- | --- |
| 0 | up to 12 m | everything | rocks 12 × 7, pebbles 6 × 4 |
| 1 | 12 to 30 m | 20 % | rocks 6 × 4, pebbles an octahedron |
| 2 | 30 to 70 m | rocks only | rocks 6 × 4 |

Grass and clutter share the tile system in `src/tile-field.js`, with the same 10 % hysteresis.

## Measured

On an 80 × 100 m area, eye 1.3 m above the ground, built in Node:

| Preset | Triangles | Geometry | Build |
| --- | --- | --- | --- |
| `meadow` | 28 k | about 1 MB | about 0.1 s |
| `forest` | 84 k | about 4.5 MB | about 0.3 s |
| `riverbed` | 445 k | about 16.5 MB | about 1 s |
| `scree` | 604 k | about 22 MB | about 1 s |

`riverbed` and `scree` are dense by design. Lower `pebbles` or `cullDistance` for phones.

## Settling stones into a pile

Clutter tiles are meshes, so they stay where they were scattered. To drop stones and let them lie against a wall or each other, use the settle step ([Settling props](physics.md#settling-props)): list the stone poses as `instances`, or let it scatter boxes and balls over an area. It returns resting transforms to draw as static parts.

## Limits

- Stones are untextured. Up close they read as smooth, mottled stones, not as scanned rock.
- Clutter does not collide with grass blades or with each other, so two stones can overlap.
- Leaves lie flat and do not move in the wind.
