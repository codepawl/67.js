# Agent visual review

Release `0.9.0` adds `scene_review` for inspecting several views or motion samples in one MCP image.
The tool renders an isolated snapshot. It preserves the source recipe, revision, preview pose and checkpoint handles.

## Compare views

1. Create a scene or import a configured GLB.
2. Inspect its current revision.
3. Call `scene_review` with that revision and one to four shots.
4. Inspect the returned PNG and each shot's metadata.
5. Apply corrections to the source with its unchanged revision.

```json
{
  "sessionId": "<scene UUID>",
  "expectedRevision": 0,
  "width": 384,
  "height": 384,
  "shots": [
    {
      "label": "Front",
      "camera": { "eye": [0, 2, 7], "target": [0, 1.5, 0] }
    },
    {
      "label": "Side",
      "camera": { "eye": [7, 2, 0], "target": [0, 1.5, 0] }
    },
    {
      "label": "Back",
      "camera": { "eye": [0, 2, -7], "target": [0, 1.5, 0] }
    }
  ]
}
```

The response contains one PNG image block, JSON text and structured metadata.
The grid labels identify shots. Each shot reports its sampled camera, label positions and branch. `response_format: "detailed"` also gives the clocks, output dimensions and render resources (graphics, estimated bytes, buffer counts) and the run's memory peaks.
This tool does not require a configured render job directory or write output files.

## Compare motion

Each shot starts independently from the authored base pose.
Omitted sampling does not inherit the previous shot's motion time or imported clip sample.

`motionTime` samples recipe-owned motion. `null` selects the authored base pose.
`animation` supplies an imported clip index and absolute time. Procedural scenes reject imported clip sampling.
Imported clip and authored motion clocks compose through one atomic pose transaction.

```json
{
  "sessionId": "<scene UUID>",
  "expectedRevision": 0,
  "shots": [
    { "label": "Authored base" },
    { "label": "Start", "motionTime": 0 },
    { "label": "Middle", "motionTime": 1.5 },
    { "label": "End", "motionTime": 3 }
  ]
}
```

These samples require authored motion. Nonlooping motion holds its endpoint after the duration. Looping motion wraps the requested time.
`rendererTime` controls shader animation independently and defaults to zero.
Camera fields override only the private shot camera. They do not author tracks or edit the source camera.

## Compare branches and read labels

A shot can name a branch made by `scene_apply` with `branch`. The branch renders in its own private scene, so one review compares variants without a restore, a revision or a look per variant:

```json
{ "sessionId": "<scene UUID>", "expectedRevision": 3, "labels": true,
  "shots": [{ "branch": "warm" }, { "branch": "cool" }, { "label": "Now" }] }
```

Shots of the same branch share one private scene. Each shot reports `branch` and `branchStale`, true when the scene changed after the fork. Branch shots cannot sample an imported clip.

`labels: true`, on `scene_review` and on `scene_look`, draws the node name, a material tag other than `surface` and the mesh lint problems (in orange) at each visible part's bounds centre. The same list returns as JSON, `labels: [{ id, name, tag, faceTags, problems, x, y }]`, with `x` and `y` in the pixels of that image or shot. At most 24 parts are labelled; hidden parts are left out. Names are cut to printable ASCII. Imported assets get names and tags but no lint.

## Budgets and ownership

| Limit | Value |
| --- | --- |
| Shots | One to four |
| Requested size per shot | 64 to 480 pixels per axis |
| Default size per shot | 384 by 384 pixels |
| Label | At most 48 characters |
| Response image | At most 1 MiB |
| Review output | One labeled PNG grid |

The renderer can reduce actual dimensions to respect its memory budget. Metadata reports the actual size of each shot.
The runtime captures one frame at a time. It releases the private renderer before restoring the source preview renderer.

Review calls serialize with source edits. Active render jobs retain their exclusive renderer lease.
Invalid shots fail without editing the source. Closing the MCP connection releases the private review resources.

The 30-second deadline covers private page acquisition and rendering after snapshot and asset verification.
Cleanup and source preview recovery follow that deadline. `elapsedSeconds` reports the measured review duration.

The tool provides visual evidence. It does not diagnose every intersection, guarantee a good composition or supply automatic framing of deformed assets.
Mesh inspection bounds describe authored geometry. Skinning and morphs can move the visible surface beyond those bounds.
