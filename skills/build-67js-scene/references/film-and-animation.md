# Film and animation: motion tracks, shots, timeline

Calls follow the conventions in `look.md`. `tests/skill-examples.test.js` applies every block, so they stay valid.
Everything here is deterministic: a seek to a time gives the same pixels as playing to it. Export is the
`render-67js-media` skill.

## Motion record

`set-motion` takes one complete record `{ duration, loop, tracks }`, or `null` to clear it. A track has `kind`, an
`id` (omitted for `camera`, `sun`, `environment`, `effects`), a `property`, optional `interpolation`
(`LINEAR`, `STEP`, `SMOOTH`, `CUBICSPLINE`) and `keyframes` of `{ time, value }` (optional per-key `easing`).
Properties: node `translation`, `rotation` (XYZW quaternion), `scale`, `visible` (1 or 0); material `color`,
`emission`, `roughness`, `metallic`; camera `eye`, `target`, `fov`, `roll`. Every referenced ID must exist after the
batch. Nonlooping motion must cover every sampled time.

Tool `scene_apply` (a camera push-in plus a spinning part; node `lid` exists):

```json
{ "expectedRevision": 1, "operations": [
  { "type": "set-motion", "motion": { "duration": 4, "loop": false, "tracks": [
    { "kind": "camera", "property": "eye", "interpolation": "SMOOTH",
      "keyframes": [ { "time": 0, "value": [5, 3, 6] }, { "time": 4, "value": [2.5, 1.5, 3] } ] },
    { "kind": "camera", "property": "target",
      "keyframes": [ { "time": 0, "value": [0, 0.5, 0] }, { "time": 4, "value": [0, 0.8, 0] } ] },
    { "kind": "node", "id": "lid", "property": "translation",
      "keyframes": [ { "time": 0, "value": [0, 1, 0] }, { "time": 4, "value": [0, 2, 0] } ] }
  ] } }
] }
```

Check a frame without changing the revision: `scene_look` with `motionTime: 2` (`null` returns to the base pose).
`scene_review` compares several times or cameras in one grid.

## Animated lights, sun, sky and effects

On a scene recipe (not an imported asset) four more kinds animate the look:

- `light` with `id` `point:N`, `spot:N` or `area:N` (index in the matching `environment` list): `position`, `color`,
  `intensity`, plus `direction` on spot and area.
- `sun` (no id): `direction`, `color`, `intensity`, which drive `lightDirection`, `keyColor`, `keyIntensity`.
- `environment` (no id): `skyTop`, `skyBottom`, `fogColor`, `fogDensity`, `volumeFogDensity`, `ambientIntensity`,
  `fillIntensity`, `environmentIntensity`, `environmentRotation` (radians; turns the HDRI or sky shown with `world: true`).
- `effects` (no id): `exposure`, `focusDistance` (needs `effects.depthOfField.blur` above 0).

Values keep the range of the field they drive. Baked light does not follow a moving light.

```json
{ "expectedRevision": 2, "operations": [
  { "type": "set-motion", "motion": { "duration": 4, "tracks": [
    { "kind": "sun", "property": "direction", "keyframes": [ { "time": 0, "value": [-1, 4, 1] }, { "time": 4, "value": [-4, 0.3, 1] } ] },
    { "kind": "sun", "property": "color", "keyframes": [ { "time": 0, "value": [3, 2.8, 2.5] }, { "time": 4, "value": [3.4, 1.4, 0.6] } ] },
    { "kind": "environment", "property": "environmentIntensity", "keyframes": [ { "time": 0, "value": 1 }, { "time": 4, "value": 0.4 } ] },
    { "kind": "environment", "property": "volumeFogDensity", "keyframes": [ { "time": 0, "value": 0 }, { "time": 4, "value": 0.05 } ] },
    { "kind": "light", "id": "point:0", "property": "intensity", "keyframes": [ { "time": 0, "value": 0 }, { "time": 4, "value": 3 } ] },
    { "kind": "effects", "property": "exposure", "keyframes": [ { "time": 0, "value": 1 }, { "time": 4, "value": 1.4 } ] },
    { "kind": "effects", "property": "focusDistance", "keyframes": [ { "time": 0, "value": 3 }, { "time": 4, "value": 6 } ] }
  ] } }
] }
```

That is a sunset with a lamp coming on and a rack focus. An unknown light ID, property or kind fails and names the
valid ones. `scene_inspect` lists the lights, so read the indexes there.

## Shots and cuts

A recipe `timeline` plays shots one after another over the motion clock: no layers or crossfades, only cuts and `dip`
(a dip through black). A shot has `name` (unique), `duration`, optional `camera` (partial: `eye`, `target`, `up`,
`fov`, `near`, `far`), `motionStart`, `focusDistance` and `blur` for that shot's depth of field, and `dip`. The
timeline holds up to 64 shots and 60 s.

```json
{ "expectedRevision": 3, "operations": [
  { "type": "set-timeline", "timeline": { "shots": [
    { "name": "wide", "duration": 3, "camera": { "eye": [0, 3, 14], "target": [0, 0, 0] } },
    { "name": "close", "duration": 3, "camera": { "eye": [0, 0.6, 2.4], "fov": 50 }, "focusDistance": 2.4, "blur": 0.5 },
    { "name": "dusk", "duration": 2, "dip": 1 }
  ] } }
] }
```

A non-looping motion must cover the timeline, or the call fails ("Shot close reads motion up to 6 s but the motion
lasts 4 s"): lengthen `duration`, set `loop: true` or give the shot a `motionStart`.
`set-timeline` with `null` removes it. With a timeline the render job's `motion` and `animation` settings are
rejected; the job reads timeline time (`settings.timeline: { start }`).

## Character and imported motion

Rigs, `motion.ik`, constraints, drivers, clip layers on an imported asset and morph weights are listed in
`scene_capabilities`. Read `scene_inspect` (`motionIk`, `rig`, `animations`) after every change and fix its warnings
before you finish.

## Before a film goes out

A metro film once shipped all of these as "texture glitches". Check each one in the preview:

- Crop 4 consecutive full-size frames of every textured floor, tread, rail and metal surface seen at a steep angle. Speckles that move between them are specular sparkle (67.js#588), not a missing mipmap.
- When you drop a material's base colour map, also drop or soften its normal and metallic-roughness maps (`normalScale` 0.2 to 0.35). Paint is a dielectric (`metallic: 0`).
- Thin shiny metal boxes such as handrails and posts mirror a bright ceiling as jagged shapes. Make painted rails matte.
- Dust motes outside the depth of field blur into hollow rings. Fade them by circle of confusion.
- Lens ghosts are filled soft discs, never bright-rimmed rings.
- Screen-space sun shafts take their source only from sky masked around the sun. Otherwise a lit sign casts rays through itself.
- A dot-matrix sign keeps only its lit dots. The unlit grid aliases into moire.
