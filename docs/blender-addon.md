# Cook in Blender (#900)

`packages/blender-addon` is a Blender add-on that adds **Cook**, the 67js native path tracer ([`packages/render-native`](../packages/render-native/README.md), kernel `cycles`), to the Render Engine list next to Cycles and Eevee. It exports the evaluated scene, runs the tracer as a Node subprocess and puts the result in Blender's render result. This is the first slice of #900: final-frame renders of what the exporter reads. No viewport render, no node graph baking and no extension packaging yet.

The add-on is not part of the npm package (`files` is unchanged) and runs no downloaded code; it reads your scene and starts `node` on the tracer in a 67js checkout.

## Install

1. Build the tracer once (Rust and a Vulkan GPU with ray queries, see the [render-native README](../packages/render-native/README.md)):

   ```sh
   (cd packages/render-native && node build.mjs)
   ```

2. In Blender (4.2 or later, written and checked on 5.3): Edit > Preferences > Add-ons > Install from Disk, and pick `packages/blender-addon/cook_blender/__init__.py`, or copy the `cook_blender` folder into your add-ons folder. Enable "Cook renderer (67js)".
3. In the add-on's preferences set **Native tracer folder** to the root of the 67js checkout. When it is empty the `COOK_NATIVE_DIR` environment variable is used. Node 20.19 or later must be on `PATH`, or set **Node executable**.
4. Render properties > Render Engine > **Cook**. Samples, max bounces, seed and pixel filter are in the Sampling panel. F12 renders a frame.

A missing folder, an unbuilt addon or a missing Node stops the render with a message that names what to set.

## What is read

| Blender | Cook |
| --- | --- |
| Mesh, curve, surface, text and metaball objects, evaluated with their render modifiers | triangle meshes with split normals and the active UV map; one geometry per mesh datablock and material slot |
| Objects that share mesh data, and collection instances | instances of one geometry, not copies of the triangles |
| Point, sun, spot and area lights (colour, power, radius or angle, spot size and blend, area shape and size, spread) | the same units as the Cycles parity bridge ([`classroom_bridge.py`](../bench/cycles-parity/classroom_bridge.py) shares this code) |
| World: a constant colour (with Strength), or an Environment Texture on Background colour | a constant world, or an HDRI written as a Radiance file and turned to Cook's orientation |
| The active camera: perspective, sensor fit, roll, depth of field (f-stop, focus distance or object, blades, rotation) | pinhole or thin lens |
| Principled BSDF: Base Color, Metallic, Roughness, Emission Color and Strength, Alpha, IOR, Specular IOR Level, Transmission Weight, Coat Weight and Roughness | constant values; Base Color, Emission Color, Metallic, Roughness and Alpha also as an Image Texture linked directly to the socket, and Normal from a tangent-space Normal Map node fed by an image |
| Diffuse and Emission shaders as the only surface | a diffuse or an emissive material |
| Hide in Renders, ray visibility (camera, diffuse, glossy, transmission, shadow) | the same flags |
| Render passes: Combined, and Depth (Z) when "Z" is enabled on the view layer | Combined and a Z pass converted from the tracer's ray distance |

Metallic and Roughness images are combined into one map (roughness in green, metallic in blue); if they differ in size the Metallic one is left out. An Alpha that comes from an image is cut out at 0.5, not blended.

## What is not read, and what happens

Everything below is reported **once per material** in the render log (a `COOK material '<name>': ...` line on stdout and a warning in Blender's status bar), with the fallback used. Nothing is dropped silently.

- A node other than an Image Texture on a supported socket (procedural textures, Mix, Color Ramp, Math, a Mapping node): the socket's constant value.
- A surface shader other than Principled, Diffuse or Emission (Glass, Mix Shader, Add Shader, Toon, group nodes): the material's viewport colour as a rough diffuse material.
- Volume and Displacement outputs, Sheen, Subsurface, Anisotropic, Thin Film and a non-white Specular Tint: left out.
- Image Texture node projections other than Flat, Closest interpolation, extension modes other than Repeat, and a Vector input: read as a flat, linearly filtered, repeating lookup with the first UV map.
- More than one sun (the first is used), light nodes, light linking, shadow-catcher and holdout objects, hair and curves objects, point clouds, volumes and Grease Pencil, orthographic and panoramic cameras (an error that says to use Perspective), camera lens shift, the render border and motion blur.
- Geometry whose evaluated shape differs per instance of one object (some Geometry Nodes setups) is exported once per object datablock: check the result. `[untested]`

## Settings and environment

| Name | Meaning |
| --- | --- |
| `COOK_NATIVE_DIR` | 67js checkout root, used when the preference is empty |
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

`run-checks.sh` renders two fixture scenes (`tests/scene_fixtures.py`) with Cycles (OptiX) and with Cook at the same samples (256), 8 bounces, box filter of width 1, no denoiser and no clamping, and compares them with the repository's [`compare.py`](../bench/cycles-parity/compare.py) gates: the mean ratio of each channel within 2 percent and every 8x8 tile within 5 percent. It writes `artifacts/900/cook-blender-addon-900.jpg`.

The Classroom demo scene goes through the same scene reading with `bash bench/cycles-parity/run-classroom-parity.sh` (see the Classroom section of [cycles-parity.md](./cycles-parity.md)).

## Results

RESULTS_PLACEHOLDER
