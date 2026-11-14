# Cook in Blender (#900)

`packages/blender-addon` is a Blender add-on that adds **Cook**, the Crucible native path tracer ([Cook](https://github.com/codepawl/cook/blob/main/README.md), kernel `cycles`), to the Render Engine list next to Cycles and Eevee. It exports the evaluated scene, runs the tracer as a Node subprocess and puts the result in Blender's render result. This is the first slice of #900: final-frame renders of what the exporter reads. No viewport render, no node graph baking and no extension packaging yet.

The add-on is not part of the npm package (`files` is unchanged) and runs no downloaded code; it reads your scene and starts `node` on the tracer in a Crucible checkout.

## Install

1. Install Cook (`npm install github:codepawl/cook`) and build the tracer once (Rust and a Vulkan GPU with ray queries, see the [Cook README](https://github.com/codepawl/cook/blob/main/README.md)):

   ```sh
   npm run cook:build
   ```

2. In Blender (4.2 or later, written and checked on 5.3): zip the add-on folder so the zip holds `cook_blender/` at its root (`cd packages/blender-addon && zip -r cook_blender.zip cook_blender`, or compress the folder in your file manager), then Edit > Preferences > Add-ons > Install from Disk and pick the zip. Or copy the whole `cook_blender` folder into Blender's add-ons folder. Installing the single `__init__.py` does not work: the add-on has several modules. Enable "Cook renderer (Crucible)".
3. In the add-on's preferences set **Native tracer folder** to the root of the Crucible checkout. When it is empty the `COOK_NATIVE_DIR` environment variable is used. Node 20.19 or later must be on `PATH`, or set **Node executable**.
4. Render properties > Render Engine > **Cook**. Samples, max bounces, seed, pixel filter and environment cap are in the Sampling panel. F12 renders a frame. The environment cap is 0 (the world image is not clamped, as in Cycles); a positive value limits each texel of the world image to that radiance, which lowers noise from small very bright spots and takes their energy away.

A missing folder, an unbuilt addon or a missing Node stops the render with a message that names what to set.

## What is read

| Blender | Cook |
| --- | --- |
| Mesh, curve, surface, text and metaball objects, evaluated with their render modifiers | triangle meshes with split normals and the active UV map; one geometry per mesh datablock and material slot |
| Objects that share mesh data, and collection instances | instances of one geometry, not copies of the triangles |
| Point, sun, spot and area lights (colour, power, radius or angle, spot size and blend, area shape and size, spread) | the same units as the Cycles parity bridge ([`classroom_bridge.py`](../bench/cycles-parity/classroom_bridge.py) shares this code) |
| World: a constant colour (with Strength), or an Environment Texture on Background colour | a constant world, or an HDRI written as a Radiance file and turned to Cook's orientation |
| The active camera: perspective, sensor fit (Auto fits the 36 mm sensor width to the longer side of the frame, so a portrait frame has a vertical sensor of 36 mm, as in Cycles), roll, depth of field (f-stop, focus distance or object, blades, rotation) | pinhole or thin lens |
| Principled BSDF: Base Color, Metallic, Roughness, Emission Color and Strength, Alpha, IOR, Specular IOR Level, Transmission Weight, Coat Weight and Roughness | constant values; Base Color, Emission Color, Metallic, Roughness and Alpha also as an Image Texture linked directly to the socket, and Normal from a tangent-space Normal Map node fed by an image |
| Diffuse and Emission shaders as the only surface | a diffuse or an emissive material |
| Hide in Renders, ray visibility (camera, diffuse, glossy, transmission, shadow) | the same flags |
| Render passes: Combined, and Depth (Z) when "Z" is enabled on the view layer | Combined and a Z pass converted from the tracer's ray distance (see the edge limit below) |

Metallic and Roughness images are combined into one map (roughness in green, metallic in blue); if they differ in size the Metallic one is left out. An Alpha that comes from an image is cut out at 0.5, not blended.

## What is not read, and what happens

Everything below is reported **once per material** in the render log (a `COOK material '<name>': ...` line on stdout and a warning in Blender's status bar), with the fallback used. Nothing is dropped silently.

- A node other than an Image Texture on a supported socket (procedural textures, Mix, Color Ramp, Math, a Mapping node): the socket's constant value.
- A surface shader other than Principled, Diffuse or Emission (Glass, Mix Shader, Add Shader, Toon, group nodes): the material's viewport colour as a rough diffuse material.
- Volume and Displacement outputs, Sheen, Subsurface, Anisotropic, Thin Film and a non-white Specular Tint: left out.
- Image Texture node projections other than Flat, Closest interpolation, extension modes other than Repeat, and a Vector input: read as a flat, linearly filtered, repeating lookup with the first UV map.
- More than one sun (the first is used), light nodes, light linking, blackbody temperature, light shadow and diffuse/specular factors, shadow-catcher and holdout objects, Film > Transparent, a pixel aspect other than 1:1, hair and curves objects, point clouds, volumes and Grease Pencil, orthographic and panoramic cameras (an error that says to use Perspective), camera lens shift, the render border and motion blur.
- The Z pass is not coverage-corrected: the tracer averages the first-hit distance over all samples of a pixel and counts a missed ray as 0, and it returns no hit count or alpha to divide by. A silhouette pixel that is half background therefore gets about half the distance (Cycles writes the distance of the surface), which shows as a dark halo along edges in a depth of field or fog composite. Interior pixels and pixels whose samples all hit are right. The render log carries a note whenever Z is enabled. To fix it the tracer would need to return a per-pixel count of samples that hit a surface (or the summed film weight of hits), next to the depth sum.
- Geometry whose evaluated shape differs per instance of one object (some Geometry Nodes setups) is exported once per object datablock: check the result. `[untested]`

## Textures and the render folder

Each distinct image is written as raw 8-bit RGBA into the render's private temporary folder (`texture-0.rgba`, `texture-1.rgba`, ...), and the world image as `world.hdr` in the same folder. `scene.json` names them with `assetFile`, a bare file name. `trace-native.mjs` reads such a file only from the folder that holds the scene file (`resolveAssetFile` in [`scene-bridge.mjs`](../bench/cycles-parity/scene-bridge.mjs) refuses a path, an absolute path, a parent reference and a name with a NUL byte, for images and for the world image alike). Pixels are never embedded as base64 text, so a scene with many large textures no longer runs into the string limit of Node (about 512 MB) and the Python side does not hold the encoded copy in memory.

The tracer keeps every texture in memory, so the total is limited to 1 GiB (16 distinct 4096 x 4096 RGBA images). Over that the render stops with a message that gives the count and the total in MB and says to lower the texture size or use fewer distinct images `[the limit is a guard, not a measured ceiling of the tracer]`.

## Settings and environment

| Name | Meaning |
| --- | --- |
| `COOK_NATIVE_DIR` | Crucible checkout root, used when the preference is empty |
| `COOK_ADDON_PATH` | A built `render-native.node` to use instead of the one under the checkout's `node_modules/@codepawlhq/cook/build` |
| `COOK_KEEP_FILES=1` | keep the temporary folder (`scene.json`, `trace.log`, the `.npy` output) after a render |

## Checks

All of them need the machine described below, except the first. From the repository root:

```sh
# Python pieces that need no Blender (numpy only)
uv run --no-project --with numpy python -m unittest discover -s packages/blender-addon/tests -p "test_blender_conversions.py"

# Exporter test inside headless Blender (cannot run in the Node CI)
blender -b --factory-startup --python-exit-code 1 --python packages/blender-addon/tests/test_exporter_in_blender.py

# Everything, on a machine with Blender 5.3, a Vulkan GPU with ray queries, node and uv: build, tests, and Cook against Cycles
bash packages/blender-addon/tests/run-checks.sh 256
```

`run-checks.sh` renders the fixture scenes (`tests/scene_fixtures.py`, including `portrait`: `small` at 270 x 480 with sensor fit Auto, which fails the tile gate at once when the field of view is wrong) with Cycles (OptiX) and with Cook at the same samples (256), 8 bounces, box filter of width 1, no denoiser and no clamping, and compares them with the repository's [`compare.py`](../bench/cycles-parity/compare.py) gates: the mean ratio of each channel within 2 percent and every 8x8 tile within 5 percent. It writes `artifacts/900/cook-blender-addon-900.jpg`.

`bash packages/blender-addon/tests/run-classroom-check.sh` renders the Classroom demo through the add-on engine, then runs `bench/cycles-parity/run-classroom-parity.sh`, which reads the scene with the same code (see the Classroom section of [cycles-parity.md](./cycles-parity.md)).

## Results

Measured on one machine (RTX 4090, Blender 5.3.0, Cycles OptiX, Cook through this add-on), 480 x 270, 256 samples, 8 bounces, box filter of width 1, no denoiser, seed 1, per-channel mean ratio Cook over Cycles and the 8x8 tile ratios of `compare.py`. The gates are 0.98 to 1.02 for the channel means and 0.95 to 1.05 for every tile.

| Scene | Channel mean ratio (R, G, B) | Tile ratio range | Gates |
| --- | --- | --- | --- |
| `small`: floor with an image on Base Color, three objects sharing one mesh, an emissive cube, a sun, a point light, a constant world | 1.0003, 1.0002, 1.0002 | 0.9991 to 1.0025 | pass |
| `hdri`: the same objects lit by an environment image with a broad warm lobe | 0.9975, 0.9973, 0.9968 | 0.9961 to 0.9998 | pass |
| `portrait`: `small` at 270 x 480, sensor fit Auto (36 mm on the height) | 1.0003, 1.0004, 1.0004 | 0.9994 to 1.0019 | pass |
| `maps`: `small` with images on Roughness, Normal and Alpha | 1.0127, 1.0062, 1.0060 | 0.9754 to 1.0929 | means pass, tiles fail (59 of 64 within 5 percent) |
| `hdri-patch`: `hdri` with the lobe replaced by a patch of 8 x 6 pixels at 30 to 20 times the sky, no environment cap | 0.9981, 0.9978, 0.9983 | 0.9957 to 1.0002 | pass |
| `hdri-patch` with the environment cap at 16 (the packer's default) | 0.9042, 0.9170, 0.9674 | 0.7906 to 0.9976 | fail |

The picture `docs/cook-blender-addon-900.jpg` shows `small` and `hdri`, Cycles on the left and Cook on the right.

What the numbers show:

- Environment cap: at the time the native packer limited every environment texel to 16 unless told otherwise (since #1172 it has no default limit, and `hdriRadianceLimit` sets one), and the `radianceLimit` in the scene file is read only by the bench bridge. The patch (30, 26, 20) is above 16, so its energy was lost: that was the whole `hdri-patch` gap. The add-on now passes `--hdri-radiance-limit none` to `trace-native.mjs` (a new flag; absent keeps the packer's default) unless the **Environment Cap** setting is above 0. With no cap the scene passes; with the cap at 16 it reproduces the earlier failure `[measured, same scene, same box]`.
- Maps, one at a time (each against Cycles): roughness image alone passes (means 1.0002, tiles 0.9993 to 1.0022); alpha image alone passes (means 0.9994 to 1.0007, tiles 0.9744 to 1.0047); the normal map alone carried the failing tiles (60 of 64 within 5 percent, worst tile 1.1697, relMSE 0.0906).
- Normal map convention: with the green channel inverted before Cook reads it, the normal-map scene's relMSE falls from 0.0906 to 0.0021 and 59 of 64 tiles are within 5 percent (worst tile 1.0927). The add-on now inverts green: Blender's bitangent follows V upward and Cook's V runs downward, so the unflipped image bumps the wrong way. Five tiles on the balls are still outside 5 percent (up to 9 percent); the remaining gap is not explained `[open]`. The tangent handedness of the kernel itself was not read; the measurement above is the evidence.

The Cook render call includes starting Node, packing and the device set-up; it took 0.6 to 1.0 s here (Cycles' render call took 0.4 to 0.6 s). `maps` took 15.5 s on its first run and 1.0 s on the rerun, so the first run paid a one-time cost `[cause not found]`. These are single runs, not a speed comparison.

Classroom (the Blender demo scene, CC0), 960 x 540:

- Through the add-on engine with the scene's real materials, 128 samples: it exports (914 parts over 241 geometries, 431,109 unique triangles, 79 materials) and renders. The render log carries a note for 60 materials, mostly a surface that is a Mix Shader, Glossy, Glass or node group (replaced by the viewport colour as a diffuse material), or a Mix, Curve or Hue node on Base Color (replaced by the constant). It does **not** match Cycles: channel mean ratio 0.40, 0.41, 0.38 and 1 of 64 tiles within 5 percent. That is expected with so many approximated materials; the likely main cause is that the window glass and the daylight portal become opaque diffuse surfaces, because the add-on has no glass or portal fallback yet (the Classroom bridge hides glass instead) `[inferred, not isolated]`.
- Through the Classroom parity driver, grey diffuse everywhere, which reads the scene with the same code as the add-on: at 1024 samples the Cook against Cycles image gates (channel means, 64 of 64 tiles within 5 percent, FLIP) pass in the depth of field and pinhole comparisons, and depth agreement at 1 percent on 99.939 percent of pixels (316 pixels off, all on edges), which passes the 99.9 percent gate. At 256 samples the same driver gives 99.849 percent (783 pixels off, none in the interior) and fails the gate, with the bridge as it was on `main` and with this branch alike (783 pixels in both, run from empty outputs on the same box). The depth number depends on the sample count of the Cook render, because the tracer averages the first-hit distance of a silhouette pixel over its samples, misses counted as 0 (see the Z pass limit above), and fewer samples leave more edge pixels outside the 1 percent tolerance. The scene file the bridge exports is the same before and after moving the code in the camera, environment, world, materials and images; the branch exports more separate geometries than `main` (the geometry indices of the parts differ from the 118th part on; the cause is probably that Geometry Nodes inputs are now part of the sharing key `[inferred]`), and the two depth buffers agree to the pixel count above `[measured by comparing the two exports and the two runs]`.
- The driver reuses the outputs of an earlier run for a stage whose files exist. A run at 1024 samples followed by one at 256 therefore compared the 256 request with the 1024 renders, and a change of bridge code was not picked up either. The driver now writes `artifacts/classroom/run-stamp.json` (sample count, `--keep-glass`, a digest of the bridge and add-on code) and runs export, cook, cycles and reference again when it differs.

