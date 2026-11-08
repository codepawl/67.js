# Agent lighting and look

This feature is included in npm release `0.5.0` and later.

Agent scene recipes can contain `environment`, `effects`, and `shadow` objects.
These fields belong to canonical recipes and checkpoint snapshots.
Look commands use the same atomic revision checks as node and material commands.
Failed look validation preserves the previous recipe and revision.

The optional helper `normalizeAgentLook({ environment, effects, shadow })` returns detached, fully normalized JSON.
It fills omitted fields without mutating the input.
`resolveAgentShadow(shadow, lightDirection)` returns detached renderer bounds with `eye`, `target`, `up`, `extent`, `near`, and `far`.
The helpers do not create geometry, render targets, or GPU resources.

```js
import { normalizeAgentLook, resolveAgentShadow } from '67js/addons/agent-scene';

const look = normalizeAgentLook({
  environment: {
    world: true,
    lightDirection: [-0.6, 1, 0.2],
    keyIntensity: 0.8,
    pointLights: [{ position: [0, 2, 1], color: [1, 0.6, 0.3], intensity: 12 }],
    volumeFog: { density: 0.02, minimum: [-4, 0, -4], maximum: [4, 4, 4] },
  },
  effects: { exposure: 1.2, bloom: { strength: 0.25 } },
  shadow: { target: [0, 1, 0], extent: 5, distance: 10, far: 24 },
});

const shadowBounds = resolveAgentShadow(look.shadow, look.environment.lightDirection);
```

The renderer uses `effects.exposure` as `frame.exposure`.
The remaining effect controls belong to `frame.effects`.
The environment's `world` flag selects the renderer's world presentation.
Look normalization always supplies the authored key color, including in world mode.

The MCP adapter applies the canonical look on every draw. A custom browser adapter must pass it explicitly:

```js
const renderer = new Renderer67(canvas, scene.parts, {
  ground: false, hdr: true, depth: true,
  world: scene.environment.world,
  environment: scene.environment,
  shadowBounds: resolveAgentShadow(scene.shadow, scene.environment.lightDirection),
});

function draw() {
  renderer.world = scene.environment.world;
  renderer.shadowBounds = resolveAgentShadow(scene.shadow, scene.environment.lightDirection);
  renderer.shadowsDirty = true;
  renderer.resize();
  renderer.updateParts(scene.parts);
  renderer.render({
    ...scene.camera, environment: scene.environment, effects: scene.effects,
    exposure: scene.effects.exposure, time: 0,
  });
}
```

For a frame loop, update shadow bounds and mark shadows dirty only when projector controls or geometry change.
Use `replaceParts` when `topologyRevision` changes, as described in the scene guide.

## Catalog HDRIs and looks

A recipe names a file; it never carries a path or a URL, and nothing is downloaded. Two kinds of entries exist:

| Entry | Field | Source |
| --- | --- | --- |
| `sky-clouds` | `environment.hdri` | Poly Haven `kloofendal_48d_partly_cloudy_puresky`, CC0, shrunk to 128 x 64 |
| `studio-softbox` | `environment.hdri` | Poly Haven `studio_small_03`, CC0, shrunk to 128 x 64 |
| `teal-orange`, `noir` | `environment.look` | made for 67js, CC0, 9 points per side |
| 64-character ID | either | a `.hdr` or `.cube` file (4 MiB at most) in the MCP `--assets` directory, listed by `scene_asset_catalog` as kind `environment` or `look` |

The four shipped files total about 100 KB. For a bigger HDRI, put a 1k or 2k `.hdr` (for example from Poly Haven) in the assets directory and use its ID. Outside MCP, decode with `parseRadianceHdr` or `parseCube` and register with `registerCatalogEnvironment(name, data)` or `registerCatalogLook(name, look)` from `src/look-catalog.js` before building the scene. The look needs the `view-transform-shader` module (`loadAgentSceneModules` loads it). Render jobs light the scene with the same entries.

## Atomic look commands

| Operation | Payload |
| --- | --- |
| `set-environment` | `{ environment: partialEnvironment }` |
| `set-effects` | `{ effects: partialEffects }` |
| `set-shadow` | `{ shadow: partialShadow }` |

Each operation also contains its `type` discriminator.
Omitted fields retain their current canonical values.
Nested `volumeFog` and `bloom` objects merge their supplied fields.
Vector arrays replace their previous vector.
The complete `pointLights` list replaces the previous list, including `[]` to remove all point lights.
Final merged look fields pass normalization before any command publishes.

```js
const checkpoint = scene.checkpoint();
scene.apply([
  { type: 'set-environment', environment: { keyIntensity: 0.4, volumeFog: { density: 0.03 } } },
  { type: 'set-effects', effects: { exposure: 1.4, bloom: { threshold: 1.5 } } },
  { type: 'set-shadow', shadow: { extent: 7 } },
], { expectedRevision: scene.revision });

scene.apply([
  { type: 'set-environment', environment: { pointLights: [] } },
], { expectedRevision: scene.revision });

scene.restore(checkpoint, { expectedRevision: scene.revision });
scene.releaseCheckpoint(checkpoint);
```

The helper normalizes a complete candidate rather than merging patches itself.
Session and transport adapters own patch merging and renderer updates.
Checkpoint restore recovers canonical lighting, effects, and shadow controls with the rest of the scene.

## Environment

All numeric values must be finite and representable as Float32.
RGB arrays contain exactly three numbers.
Key light, point light, and fog colors use linear RGB.
Sky colors use display RGB, matching the renderer's existing environment contract.

| Field | Default | Range or meaning |
| --- | --- | --- |
| `world` | `false` | Boolean world presentation flag. With `true` the setup environment is also the background |
| `hdri` | absent | A shipped HDRI (`sky-clouds`, `studio-softbox`) or the 64-character ID of a `.hdr` file in `scene_asset_catalog`. It lights, reflects and (with `world: true`) forms the background instead of the setup sky; `environmentIntensity` is its strength and `environmentRotation` turns it about the vertical axis. The setup still gives the key light, so set `keyIntensity: 0` when the HDRI has its own sun. `null` clears. See [Catalog HDRIs and looks](#catalog-hdris-and-looks) |
| `ground` | on | Absent unless set. `false` removes the preview's automatic floor and contact shadow |
| `resolveCoplanar` | off | `'offset'` puts the smaller part of each coplanar pair (see the `coplanar-overlap` warning) on the next depth layer, drawn with a polygon offset; `false` or absent leaves parts as authored. Geometry never moves. Parts that set `decal` or `depthLayer` keep their own |
| `objectReflections` | on | Absent unless set. Each smooth metal part (`metallic` 0.5 or more, `roughness` 0.6 or less; at most 8 such parts) gets a reflection probe of the scene around it, so a chrome sphere shows the floor and its neighbours. `false` turns it off. Probes are traced at rest, so a part that moves reflects the scene as it started. `scene_inspect` names them in `reflections` |
| `floorSkyTrace` | on | Absent unless set. A closed room a sun lights gets the sky each floor texel sees traced into its floor (`applyFloorSkyVisibility`, strength 0.2), so shadowed floors under a roof or between walls get less world and sky light; it makes the dark end of halls closer to Cycles. Open scenes and rooms lit by lamps alone are left as they are. `false` turns it off; a value that is not a boolean is refused. It loads lazily with a recipe that names its sun (`keyColor` or `keyIntensity`), costs about 1 s of trace when the scene is built and adds triangles to the floor (0.1 to 0.4 ms per frame in the reference halls). |
| `specularAntiAliasing` | `1` | Absent unless set. `0` to `4`. Widens highlights where the shading normal or normal map detail changes within a pixel (geometric specular anti-aliasing plus a Toksvig term read from the filtered normal map length), so grainy or scanned metal stops sparkling from frame to frame at grazing angles. `0` gives a highlight that follows every texel; above `1` is softer. |
| `sunBounce` | `1` | Absent unless set. A number of 0 or more. A closed room a sun lights gets a few point lights at its sunlit patches (`withSunBounce`, found when the scene is prepared), so the floor, walls and pillars around a patch are lit by the light it bounces and the far end of the room less. `0` turns it off and gives the look without it; `1` is fitted to Cycles; above `1` is stronger. A value that is not a number of 0 or more is refused. Open scenes and rooms with no sun are left as they are. It loads lazily with the sun, and the lights take up to 6 of the 16 point light slots. |
| `setup` | `daylight` | `daylight`, `overcast`, `sunset` or `studio`. See Lighting setups |
| `environmentIntensity` | `1` | `0` to `100`. Scales the setup's environment light and reflections |
| `environmentRotation` | `0` | `-100` to `100` radians around the vertical axis |
| `lightDirection` | the setup's | Components within ±1000000, length at least `0.000001` |
| `keyColor` | the setup's | Components from `0` to `1000` |
| `keyIntensity` | `1` | `0` to `100` |
| `fillIntensity` | `0` | `0` to `100` |
| `ambientIntensity` | `1` | `0` to `100`. Scales the environment light |
| `daylight` | `1` | `0` to `100` |
| `pointLights` | `[]` | At most 16 point light records |
| `skyTop` | `[0.2, 0.38, 0.52]` | Components from `0` to `1` |
| `skyBottom` | `[0.62, 0.7, 0.67]` | Components from `0` to `1` |
| `fogColor` | `[0.35, 0.43, 0.43]` | Components from `0` to `1` |
| `fogDensity` | `null` | `0` to `10`. `null` fits the density to the scene: `0.006`, or `1.2` divided by the scene diagonal in metres when that is smaller, so a 900 m scene keeps 30 percent of its contrast at the far side. Set `0` for no fog |
| `volumeFog` | Complete defaults below | One bounded world volume |

Directional key radiance equals `keyColor * keyIntensity`.
Zero intensity disables that lighting contribution.
Direction magnitude remains in the canonical recipe.
The shadow projector uses its normalized direction, so changing only magnitude does not change shadow placement.
High radiance can clip at the renderer's half-float HDR target limit of `65504` before bloom and tone mapping.

## Light units and three.js conversion

Every intensity is a linear scene value, not a photometric unit with its own scale.
For a white diffuse surface facing a light, the outgoing radiance is `intensity * color / PI`, the same as three.js r155 and later (`useLegacyLights` removed, physical units).
So a three.js light copies over with the factor below, and a scene lit by one light matches without tuning.
Compare at the same `exposure` (three.js `toneMappingExposure`), and note that 67js tone maps with an ACES-style curve only when `hdr` is off.

| 67js field | Unit | three.js light | Value to use |
| --- | --- | --- | --- |
| `keyColor * keyIntensity` | Irradiance on a surface facing the light, lux-like | `DirectionalLight.color * intensity` | Same value. Put the intensity in `keyIntensity` and keep `keyColor` in `0` to `1` |
| `pointLights[].intensity` | Candela-like: irradiance at distance `d` is `intensity / d^2` | `PointLight.intensity` | Same value. `range` is `distance` (the same smooth cutoff). Set `radius: 0.1` to match three.js's clamp of `d^2` at `0.01` |
| `spotLights[].intensity` | Candela-like, as a point light, scaled by the cone | `SpotLight.intensity` | Same value. `angle` is the same half angle in radians. `penumbra` fades in cosine here and in angle in three.js; both agree at `0` and `1` |
| `areaLights[].intensity` | Candela-like: on axis, far from the light, irradiance is `intensity / d^2`, and `intensity / (d^2 + width * height / PI)` in general | `RectAreaLight.intensity` (nits) | `nits * width * height` |
| `fillIntensity`, `ambientIntensity`, `environmentIntensity` | Unitless multipliers on the fill rig, the sky ambient and the setup's environment map | `AmbientLight`, `HemisphereLight`, `scene.environmentIntensity` | No exact equivalent. |

A three.js scene built before r155 with the legacy light model multiplies each of those intensities by `PI` to get the 67js value.
`tests/light-units.test.js` ports a directional, point, spot and area light this way and checks the irradiance each produces against the three.js formula within 2 percent.

## Lighting setups

A recipe with no lighting settings uses `daylight` (and no occlusion): a small procedural sky map (128 by 64, generated in code, no files or URLs) lights every surface and shows in metal and glossy reflections, with a warm key light for shadows.
The four setups are `daylight`, `overcast` (even grey light, weak key), `sunset` (low warm sun, dark blue zenith) and `studio` (neutral room with three soft boxes).
Setting `setup` through `set-environment` resets `lightDirection`, `keyColor`, `keyIntensity`, `fillIntensity`, `ambientIntensity`, `skyTop` and `skyBottom` to that setup; fields in the same call still win, and fields set earlier are replaced.
Remote URLs and HDRI files are not accepted from tool input.
This changes the look of every recipe that sets no lighting: before, the default had no environment map, a key color of `[5.2, 4.7, 4.1]` and a fill intensity of `1`.
To get the earlier flat look, set `keyColor`, `fillIntensity` and `environmentIntensity: 0` yourself.
The MCP preview adds an automatic floor: a light grey disc under the scene's lowest geometry, at that height, which catches the key light's shadow. It is not a recipe node and is not exported. A part that already forms a floor (spans at least 90 percent of the scene's width and depth, is thinner than a quarter of its width and is the lowest geometry) switches it off, and `environment.ground: false` removes it. Code that builds its own `Renderer67` gets it by passing `createAgentGround(agentGroundPlacement(parts, environment))` as the `ground` option (`src/agent-ground.js`).

## Point lights

Each point light requires a world-space `position`.
The renderer uses inverse-square attenuation outside its radius.
Radius limits attenuation rather than creating an area emitter or softening shadows.
Point lights currently cast no local shadows and do not scatter through volume fog.

| Field | Default | Range |
| --- | --- | --- |
| `position` | Required | Three components within ±1000000 |
| `color` | `[1, 1, 1]` | Linear RGB components from `0` to `1` |
| `intensity` | `1` | `0` to `100000` |
| `radius` | `0.05` | `0.001` to `1000000` |
| `range` | `0` | `0` for unlimited falloff, otherwise `0.001` to `1000000` |

Range values between zero and `0.001` reject.
The existing directional shadow map remains the source of shadows.
Point lights can illuminate through opaque walls.

## Outlines and toon light

`environment.lines` draws outlines, an optional banded light and screen-width polylines. One edit turns it on:

```json
{ "type": "set-environment", "environment": { "lines": { "width": 2, "toon": 3 } } }
```

`"lines": null` turns it off. A material can also set `toon` (0 to 8) for its own bands. The fields, limits and costs are in [line art](line-art.md). `scene_capabilities` reports `lineArt` and the `toon` layer field.

## Volume fog

Active volume fog requires an opaque renderer with `{ hdr: true, depth: true }` and negotiated HDR support.
The volume uses resolved opaque depth and directional scattering with the directional shadow map.
Density zero disables the volume.
These controls reuse `resolveVolumeFog` and its existing domain rules.

| Field | Default | Range |
| --- | --- | --- |
| `density` | `0` | `0` to `10` |
| `minimum` | `[-100, 0, -100]` | Three components within ±100000 |
| `maximum` | `[100, 20, 100]` | Three components within ±100000, strictly above minimum after Float32 rounding |
| `color` | `[0.8, 0.85, 0.9]` | Linear RGB components from `0` to `1` |
| `ambient` | `[0.03, 0.035, 0.04]` | Linear RGB components from `0` to `10` |
| `drift` | `[0.03, 0, 0]` | Three components within ±100 |
| `steps` | `16` | Integer from `8` to `48` |
| `anisotropy` | `0.3` | `-0.9` to `0.9` |
| `noiseAmount` | `0.5` | `0` to `1` |
| `noiseScale` | `0.3` | `0.001` to `100` |
| `maxDistance` | `100` | `0.01` to `10000` |
| `shadowAmbient` | derived from the scene: 0.15 in a closed room, 1 under open sky | `0` to `1` |
| `scatterOctaves`, `multiScatter`, `multiExtinction`, `multiAnisotropy`, `keyTransmittance`, `surfaceTransmittance` | `1`, `0.5`, `0.5`, `0.5`, `0`, `0` | Integer `1` to `4`, then `0` to `1` each; off by default, see [volume fog](https://67js.codepawl.com/volumetric.md) |
| `detailOctaves`, `detailAmount`, `warp`, `contrast`, `profileSoftness`, `keyScattering` | `1`, `0.5`, `0`, `1`, `0.5`, `1` | Integer `1` to `3`, `0` to `1`, `0` to `4`, `0` to `4`, `0` to `0.95`, `0` to `10`; see [volume fog](https://67js.codepawl.com/volumetric.md) |

Fog bounds reject dimensions that collapse after Float32 rounding.
The current volume supports one directional scattering source.
Local point scattering, transparent depth, multiple scattering, and multiple volumes remain outside this contract.
See [volume fog](https://67js.codepawl.com/volumetric.md) for renderer requirements and frame-time limits.

## Effects

The controls reuse `resolveEffects` with a preview bloom strength of `0.12`.
Exposure remains independent and maps to `frame.exposure`.
Bloom strength zero disables bloom.
Ambient occlusion reads the depth texture, so it needs the HDR depth target that previews use. A renderer built without `depth: true` skips the pass and lists an `ambient-occlusion-without-depth` warning in `renderer.diagnostics` (the preview's render info carries it too). The program compiles and its half-resolution target allocates on first use. On SwiftShader at 960 by 540 it adds about 16 ms to a 190 ms frame (measured, 8 percent). It is off by default: against Cycles on 10 reference scenes it improved no score by more than 0.002 and made most slightly worse, because the largest gaps are cast shadow shape and reflections, not contact darkening. Pixels that direct light already brightens keep less of it, because occlusion belongs to indirect light.

| Field | Default | Range |
| --- | --- | --- |
| `exposure` | `1` | `0.01` to `16` |
| `saturation` | `1` | `0` to `2` |
| `contrast` | `1` | `0.1` to `2` |
| `temperature` | `0` | `-1` to `1` |
| `vignette` | `0` | `0` to `1` |
| `grain` | `0` | `0` to `0.1` |
| `ambientOcclusion` | `0` | `0` to `1`. Screen-space contact darkening, off by default; any value above `0` runs the pass |
| `ambientOcclusionRadius` | `0.5` | `0.01` to `100` world units |
| `bloom.strength` | `0.12` | `0` to `2` |
| `bloom.threshold` | `1` | `0` to `10` |
| `bloom.radius` | `1` | `0.1` to `4` |
| `depthOfField.blur` | `0` | `0` to `1`. Lens blur from depth, off by default; the widest circle is 5 percent of the image height |
| `depthOfField.focusDistance` | `5` | `0.01` to `100000` metres from the camera that stay sharp |
| `motionBlur.shutter` | `0` | `0` to `0.5` seconds of camera motion to smear |
| `motionBlur.objects` | `0` | `0` to `1`. How much of each moving part's own motion to smear over the same shutter; `0` leaves it off |

Depth of field and motion blur are deterministic: they read the frame, its depth and the camera, with fixed sample patterns, so a seek to a time gives the same pixels as playing to it.
Depth of field applies to every render, including `scene_look`.
Motion blur needs camera `motion` tracks and a render job with `settings.motion`: the job samples the camera at `motion.start + elapsed - shutter` as well, and smears each pixel along the screen movement between the two.
With `motionBlur.objects` above zero, a part that moves between `motion.start + elapsed - shutter` and `motion.start + elapsed` also smears along its own screen path while the still background stays sharp (`1` is the full shutter). It reads each pixel's part from an object ID pass, so it costs a second draw of the frame, and it replaces the camera smear on that frame, since it covers the camera's motion too. A part is moved as one rigid body by its node transform: a skinned or morphed part, an imported asset and a translucent part are not smeared per object.
Both effects compile their shader and allocate their targets the first time a frame uses them, and a scene that leaves them at zero pays nothing.

## Directional shadows

Shadow controls define an orthographic projector aligned with the current light direction.
The derived eye equals `target + normalize(lightDirection) * distance`.
The projector uses up vector `[0, 0, 1]` when the absolute normalized Y component exceeds `0.99`.
Other directions use `[0, 1, 0]`.
This avoids a collinear camera up vector for vertical lights.

| Field | Default | Range |
| --- | --- | --- |
| `target` | `[0, 1, 0]` | Three components within ±1000000 |
| `extent` | `3.5` | `0.01` to `100000`, half-width and half-height |
| `distance` | `8` | `0.01` to `1000000` |
| `near` | `0.1` | `0.001` to `1000000` |
| `far` | `15` | `0.001` to `1000000`, above near after Float32 rounding |

The derived eye and target must remain distinguishable at Float32 precision.
View, projection, and combined matrices must remain finite and nonsingular at Float32 precision.
Large targets and short distances can fail these combined checks even when each field fits its individual range.
Derived projectors do not automatically fit scene or fog bounds.

Recipes always derive the eye from `lightDirection`, so shadows follow the light. A custom adapter that passes its own `shadowBounds.eye` to the renderer overrides that: the eye decides where shadows fall, and `lightDirection` only moves the shading. When the two differ by 10 degrees or more, the renderer lists a `shadow-light-direction-mismatch` warning in `renderer.diagnostics`. Leave `eye` out of `shadowBounds` to make the shadow follow the light.

## Validation boundary

Every object rejects unknown keys.
Inputs must contain ordinary plain JSON objects and dense arrays without extra fields or hidden properties.
Accessors, executable values, cyclic references, typed arrays, and nonfinite numbers reject.
The helpers return independent arrays, including volume defaults.
JSON nesting has a maximum depth of 32, and look arrays have at most 16 entries.

| Design | Benefit | Cost |
| --- | --- | --- |
| Forward raw renderer environment and postprocess options | Direct access to every renderer field | Defaults and validation vary across adapters |
| Normalize a bounded JSON look before publication | Canonical defaults, replay, atomic validation, and one derived shadow direction | Explicit field vocabulary |

The helper normalizes bounded JSON while reusing the engine's lighting, effects, and volume validators.
Session and transport code remain responsible for revisions, patches, checkpoint ownership, and rendering.
