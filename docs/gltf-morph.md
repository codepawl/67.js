# glTF morph import and animation

`parseGltf` imports relative `POSITION` and `NORMAL` morph targets into existing renderer parts.
The bridge uses the installed Three.js `GLTFLoader` and `AnimationMixer` for decoding and interpolation.
Each imported part exposes a retained `part.morph.weights` Float32 array.
Available from version `0.4.0`.
The source renderer applies the imported targets on the GPU before skeletal deformation.

```js
import { parseGltf } from '../src/gltf.js';

const asset = await parseGltf(glbBytes, { maxBytes: 32 * 1024 * 1024 });
const morphParts = asset.parts.filter(part => part.morph);
const weights = morphParts[0].morph.weights;
asset.applyAnimation(1, 0);
asset.applyAnimation(0.25, 0); // Sampling order does not change the resulting pose.
console.assert(weights === morphParts[0].morph.weights);
asset.dispose();
```

## Imported data

Morph primitives contain between one and 64 targets, with matching target counts across their mesh.
Each target accepts `POSITION`, `NORMAL`, or both.
Channels require unnormalized float `VEC3` accessors matching the base vertex count.
Position deltas require finite ordered `min` and `max` bounds.
A target channel also requires its corresponding base attribute.
Unsupported semantics, including `TANGENT`, fail explicitly before resource decoding.

A morph primitive without authored base normals loads with generated base normals; its morph NORMAL deltas are dropped and a warning is reported.
Per-target flat normal generation remains unsupported.

The converted geometry stores relative Float32 deltas in `geometry.morphTargets`.
Missing target channels remain absent and contribute zero.
The converter follows the declared channels because the maintained loader fills some missing channels with base attributes.
Copying those loader placeholders as relative deltas changes the deformation incorrectly.

Defaults follow `node.weights`, then `mesh.weights`, then zeros.
Default arrays require one finite Float32 value per target.
Signed weights and values above one remain valid when numerical bounds permit them.
Independent mesh instances share converted geometry but receive independent morph poses.
Their weight buffers retain their identity during animation.

The bridge captures original primitive declarations before the loader reduces scene associations.
It resolves declared scene roots and their dependencies, without eagerly decoding unrelated nodes.
Scene clones retain the correct channel declarations even when an asset contains several scenes or primitives.

## Weight channels

Animation outputs for `weights` use scalar streams grouped by target count.
The bridge supports `LINEAR`, `STEP`, and `CUBICSPLINE` through the maintained loader.
Cubic streams contain incoming tangents, values and outgoing tangents for each keyframe.
The loader evaluates those tangents with the interval duration.

Document preflight validates every animation channel, including clips that the caller never selects.
Checks cover node references, duplicate targets, sampler references, interpolation, accessor shapes and output counts.
Decoded keyframe times must be finite, nonnegative and strictly increasing.
Decoded outputs must remain finite, and rotation values must represent unit quaternions within quantization tolerance.
Normalized signed or unsigned byte and short weights also decode through the loader.

`applyAnimation(time, clipIndex)` retains its existing absolute-time interface.
Finite times clamp to the selected clip's duration.
Switching clips restores properties that the new clip does not animate through the mixer's action lifecycle.
Channels without a target node remain ignored, as the glTF specification permits.

## Atomic publication

The mixer samples private decoded nodes first.
The bridge then validates all node world transforms after Float32 conversion.
Mesh transforms must preserve their winding, while every node transform must remain finite and nonsingular.
Skin palettes, morph weights and matrices each use retained pending buffers.
Morph bounds also include the pending world transform and pending skin palette.

No public matrix, palette or morph weight changes until every pending value passes validation.
An unsafe sample throws and retains the last successful public pose.
A later valid seek can still reproduce its previous successful result.
Replacing public matrix, skin palette or morph pose buffer identities fails before publication.

Target deltas and base geometry remain static after upload.
The retained metadata validates identities without scanning every vertex during each sample.
In-place changes to static target contents require new geometry and a new import.
The returned Three.js animation clips also remain authored data after import.

## Resource limits

Preflight includes one base vertex plus one vertex per target in `maxVertices` accounting.
It reserves two Float32 RGB channels per target vertex in the existing decoded byte budget.
Generated base normals for non-morph geometry also reserve their decoder and converted Float32 storage.
Per-instance decoded influences and pending and published weight buffers also contribute to that reservation.
Decoded accessors plus these reservations must fit the existing four-times-`maxBytes` limit.
Declared primitive instances also count against `maxParts` before the loader runs.

These checks bound declared expansion before mesh decoding, including repeated references to one target accessor.
The limits do not measure JavaScript object overhead or GPU allocation.
The renderer still needs its own memory plan for packed morph textures and instance batches.

## Design and checks

Two implementation shapes were considered.

| Shape | Interpolation | Geometry and state |
| --- | --- | --- |
| Custom decoder and weight curves | New linear, step and Hermite sampling code | Own accessor decoding and animation state. |
| Maintained loader with staged bridge | Installed glTF interpolation and mixer | Convert declared deltas and publish retained pending poses. |

The selected bridge reuses the maintained interpolation instead of creating another curve implementation.
Its pending publication extends the existing skin pipeline to cover transforms and morphs together.
The converter preserves relative deltas and independent instance weights.

Embedded GLB and glTF tests cover missing channels, defaults, independent instances, signed weights and all three interpolation modes.
Additional checks cover 64 targets, malformed channels, pre-decode budgets, skin composition, world overflow and failed-sample recovery.
Scene regressions cover both selected scenes, shared root clones, distinct primitive channels and disposal without decoding orphan meshes.
These tests inspect imported data and animation behavior.

`node scripts/smoke-gltf-morph.mjs` runs the built decoder, film addon and renderer in native headless Chrome.
The fixture exports the film portrait as a static GLB, appends explicit weight-animation channels, and imports it again.
It compares open and closed eyelid pixels at an unchanged head pose, checks exact backward-seek reproduction and retains GPU resources across 60 updates.
Wide and portrait runs report WebGL errors and the renderer memory estimate.
The fixture verifies imported deformation, not character likeness or cinematic quality.

The source [exporter](export-glb.md) now preserves vertex colors, UVs and independent HDR emission.
The fixture does not preserve procedural shaders or scene environments, so it is not a complete asset round trip.

`node scripts/smoke-gltf-skin-morph.mjs` imports a GLB containing both bone and weight channels through the built package entry points.
It isolates morph pixels at a fixed skin pose, verifies exact reverse seeks, retains all three deformation textures and checks disposal.
The 640 by 480 fixture reports a renderer allocation estimate of 33,367,220 bytes with four MSAA samples and no WebGL errors.
This estimate excludes browser and driver overhead.

The data semantics follow the [Khronos glTF 2.0 morph target and animation specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html).
