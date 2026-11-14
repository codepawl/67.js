# Resources

## Examples

Each demo is a Crucible scene with its source in the repository.

```cards
Object studio | /object.html | Orbit, lighting looks, an exploded view and PNG export. | /previews/wall-e.webp
Procedural modeling | /modeling.html | Lathe, extrude and tube geometry in one lantern. | /previews/modeling.webp
Nature | /nature.html | Terrain, trees, grass, wind and a moving sun. | /previews/grass.webp
Assets | /assets.html | GLB models with their animation. | /previews/assets.webp
Film | /film.html | A short film with a timeline, physics and sound. | /previews/film-contact.webp
Showcase | /showcase.html | An airport, a data center and a port. | /previews/showcase-port.webp
```

## Guides for AI agents

An agent can build scenes through the MCP server, without writing engine code. These files are plain text for agents and for people.

- [MCP server](/mcp.md): install, client setup, the tools and their limits.
- [Scene recipes](/agent-scene.md): the JSON format that the tools accept.
- [Look](/agent-look.md), [motion](/agent-motion.md), [character motion](/agent-character-motion.md) and [assets](/agent-asset.md): the parts of a recipe.
- [Render jobs](/agent-render-jobs.md) and [visual review](/agent-review.md): images, sequences, video and review grids.
- [The plain-text guide](/guide.md): all of this documentation in one Markdown file.

## Contracts

A contract is the exact rule set of one module: inputs, limits, memory and errors. The topic pages link to the matching contract.

- Modeling: [procedural modeling](/modeling.md), [mesh editing](/mesh.md), [primitives](/primitives.md), [sculpt](/sculpt.md), [surface patches](/surface.md), [shrinkwrap](/shrinkwrap.md), [mesh queries](/mesh-query.md), [scene graph](/scene-graph.md).
- Look: [lighting](/lighting.md), [volume fog](/volumetric.md), [path tracer](/path-tracer.md), [light bake](/light-bake.md), [Gaussian splats](/gaussian-splats.md).
- Worlds: [terrain](/terrain.md), [vegetation](/vegetation.md), [grass](/grass.md), [clutter](/clutter.md), [vehicles](/vehicle.md), [Spume liquid](/spume.md).
- Motion: [animation curves](/animation-curves.md), [mixer](/animation-mixer.md), [skinning](/skinning.md), [morph targets](/morph-targets.md), [retargeting](/retarget.md), [skeleton pose](/skeleton-pose.md), [camera paths](/camera-path.md), [physics](/physics.md), [film physics](/film-physics.md).
- Files: [glTF import](/gltf.md), [glTF morphs](/gltf-morph.md), [GLB export](/export-glb.md).

## Project

- [Changelog](/changelog.html): every release and the unreleased changes. Agents can read [changelog.json](/changelog.json).
- [npm package](https://www.npmjs.com/package/@codepawlhq/crucible): `@codepawlhq/crucible`.
- [Source on GitHub](https://github.com/codepawl/crucible): issues, pull requests and the contributing guide.
- [Release metadata](/release.json): the published version, the browser module URL and the archive checksum.
