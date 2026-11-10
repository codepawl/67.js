# glTF asset bridge

`src/gltf.js` converts glTF 2.0 assets into Renderer67 parts.
It decodes GLB and glTF files with its own parser (`src/gltf-decode.js`), so the addon does not import Three.js.
A box with the addon is 67,467 bytes gzip, against 159,422 when it used `GLTFLoader`.
The core renderer does not import this addon.

```js
import { loadGltf } from '67js/addons/gltf';
import { Renderer67 } from '67js';

const asset = await loadGltf('/models/object.glb');
const renderer = new Renderer67(canvas, asset.parts, {
  ground: false,
  samples: 4,
  memoryBudgetMiB: 256,
});
renderer.render({ eye: [0, 2, 5], target: [0, 1, 0] });
```

## Input

`loadGltf(source, options)` accepts a URL string, a `URL`, a local `File`, or a `Blob`.
`parseGltf(data, options)` accepts an `ArrayBuffer` or a glTF JSON string.
Both functions return a promise for the decoded asset.

URL loading derives the resource directory from the asset URL.
An explicit `baseUrl` overrides that directory.
Relative external resources in a local glTF file require `baseUrl`.
GLB files can contain their buffers and images without external resources.

HTTP, HTTPS, blob URLs, and base64 data URIs are supported.
External requests use bounded streaming fetches.
The optional `signal` aborts those fetches.

| Option | Default | Limit |
| --- | ---: | --- |
| `maxBytes` | 268,435,456 | Total encoded input and fetched external resources. |
| `maxVertices` | 8,000,000 | Declared and decoded geometry vertices. Indices have a separate ceiling of twelve times this value. |
| `maxParts` | 65,536 | Declared nodes and decoded mesh parts. |
| `maxResources` | 256 | Unique resource URIs. |
| `maxTexturePixels` | 16,777,216 | Combined texture image pixels, checked from the file headers before decoding. Over the budget, the largest images are halved together until they fit, with base color and emission maps kept at twice the size of the normal, roughness and occlusion maps, and `asset.scaledTextures` lists each one as `{ name, from, to }` (also summarised in `asset.warnings`). |
| `maxTextureImagePixels` | 67,108,864 | Hard ceiling for one image, checked before decoding. Larger images are rejected, never scaled. |
| `maxJoints` | 4,096 | Combined declared joints and joint palettes for instantiated meshes. |
| `maxInstances` | 65,536 | Instances of one `EXT_mesh_gpu_instancing` node. |

Every numeric limit must be a positive safe integer.
The defaults take one large exported scene, such as a 240 MB GLB with 8 million vertices and 8192 x 8192 textures, and `GLTF_CAPABILITIES.limits` holds them.
A file over its limits fails with one `RangeError` that names each limit it goes over, the measured value and the value that fits, for example `glTF over its limits: vertices 9120000, over maxVertices 8000000; image 6 (6144x3072) pixels 18874368, over maxTextureImagePixels 16777216. Fix: pass { maxVertices: 9120000, maxTextureImagePixels: 18874368 }.`
The file size and the decoded geometry and parts are checked as they are read, so they fail on their own.
The MCP server decodes catalog files with tighter limits: 64 MiB a file, 1,000,000 vertices, 4,096 parts, 1,024 joints, 4,194,304 texture pixels (larger images are scaled down), 256 clips and 64 files, all from `src/agent-asset-limits.js`. The reason is the hand-off: the server reads the whole file, base64-encodes it and sends it to the preview page in one browser call. Measured with a local Chrome, a 64 MiB file crossed that call (a 128 MiB rise in server memory, 2.7 s), 72 MiB took 4.9 s, and 80 MiB and above crashed the page. A file over a limit fails with an error that names the limit and the value it hit. A larger scene loads through `loadGltf` in code, where the defaults above apply and the file never crosses that call; meshopt compression shrinks a file for the catalog. See [mcp.md](mcp.md).
The importer rejects cyclic hierarchies, multiple parents, and hierarchies deeper than 256 levels.
It checks PNG, JPEG and WebP dimensions before browser image decoding.
Decoded accessor data has a separate ceiling of four times `maxBytes`.
These limits bound asset inputs and geometry, rather than the renderer's total GPU allocation.
The renderer retains its separate memory budget.

## Output

The result contains `parts`, `warnings`, `animations`, `applyAnimation`, `dispose`, and `capabilities`.
Each part contains `name`, `geometry`, `matrix`, and `material`.
The column-major matrix contains the complete world transform, including parent transforms.
Repeated primitives share geometry objects.
Static mirrored instances keep their authored winding and world matrices; the renderer batches parts with a negative-determinant matrix apart and draws them with clockwise front faces.

Geometry contains `positions` and `normals` as `Float32Array` values, plus `indices` as a `Uint32Array`.
The importer computes missing normals and normalizes supplied normals.
It rejects non-finite attributes, invalid indices, singular transforms, and unusable normals.
`geometry.uvs` preserves `TEXCOORD_0` as two floats per vertex.
`geometry.colors` preserves opaque `COLOR_0` values as three linear RGB floats per vertex.

Materials preserve linear `color`, `metallic`, `roughness`, and `emissiveColor` factors.
`emission` contains the emissive intensity.
The `gltf` tag uses standard PBR shading without studio finish overrides.
An emissive-strength extension preserves its intensity.
The source [exporter](export-glb.md) preserves opaque colors, UVs and active HDR emission when creating static GLB snapshots.

A base color texture adds this descriptor:

```js
material.map = {
  image,                 // Decoded browser image or ImageBitmap.
  uvChannel: 0,
  wrapS: 10497,          // Native WebGL sampler enum.
  wrapT: 33071,
  minFilter: 9729,
  magFilter: 9729,
  flipY: false,
  colorSpace: 'srgb',
};
```

Texture descriptors share identity when materials reuse the same texture.
Texture rendering requires batches grouped by geometry and texture identity.
The image descriptor requires sRGB sampling with conversion to linear RGB before lighting.
The importer rejects a requested texture that fails to decode, rather than returning an untextured material.

## Loading a large scene without a long freeze

Building a renderer on a big asset blocks the page while the driver links the shader program, uploads textures and packs batches.
Three pieces split that work across frames:

```js
import { Renderer67, shaderFeatureRepresentatives } from '67js';
import '67js/addons/replace-textured-parts';

// 1. Start on a few parts that need the same shader features as the whole scene, and do not wait for the link.
const renderer = new Renderer67(canvas, shaderFeatureRepresentatives(asset.parts), { deferProgramLink: true });
// 2. Upload textures in short slices: renderer.createTexture(descriptor) caches each one, then yield to the page.
// 3. Wait for the program with a poll that leaves the main thread free, then take the whole scene.
await renderer.programsReady();
renderer.replaceParts(asset.parts);
```

`programsReady()` polls `KHR_parallel_shader_compile` and then finishes construction; a renderer made with `deferProgramLink` must not render before it resolves.
Starting on `shaderFeatureRepresentatives` matters: a scene whose first parts lack a feature recompiles the program inside `replaceParts`, which blocks again.

## Animation and ownership

`animations` contains the decoded animation clips, including their names, durations, and tracks. Each track has `name` (`Node.position`, `Node.quaternion`, `Node.scale` or `Node.morphTargetInfluences`), `times`, `values`, `getInterpolation()` and `createInterpolant(result)`, the same fields the Three.js clips had.
`applyAnimation(time, clipIndex = 0)` evaluates node and joint animation at an absolute time in seconds.
Time clamps to the selected clip's duration.
The hook updates the existing part matrices and returns the same `parts` array.
Seeking in a different order produces the same matrices.

```js
const changedParts = asset.applyAnimation(1.25, 0);
renderer.updateParts(changedParts);
renderer.render(camera);
```

Translation, rotation, and scale tracks are supported.
The importer rejects animation poses that become singular or change triangle winding.

The current source supports four-influence [GPU skinning](https://67js.codepawl.com/skinning.md). GPU skinning is available from version `0.4.0`.
The current source also supports relative POSITION/NORMAL morph targets and weight animations. See [morph import](https://67js.codepawl.com/gltf-morph.md).
A morph primitive without an authored base NORMAL loads with normals generated from its triangles; its morph NORMAL deltas are dropped, with a warning. TANGENT targets remain unsupported.

The caller owns the Renderer67 instance.
`asset.dispose()` releases importer textures, image bitmaps, parser resources, and temporary object URLs.
It does not dispose the renderer.
Disposal is idempotent, and subsequent animation calls fail explicitly.

1. Call `renderer.dispose()` before replacing its imported asset.
2. Call `asset.dispose()` after the renderer finishes using the asset's images.

## Supported subset

`GLTF_CAPABILITIES` lists the supported and unsupported features.
The bridge supports triangle meshes, PNG/JPEG base color textures, rigid animations, and metallic-roughness material factors.
It also supports `KHR_mesh_quantization` and `KHR_materials_emissive_strength`.

Quantized positions load exactly as stored, so their precision is set when the file is packed. `gltfpack` merges a scene's meshes and puts the positions of all of them on one grid sized to the whole scene: with the default 14 bits, a 170 m street (the ORCA Bistro) gets a 9.7 cm step, and a scooter's wheels come out square. gltfpack warns about it ("position data has significant error"). Pack a large scene with `-vp 16` (about 1 cm there) or `-vpf` (float positions); both still compress with `-cc`.

Alpha masking, alpha blending and double-sided materials import onto `alphaMode`, `alphaCutoff`, `opacity` and `doubleSided` (see the material maps guide). Vertex alpha is not drawn: an RGBA `COLOR_0` loads with its RGB, and `warnings` names the meshes whose alpha was below one and was dropped.
It supports base-color, normal, metallic-roughness, occlusion and emissive texture channels.
An optional extension that 67js does not read is ignored and named in `warnings`, as the glTF specification allows. An extension listed in `extensionsRequired` that 67js does not read still fails the load with `Unsupported glTF extension`.
`KHR_materials_pbrSpecularGlossiness` (also when listed in `extensionsRequired`) is converted to metallic-roughness: the diffuse color and texture become the base color, metallic is 0, roughness is 1 minus `glossinessFactor`. The specular color and `specularGlossinessTexture` are not read, and `warnings` says so. A texture on a primitive without `TEXCOORD_0` is dropped from that primitive with a warning instead of failing the load.
A triangle primitive that cannot be drawn is skipped with one warning that names its mesh, its index and the reason, and the rest of the file loads: a missing or short POSITION accessor (fewer than 3 vertices), an index accessor with fewer than 3 indices or a count that is not a multiple of 3, an index outside the POSITION range, or only zero-area triangles. A file with no primitive left, no skin and no animation throws, and the error repeats those warnings.
Repairs keep the file loading and add one warning each: authored vertex normals of zero length are rebuilt from the triangles ("Repaired primitive ..."), and a mesh on a node whose world transform is singular or non-finite (a zero scale, for example) is skipped ("Skipped node ..."). A pose that later makes a node singular still throws.
A file with a skin or animation but no mesh (a skeleton-only clip such as the 100STYLE skeletons) loads with `parts: []`. `nodes` marks the skin's joints with `joint: true` and `animations` holds the clips, so `clipFromGltfAnimation`, `createAssetPose` and `pose.jointWorld` work on it. `skins` is empty because no mesh uses one.
POINTS, LINES, LINE_LOOP and LINE_STRIP primitives are skipped with a warning that names the mesh and their count. Drawing them is not supported. TRIANGLE_STRIP and TRIANGLE_FAN primitives are still refused.

## Extensions

| Extension | Behavior |
| --- | --- |
| `KHR_mesh_quantization`, `KHR_materials_emissive_strength` | Supported. |
| `KHR_texture_transform` | Offset, rotation and scale are baked into `geometry.uvs`. The maps of one material share one baked transform. A normal map may differ by an offset and a positive scale (same rotation), which the shader applies on top of the baked UVs (`normalMapTransform` in `material-layer-shaders`). Any other map that differs is resampled at load into the shared UV space and named in `warnings`: the loader keeps the transform most maps have and tiles the rest, so it must differ by whole-number tilings (a tiled base color beside an untransformed emissive map). A resampled map grows to at most 4 times the pixels of its source and never past `maxTextureImagePixels`. A map that cannot be resampled (a clamped or mirrored sampler, a compressed texture, a non-integer ratio such as scale 2 against scale 3) fails the import with the material named. `texCoord` overrides are rejected. |
| `EXT_mesh_gpu_instancing` | The node expands into one part per instance and primitive. Parts of one primitive share one geometry object, so the renderer batches them. Skinned or morphed instancing is rejected. |
| `KHR_materials_unlit` | The material gets the renderer's `unlit` tag and shows its base color and base color map alone. Emissive, normal, occlusion and metallic-roughness maps and layers are dropped. |
| `KHR_lights_punctual` | Point and spot lights (up to the renderer limits of 16 point and 8 spot lights, in candela like the renderer) and the first directional light become `asset.lights`, a partial `environment`: `pointLights`, `spotLights`, and `keyColor` (color times lux), `lightDirection` and `keyIntensity` for the key light. Pass it as `Renderer67`'s `environment` option or a `frame.environment`. A spot's `penumbra` is `(outer - inner) / outer`. A light over the limits, a second directional light and an invalid light are skipped with a warning. The renderer has no calibrated photometric units, so judge the level by eye. |
| `KHR_materials_variants`, `KHR_materials_dispersion`, `KHR_materials_diffuse_roughness`, `EXT_materials_bump`, `EXT_texture_avif` and any other optional extension | Ignored, named in `warnings`. |
| `KHR_draco_mesh_compression` | Needs `options.decoders.draco`. |
| `EXT_meshopt_compression` | Decoded by 67js: attribute, triangle and index modes with the NONE, OCTAHEDRAL, QUATERNION and EXPONENTIAL filters. The decoder is a separate chunk that loads only when `extensionsUsed` or `extensionsRequired` lists the extension. The fallback buffer is never read, so it may be absent, zero-filled or an unreachable `uri`, and it does not count against `maxBytes`. A buffer view that fails to decode throws a named error. `options.decoders.meshopt` still replaces the built-in decoder. |
| `KHR_texture_basisu` | Needs `options.decoders.ktx2`. |
| `EXT_texture_webp` | The WebP source is decoded by the browser like PNG and JPEG. When the texture also has a PNG or JPEG `source` and the browser cannot decode WebP, that source is used instead. |
| `KHR_materials_clearcoat`, `_transmission`, `_ior`, `_specular`, `_sheen`, `_volume`, `_anisotropy`, `_iridescence` | Read as factors and rendered as material layers, see `docs/material-maps.md`. The textures `clearcoatTexture`, `clearcoatRoughnessTexture`, `clearcoatNormalTexture`, `anisotropyTexture`, `sheenColorTexture` and `sheenRoughnessTexture` are read too, into `material.layerMaps` (their GLSL loads with `material-layer-shaders`); a renderer draws at most three different ones, and none beside splat layers. The transmission, iridescence and specular textures are not read: their factors are used. `occlusionTexture`, `emissiveTexture` and `metallicRoughnessTexture` may use TEXCOORD_1 (the mesh's `lightUvs`, which a light bake also uses); base color and normal textures must use TEXCOORD_0, and a texture on TEXCOORD_1 cannot carry `KHR_texture_transform`. Their textures are ignored, and an iridescent film takes the thickness maximum. Export writes them back. |

`KHR_materials_transmission` with a factor above zero sets `material.transmission` to that factor.
It is a hint only: the renderer does not draw transmission yet.

Without the matching decoder, a file that uses Draco or KTX2 fails with `Unsupported glTF extension` and the option name. Meshopt needs no option.

### Decoders

The Draco and KTX2 decoders are the Three.js loaders, and they stay yours: only an application that passes one imports Three.js. 67js does not bundle or fetch their wasm files, so you choose where they are served.
A Draco loader needs `decodeDracoFile(buffer, onLoad, attributeIds, attributeTypes, colorSpace, onError)`, and a KTX2 loader needs `load(url, onLoad, onProgress, onError)`.

```js
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { loadGltf, ktx2WorkerConfigFor } from '67js/addons/gltf';

const draco = new DRACOLoader().setDecoderPath('/vendor/draco/');   // copy three/examples/jsm/libs/draco/
const ktx2 = new KTX2Loader().setTranscoderPath('/vendor/basis/');  // copy three/examples/jsm/libs/basis/
// Transcode to a GPU-compressed format the renderer's context takes, or to RGBA8 where it takes none.
ktx2.workerConfig = ktx2WorkerConfigFor(renderer.context);

const asset = await loadGltf('/models/car.glb', { decoders: { draco, ktx2 } });
```

Any subset works. Draco and KTX2 decode in browser workers. Dispose the loaders yourself when done (`draco.dispose()`, `ktx2.dispose()`).

### KTX2 texture formats

`ktx2WorkerConfigFor(context)` (exported next to `loadGltf`) reads the extensions of a WebGL2 context and returns the `workerConfig` for the loader. The loader then picks one format per file.
The renderer uploads these GPU-compressed formats as they are, with `texStorage2D` and `compressedTexSubImage2D` for each mip:

| Format | Needs | Bytes a texel |
| --- | --- | --- |
| BC7 | `EXT_texture_compression_bptc` | 1 |
| BC1 or BC3 | `WEBGL_compressed_texture_s3tc` and `WEBGL_compressed_texture_s3tc_srgb` | 0.5 or 1 |
| ASTC 4x4 | `WEBGL_compressed_texture_astc` | 1 |
| ETC2 | `WEBGL_compressed_texture_etc` | 0.5 or 1 |

A context with none of these, such as SwiftShader, gets RGBA8 (4 bytes a texel). Set `workerConfig` before the first load. A loader that you leave without a config throws.
Color maps upload as sRGB and data maps as linear. A file with a partial mip chain keeps only its first level. A compressed texture cannot be exported to GLB or read by the path tracer, so transcode to RGBA8 for those.
`asset.textureFormats` lists `{ format, width, height, colorSpace, bytes }` for each texture, with `format` set to `bc7`, `bc1-rgb`, `bc1-rgba`, `bc3`, `astc-4x4`, `etc2-rgb`, `etc2-rgba` or `rgba8`.
KTX2 dimensions count toward `maxTexturePixels` before decoding. KTX2 images are never scaled. When the loader's `workerConfig` allows a compressed format, a KTX2 image counts a quarter of its pixels, because it takes at most one byte a texel on the GPU. A KTX2-heavy file over the budget still fails.

three's KTX2Loader picks the format from the context. For this file it chose ASTC 4x4 where ASTC is available and BC7 where it is not, and the renderer falls back to RGBA8 when the context offers none of the formats above. On the RTX 3060 (Direct3D 11 through ANGLE) the Khronos `AnisotropyBarnLamp` KTX2 variant loads as `bc7`. On Chrome's SwiftShader it loads as `astc-4x4`, because SwiftShader advertises ASTC, ETC2, S3TC and BPTC and decodes them on the CPU. Only a context with none of these extensions gets `rgba8`; the table above is the list.

#### Measured 2026-11-04 (issue #304, `bench/ktx2/measure.mjs`)

`AnisotropyBarnLamp` from [glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) (CC BY 4.0, Analytical Graphics, Inc. and Wayfair, LLC), four 2048 x 2048 maps (base color, anisotropy, normal, occlusion-roughness-metal), PNG against `glTF-KTX-BasisU`, median of three loads:

| | PNG, `rgba8` | KTX2, `bc7` |
| --- | --- | --- |
| Texture bytes the engine accounts for (computed from block size and mip count, not read from the driver) | 89,478,480 (85.3 MiB, with mips) | 16,777,216 (16.0 MiB, one level) |
| Load time on the RTX 3060 | 0.12 s | 0.27 s |
| Load time on SwiftShader | 0.15 s | 0.21 s |

The Khronos KTX2 files hold no mip chain, so the 5.3x saving mixes the format (4 bytes to 1 a texel) with the missing mips; with a full chain BC7 would take 21.3 MiB, 4.2x less. WebGL does not report driver memory, so these are not driver readings. KTX2 loads slower because of the Basis transcode. Drawn through the reference suite's Khronos framing and scored against the stored Cycles array, the PNG variant gets FLIP 0.0386 over the whole frame and 0.3341 over the pixels the lamp covers; the KTX2 variant gets 0.0385 and 0.3330, a difference of 0.0001 and 0.0011.

### Instancing limits

`maxInstances` (default 65,536) caps the instances of one node, and `maxParts` still caps the total number of parts.
Both are checked from the accessor counts before any data is decoded.
The bridge does not import cameras or scene environments into Renderer67. The caller supplies its own camera and base lighting.
Lights from `KHR_lights_punctual` come back in `asset.lights` and are applied only when the caller passes them on (see the extension table).

## Verification

`node --test tests/gltf.test.js` covers generated GLB triangles and the existing `exportGlb` roundtrip.
The tests cover parent transforms, missing normals, UVs, shared geometry, PBR factors, mirrored winding, and animation seeks.
The tests also cover input limits, unsupported features, compressed image dimensions, and oversized fetch cancellation.

`node --test tests/gltf-extensions.test.js` covers texture transform baking, instancing, ignored material extensions and the decoder options.
The meshopt tests decode real encoded buffers (all modes and filters, a fixture encoded in the test) without any option.
The Draco and KTX2 tests use stand-in loaders, because no encoder is installed: they prove the wiring, not the wasm decoders.

`tests/fixtures/textured-triangle.gltf` contains an original triangle and a generated two-pixel-square PNG.
Chrome loading preserved its UVs, linear material factors, sampler values, and decoded image dimensions.
Renderer integration owns the final textured rendering check.
