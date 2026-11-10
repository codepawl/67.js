# Look: sky, HDRI, color look, fog, effects

Each recipe is one tool call. `expectedRevision` is the revision you last read from the previous result, and `sessionId`
may be left out. Look edits merge: omitted fields keep their value, vectors replace, `pointLights` replaces the whole list.
Field ranges are in `scene_capabilities`. A bad value fails the whole batch and keeps the old revision.
`tests/skill-examples.test.js` applies every block below, so they stay valid.

## Pick a light setup

`environment.setup` is `daylight` (default), `overcast`, `sunset` or `studio`. Setting it resets key, fill, ambient and
sky to that setup, and fields in the same call still win.

Tool `scene_apply`:

```json
{ "expectedRevision": 1, "operations": [
  { "type": "set-environment", "environment": { "setup": "sunset", "world": true } }
] }
```

`world: true` makes the sky the background too.

## HDRI from the catalog

Call `scene_asset_catalog` (no arguments). It lists two shipped HDRIs, `sky-clouds` and `studio-softbox`, two shipped
looks, `teal-orange` and `noir`, and every `.hdr` (kind `environment`) and `.cube` (kind `look`) file in the server's
`--assets` folder as a 64-character ID. A recipe names an entry and never carries a path or URL. For a bigger HDRI,
tell the user to put a 1k or 2k `.hdr` (4 MiB at most) in the assets folder and restart the server for its ID.

Tool `scene_apply`:

```json
{ "expectedRevision": 2, "operations": [
  { "type": "set-environment", "environment": {
    "hdri": "sky-clouds", "world": true, "environmentIntensity": 1, "environmentRotation": 0.8, "keyIntensity": 0
  } }
] }
```

`keyIntensity: 0` drops the setup's sun when the HDRI has its own; keep it above 0 when you want shadows from the
key light. `"hdri": null` clears it.

## Color look and tone mapping

`environment.look` is one of `warm`, `cool`, `contrast`, `faded`, a shipped cube (`teal-orange`, `noir`) or the
64-character ID of a `.cube` file from `scene_asset_catalog`. `environment.viewTransform` is `aces` (default), `agx` or
`neutral`.

Tool `scene_apply`:

```json
{ "expectedRevision": 3, "operations": [
  { "type": "set-environment", "environment": { "look": "teal-orange", "viewTransform": "agx" } }
] }
```

`"look": null` removes it. Check the result with `scene_look`: a look changes the whole frame, so judge skin, white
and shadow tones, not only the accent color.

## Fog

`environment.fogDensity` is the cheap distance haze (`0` for none). `environment.volumeFog` is a lit box of fog with
god rays from the key light: set `density` above 0 and a `minimum`/`maximum` box that holds the camera and the subject.

Tool `scene_apply`:

```json
{ "expectedRevision": 4, "operations": [
  { "type": "set-environment", "environment": { "volumeFog": {
    "density": 0.04, "minimum": [-12, 0, -12], "maximum": [12, 8, 12], "anisotropy": 0.5
  } } }
] }
```

Multiple scattering is opt in. `scatterOctaves` (integer 1 to 4, default 1 = off) sums octaves that approximate
multiple scattering; `multiScatter`, `multiExtinction` and `multiAnisotropy` (0 to 1, default 0.5 each) shape them and
act only above 1 octave. Each octave costs three extra density taps per step, so start at 2.

```json
{ "type": "set-environment", "environment": { "volumeFog": { "density": 0.04, "scatterOctaves": 3, "multiScatter": 0.5 } } }
```

`keyTransmittance` and `surfaceTransmittance` are also opt in. `scene_capabilities` with `topic: "environment"` lists
every `volumeFog` field and its range.

Point lights do not scatter in volume fog; the sun does. A sunlit closed room with fog uses `bake.gridFog`
(see `light.md`). Animate density with an `environment` track `volumeFogDensity` (see `film-and-animation.md`).

## Exposure, bloom, contrast, occlusion

`effects` holds `exposure`, `saturation`, `contrast`, `temperature`, `vignette`, `grain`, `ambientOcclusion` (0 = off),
`bloom` and `depthOfField` (see `camera.md`). Nested `bloom` fields merge.
Named post steps, each off until set: `colorBalance` (`lift`, `gamma`, `gain`, three numbers each), `glare` (`streaks`,
`count`, `angle`, `fogGlow`, `threshold`, `size`) `lensDistortion` (`distortion`, `dispersion`), `stylize` (`sharpen`, `kuwahara`, `posterize`, `pixelate`) and `composite` (`background` `{ color }` or `{ top, bottom }`, `key` `{ chroma: { color, tolerance, softness } }` or `{ luma: { low, high, invert } }`, `mask`; a key needs a background); ranges in `docs/agent-look.md`.
`colorBalance`, `stylize` and `composite` take a `mask` (`objects` part names, `depth` `{ near, far, feather }`, `invert`) to apply only to a hero part or a depth band.

Tool `scene_apply`:

```json
{ "expectedRevision": 6, "operations": [
  { "type": "set-effects", "effects": { "exposure": 1.2, "vignette": 0.25, "bloom": { "strength": 0.2, "threshold": 1.2 }, "ambientOcclusion": 0.5 } }
] }
```

Overexposed highlights (flat white sky, clipped lamp): lower `exposure` or the light's `intensity` before adding bloom.

## Outlines and toon light

```json
{ "expectedRevision": 7, "operations": [
  { "type": "set-environment", "environment": { "lines": { "width": 2, "toon": 3 } } }
] }
```

`"lines": null` removes it. `scene_capabilities` reports `lineArt`.
