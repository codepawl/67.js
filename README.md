<p align="center">
  <a href="https://67js.codepawl.com"><img src="https://67js.codepawl.com/previews/banner.jpg" alt="67js: 3D engine that AI agents drive, over a Bistro street rendered by it" width="100%"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@codepawlhq/67js"><img alt="npm version" src="https://img.shields.io/npm/v/@codepawlhq/67js?style=flat-square&label=npm&color=7CC765&labelColor=0A1D1A"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-E9F5F0?style=flat-square&labelColor=0A1D1A"></a>
  <img alt="Node.js 20.19 or later" src="https://img.shields.io/badge/node-%E2%89%A520.19-4DB6FF?style=flat-square&labelColor=0A1D1A">
  <img alt="MCP server for agents" src="https://img.shields.io/badge/agents-MCP%20server-F7C948?style=flat-square&labelColor=0A1D1A">
</p>

67js is a WebGL2 renderer with addons for terrain, vegetation, characters, liquid, vehicles and media export.
A scene is plain data: each part has a geometry, a matrix and a material.
An agent builds and changes a scene through an MCP server, looks at PNG previews and renders stills or MP4 video.
The goal is to be as capable as Blender and as light as three.js. [docs/goal.md](https://github.com/codepawl/67.js/blob/main/docs/goal.md) defines each part.
See the [showcase](https://67js.codepawl.com/showcase.html), the [documentation](https://67js.codepawl.com/docs.html), the [guide for agents](https://67js.codepawl.com/llms.txt) and the [changelog](https://github.com/codepawl/67.js/blob/main/CHANGELOG.md).

## Showcase

Each picture below is a 67js render. The linked ones open live in the browser.

<table>
  <tr>
    <td width="33%" valign="top"><b><a href="https://67js.codepawl.com/showcase.html?scene=airport">Airport ramp</a></b></td>
    <td width="33%" valign="top"><b><a href="https://67js.codepawl.com/showcase.html?scene=datacenter">AI data center</a></b></td>
    <td width="33%" valign="top"><b><a href="https://67js.codepawl.com/showcase.html?scene=port">Container port</a></b></td>
  </tr>
  <tr>
    <td><a href="https://67js.codepawl.com/showcase.html?scene=airport"><img src="https://67js.codepawl.com/previews/showcase-airport.webp" alt="An airport ramp with an airliner at its stand and the turnaround crew"></a></td>
    <td><a href="https://67js.codepawl.com/showcase.html?scene=datacenter"><img src="https://67js.codepawl.com/previews/showcase-datacenter.webp" alt="A cutaway AI data center hall"></a></td>
    <td><a href="https://67js.codepawl.com/showcase.html?scene=port"><img src="https://67js.codepawl.com/previews/showcase-port.webp" alt="A container port with cranes and stacked containers"></a></td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%" valign="top"><b>Bistro cafe corner</b></td>
    <td width="50%" valign="top"><b>Bistro plaza</b></td>
  </tr>
  <tr>
    <td><img src="https://67js.codepawl.com/previews/bistro-cafe.webp" alt="A green corner restaurant with red awnings and a blue scooter in the Bistro scene"></td>
    <td><img src="https://67js.codepawl.com/previews/bistro-plaza.webp" alt="A large plane tree in a hedged circle on a Bistro plaza"></td>
  </tr>
</table>

## Install

**Let your agent do it.** Paste this prompt into Claude Code, Codex, Cursor, Gemini CLI or OpenCode. The agent installs
the package, reads the guide and connects the MCP server.

```text
Install 67js from npm as `67js@npm:@codepawlhq/67js` and connect its MCP server with `npx 67js-mcp`. Read
https://67js.codepawl.com/llms.txt first and follow it.
```

**By hand**

```sh
npm install 67js@npm:@codepawlhq/67js
```

The registry name is `@codepawlhq/67js`. The command installs it under the alias `67js`, so imports stay short.
The package is ESM. The tools need Node.js 20.19 or later, and rendering needs a WebGL2 browser.

## Quick start

```js
import { Renderer67, box, sphere } from '67js';

// Column-major 4x4 matrix: scale, then move.
const placed = ([x, y, z], [width, height, depth] = [1, 1, 1]) =>
  new Float32Array([width, 0, 0, 0, 0, height, 0, 0, 0, 0, depth, 0, x, y, z, 1]);

const parts = [
  {
    name: 'Floor',
    geometry: box(),
    matrix: placed([0, 0, 0], [8, 0.1, 8]),
    material: { color: [0.4, 0.42, 0.45], metallic: 0, roughness: 0.9, emission: 0 },
  },
  {
    name: 'Ball',
    geometry: sphere(48, 24),
    matrix: placed([0, 1, 0]),
    material: { color: [0.8, 0.3, 0.2], metallic: 0, roughness: 0.35, emission: 0 },
  },
];

const canvas = document.querySelector('canvas');
const renderer = new Renderer67(canvas, parts, { samples: 4, memoryBudgetMiB: 256 });
renderer.render({ eye: [4, 3, 6], target: [0, 1, 0] });
```

Call `renderer.updateParts(parts)` to move or recolour parts without a new upload.
Call `renderer.resize()` after the canvas changes size, and `renderer.dispose()` before you replace the renderer.
The [guide](docs/guide.md) covers cameras, lights, effects and every material field.
To save a PNG from a script, use the [render-from-a-script recipe](docs/guide.md#render-a-png-from-a-script-without-mcp).

## For agents

The package includes an MCP server that connects an agent to a persistent browser renderer.
The server needs a local Chrome installation.

```sh
npx 67js-mcp --backend gpu --memory 192
```

Use `--backend cpu` on a machine without a GPU.
An agent authors a [JSON recipe](docs/agent-scene.md), sets [lights and fog](docs/agent-look.md), imports [GLB assets](docs/agent-asset.md) and adds [motion](docs/agent-motion.md).
It gets PNG previews back, compares up to four views in a [review grid](docs/agent-review.md) and runs [render jobs](docs/agent-render-jobs.md) for stills and MP4 video.
The server accepts no arbitrary code and no remote asset URLs. The [MCP reference](docs/mcp.md) lists its tools.

Two skills teach an agent to drive the MCP tools: [build-67js-scene](skills/build-67js-scene/SKILL.md) for scenes and materials, and [render-67js-media](skills/render-67js-media/SKILL.md) for image and video export.
For a plain-text guide, give the agent [llms.txt](https://67js.codepawl.com/llms.txt).

[viz3d](https://github.com/codepawl/viz3d) uses 67js. It is a skill that turns places, systems and events into 3D apps and films, and it renders its films and stills in 67js.
To add it in Claude Code, run `/plugin marketplace add codepawl/viz3d`, then `/plugin install visualize-in-3d@codepawl`.

## Addons

Each addon is a separate import, so a page loads only what it uses.

| Area | Import | Guide |
| --- | --- | --- |
| Lighting | `67js/addons/hdri` | [Image-based lighting](docs/lighting.md) from `.hdr` files |
| Terrain | `67js/addons/terrain`, `67js/addons/texture-set` | [Chunked terrain](https://67js.codepawl.com/terrain.md) with scanned ground layers |
| Vegetation | `67js/addons/vegetation`, `67js/addons/grass`, `67js/addons/clutter` | [Trees](https://67js.codepawl.com/vegetation.md), [grass](https://67js.codepawl.com/grass.md) and [ground clutter](https://67js.codepawl.com/clutter.md) with wind and level of detail |
| Characters | `67js/addons/gltf`, `67js/addons/retarget`, `67js/addons/skeleton-pose` | [glTF import](docs/gltf.md), [clip retargeting](https://67js.codepawl.com/retarget.md) and [pose layers with IK](docs/skeleton-pose.md) |
| Liquid | `67js/addons/spume` | [Baked liquid playback](https://67js.codepawl.com/spume.md) with refraction and spray |
| Vehicles | `67js/addons/vehicle` | [Wheeled vehicles on a path](https://67js.codepawl.com/vehicle.md) |
| Physics | `67js/addons/physics` | [Rapier contacts and joints](docs/physics.md) recorded into a timeline |
| Modeling | `67js/addons/mesh`, `67js/addons/modeling`, `67js/addons/sculpt` | [Mesh editing](docs/mesh.md), [modeling](docs/modeling.md) and [sculpt brushes](https://67js.codepawl.com/sculpt.md) |
| Offline light | `67js/addons/path-tracer`, `67js/addons/light-bake` | [Path-traced stills](https://67js.codepawl.com/path-tracer.md) and [baked lightmaps](https://67js.codepawl.com/light-bake.md) |
| Post passes | `67js/addons/user-pass` | [Your own full-screen GLSL passes](docs/user-passes.md): dither, pixel downscale, quantise |
| Agents | `67js/addons/agent-scene`, `67js/addons/agent-asset` | [Scene sessions](docs/agent-scene.md) with revisions and checkpoints |

The [documentation page](https://67js.codepawl.com/docs.html) lists every guide.

## Render images and video

The render command exports a scene to PNG or MP4 through headless Chrome, on the GPU or on the CPU.

```sh
npm run render -- --kind image --scene nature --backend gpu --preset high --output artifacts/nature.png
```

Video export streams one frame at a time, so a film never sits in memory.
The [render skill](skills/render-67js-media/SKILL.md) lists every preset and flag.

## Run the site locally

1. Install Node.js 22.12 or later.
2. Run `npm ci`.
3. Run `npm run dev`. Vite prints the local URL.

## Performance claims

[verification.md](docs/verification.md) has the measured results and their limits.
They compare matching scenes on the same hardware. They do not show a general speed advantage over three.js or visual parity with Blender.

## Contributing

Read [CONTRIBUTING.md](https://github.com/codepawl/67.js/blob/main/CONTRIBUTING.md) before you open a pull request. It covers setup, checks, code style and the release flow.

## Credits

- [gl-matrix](https://github.com/toji/gl-matrix) supplies the matrix math.
- The glTF addon has its own parser. The Draco, meshopt and KTX2 decoders are [three.js](https://threejs.org/) loaders that you pass in.
- The textures and the HDRI on the site are CC0 scans from [Poly Haven](https://polyhaven.com) and [ambientCG](https://ambientcg.com). See [the texture credits](https://github.com/codepawl/67.js/blob/main/public/textures/CREDITS.md).
- The Bistro renders use [Amazon Lumberyard Bistro](https://developer.nvidia.com/orca/amazon-lumberyard-bistro) (CC BY 4.0, from the NVIDIA ORCA library) under a CC0 [Poly Haven](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) sky.
- The showcase models and their sources are listed in each world's `scene.json` under `public/showcase/`.
- The banner wordmark uses [Sora](https://fonts.google.com/specimen/Sora) (SIL Open Font License).

## License

[MIT](LICENSE) © CodePawl
