# Camera: lens, depth of field, framing

Calls follow the conventions in `look.md`. `tests/skill-examples.test.js` applies every block, so they stay valid.
The camera is the recipe `camera` (`scene_create`) or the `set-camera` operation, with fields directly on the command.

## Lens

Give `fov` (vertical degrees, default 45) or `focalLength` in millimetres with `sensorWidth` (default 36). Giving both
fails. `focalLength` replaces `fov` and `fov` replaces `focalLength`. About 24 mm is wide, 50 mm normal, 85 mm or more
a portrait or product close-up that flattens perspective.

Tool `scene_apply`:

```json
{ "expectedRevision": 1, "operations": [
  { "type": "set-camera", "eye": [2.2, 1.4, 3.2], "target": [0, 0.6, 0], "focalLength": 85 }
] }
```

`eye` and `target` must differ, and `up` must not be parallel to the view direction. `near` must stay above 0 and
below `far`. `shift: [x, y]` slides the frame by a fraction of its width and height without tilting (architecture,
keeping verticals straight). `projection: "orthographic"` with `orthoScale` (view height in metres) gives a plan or
isometric view and takes no `focalLength`; going back to `"perspective"` drops `orthoScale`.

## Depth of field, two ways

Both are deterministic and apply to every render, `scene_look` included. They are exclusive: use one.

**Camera f-stop.** `fStop` (0.7 to 64) turns on depth of field focused on the camera `target`. Smaller blurs more;
1.4 or lower is full blur. Aim `target` at the subject. Leave `effects.depthOfField.blur` at 0.

```json
{ "expectedRevision": 2, "operations": [
  { "type": "set-camera", "focalLength": 85, "fStop": 1.8 }
] }
```

**Effect settings.** `effects.depthOfField.blur` (0 to 1, off at 0; the widest circle is 5 percent of the image
height) and `focusDistance` (metres from the camera that stay sharp, 0.01 to 100000).

```json
{ "expectedRevision": 3, "operations": [
  { "type": "set-effects", "effects": { "depthOfField": { "blur": 0.6, "focusDistance": 3.5 } } }
] }
```

Measure the distance instead of guessing: it is the length of `target - eye`, or read the subject's bounds from
`scene_inspect`. A rack focus (focus moves during a shot) is a motion track: `effects` `focusDistance` with blur above
0, or with an `fStop` camera a camera `target` track. A shot in a `timeline` can also set `focusDistance` and `blur`
(see `film-and-animation.md`).

## Check

After a lens or depth of field edit call `scene_look` and `scene_review` with two shots (wide and close) to compare.
A blurred subject means the focus is off: recompute the distance. A scene that is blurred everywhere has `blur` too
high or an `fStop` below 1.4.
