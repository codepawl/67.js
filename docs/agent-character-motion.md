# Imported character motion

Release `0.8.0` adds imported character motion. Earlier packages support procedural motion or imported clip sampling only.

Imported asset recipes can retain a GLB hierarchy, skin, textures, morphs and existing clips while adding authored motion.
The decoder loads the asset once. Sampling reuses decoded geometry, texture descriptors and pose buffers.

## Find the joints

```json
{
  "name": "scene_inspect",
  "arguments": {
    "sessionId": "SESSION_UUID",
    "kind": "hierarchy",
    "offset": 0,
    "limit": 64
  }
}
```

Hierarchy records expose stable source IDs, labels, parents, local transforms, editability, joint flags and associated mesh IDs.
The source IDs use `node-N`, where `N` is the node index in the GLB.
Mesh inspection retains separate `mesh-N` IDs for rendered primitives.
Names are labels because an asset can contain duplicate names.


The `offset` and `limit` fields paginate imported asset inspection.
Hierarchy inspection does not provide deformed silhouette bounds.
Mesh bounds describe authored base geometry at the recipe pose and motion time zero.
Transient motion does not change these bounds. Skin and morph deformation can extend beyond them.

## Author a local joint

```json
{
  "name": "scene_apply",
  "arguments": {
    "sessionId": "SESSION_UUID",
    "expectedRevision": 0,
    "operations": [
      {
        "type": "set-asset-node",
        "id": "node-3",
        "rotation": [0, 0, 0.3826834324, 0.9238795325]
      }
    ]
  }
}
```

`set-asset-node` replaces specified local translation, rotation or scale components.
It preserves unspecified components from the selected imported clip or decoded base pose.
The canonical recipe stores these changes in `nodeOverrides`.
Quaternions use XYZW ordering. Scales must remain positive at Float32 precision.

An unsupported shear or reflection makes the source node uneditable. Its untouched imported matrix remains supported.

## Add motion

```json
{
  "type": "set-motion",
  "motion": {
    "duration": 2,
    "tracks": [{
      "kind": "node",
      "id": "node-3",
      "property": "rotation",
      "interpolation": "SMOOTH",
      "keyframes": [
        { "time": 0, "value": [0, 0, 0, 1] },
        { "time": 2, "value": [0, 0, 0.3826834324, 0.9238795325] }
      ]
    }]
  }
}
```

The [motion contract](agent-motion.md) defines curves, keyframes, material channels, camera paths and numeric limits.
Imported node tracks target editable source IDs. Material tracks target existing `material-N` IDs.

Pose evaluation starts from the decoded base on every seek.
It applies the selected imported clip, static node overrides and authored motion in that order.
The outer asset root transform applies last.
Tracks replace specified components rather than adding rotations or translations.
IK then solves on that pose.

Imported morph animation remains attached to its clip. To key a face by hand, add `{ "kind": "morph", "id": "jawOpen",
"property": "weight", "keyframes": [...] }` tracks: the id is a morph target name from `morphTargetNames` in `scene_inspect`.

### Clips from another character

A layer with `from: { "asset": "<catalog ID>", "clip": 0 }` plays a clip of another humanoid file on this one, corrected for
the difference in rest pose and leg length (`retargetClip`). Add `footLock` to the motion to plant the feet, with a `ground`
plane and normal on a slope. Fields, limits and what `scene_inspect` reports (`retargets`, `footLock`) are in
[the motion contract](agent-motion.md#a-clip-from-another-catalog-asset); the library side is in [retargeting](https://crucible.codepawl.com/retarget.md).
The foot lock reads the layers, then your tracks and IK apply on top.

`scene_look.motionTime` and `scene.sampleMotion(time)` sample motion without changing the recipe, revision or checkpoints.
Explicit `null` restores the authored pose without procedural tracks.
Creating, editing or restoring a recipe samples its motion at time zero.
Omitting `motionTime` preserves the last preview pose.

## Export a snapshot

```json
{
  "name": "scene_render_submit",
  "arguments": {
    "sessionId": "SESSION_UUID",
    "expectedRevision": 1,
    "settings": {
      "kind": "video",
      "width": 480,
      "height": 480,
      "duration": 2,
      "fps": 24,
      "animation": { "clip": 0, "start": 0 },
      "motion": { "start": 0 }
    }
  }
}
```

An imported clip and authored motion have independent clocks. Either clock can remain fixed while the other advances.
Snapshot jobs retain the exact GLB bytes and canonical recipe.
Completion or cancellation restores the source preview pose and revision.

`scene.sampleFrame({ animation, motionTime })` stages both clocks together without changing the canonical recipe or revision.
Omitting animation uses the recipe selection. Omitting motion time retains the last sampled motion time.
Explicit `null` animation selects the decoded base. Explicit `null` motion time disables authored tracks.

## Decoder transaction

`asset.stagePose({ animation, nodeOverrides })` returns borrowed candidate `parts`, `commit()` and `discard()`.
The public asset parts remain unchanged until commit. Only one transaction can remain pending.
The adapter validates the candidate root, skin, morph, material and camera before publication.
Discard restores private hierarchy transforms, morph influences and mixer state.
Failed staging or commit preserves the previous public buffers.

Candidate buffers belong to the decoder. Their contents expire at the next staging operation.
The asset must remain exclusively owned by its adapter while transactions are active.

This feature does not create a rig for a flat mesh collection.
Imported asset recipes do not change topology. For a hand reaching or a head looking at a point, use [`motion.ik`](agent-motion.md#inverse-kinematics) instead of writing rotations. In code, [skeleton pose layers](skeleton-pose.md) mix clips with masks and [retargeting](https://crucible.codepawl.com/retarget.md) moves clips between rigs.
The current WALL·E asset has separate mesh roots and no skeleton. It supports rigid part movement through source-node tracks.
