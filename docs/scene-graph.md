# Scene graph

Available from version `0.4.0`.

`createSceneGraph(definitions, options)` builds named nodes with retained local and world matrices.
Each definition can refer to its parent by name, even when the parent appears later in the array.
Nodes without a parent form independent roots.

```js
const graph = createSceneGraph([
  { name: 'rig' },
  {
    name: 'arm',
    parent: 'rig',
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1],
    pivot: [0.5, 0, 0],
    geometry: armGeometry,
    material: armMaterial,
  },
]);

const mixer = createAnimationMixer(graph.animationTargets);
mixer.clipAction(armClip).play();
mixer.apply(1);
graph.update();
// graph.parts contains mesh nodes with published world matrices for CrucibleRenderer.
```

## Definitions and retained objects

| Field | Contract |
| --- | --- |
| `name` | A unique, nonempty string. |
| `parent` | An existing node name or `null`. Omitted parents produce roots. |
| `matrix` | Sixteen finite Float32 values in column-major order. Defaults to identity. |
| `pivot` | Three finite Float32 values in parent coordinates. Defaults to `[0, 0, 0]`. |
| `geometry`, `material` | Both objects for a mesh node, or both omitted for a group. |

Matrices and pivots accept plain arrays or typed arrays, and the graph copies them during creation.
Plain arrays make topology and transform definitions compatible with JSON round trips.
Geometry and material objects retain their original identities. Live textures and typed geometry buffers need their own asset serialization.

| Graph member | Purpose |
| --- | --- |
| `nodes` | Stable nodes in definition order, including groups. |
| `parts` | Stable flat mesh parts with `{ name, geometry, material, matrix }`. Their matrices contain world transforms. |
| `animationTargets` | Stable aliases for every node. Their matrices contain local transforms. |
| `getNode(name)` | Returns the named node or throws when it is missing. |
| `update()` | Propagates current local transforms, publishes world matrices and returns `parts`. |
| `reparent(name, parent, { keepWorld = false })` | Changes topology and publishes the resulting world matrices. `null` creates a root. |

Nodes expose `localMatrix`, `worldMatrix`, `pivot`, `geometry`, `material` and a read-only `parent` name.
The node lists, alias objects and matrix identities remain stable.
Local matrices and pivots remain mutable for animation and application edits.
World matrices contain graph output and must not serve as local inputs.

## Pivot and propagation rules

Each node uses `parentWorld * T(pivot) * localMatrix * T(-pivot)`.
This rotates and scales around the pivot in the parent's coordinates.
The local matrix translation adds to the transformed pivot position.
Children inherit the complete world matrix, including shear produced by rotated nonuniform scales.

The graph compiles a parent-before-child order independently of definition order.
`update()` evaluates the entire graph into retained staging buffers before publishing any world matrix.
It does not depend on previously published matrices, so repeated evaluations of the same locals produce the same output.
The update path allocates no arrays, maps, matrix objects or material copies.

## Animation and materials

Animation players and mixers bind `animationTargets` so they change local transforms.
Propagation follows animation sampling, and the renderer receives `parts`.
Material getters and setters share one slot between each node, its animation alias and its render part.
Animation material isolation therefore reaches the render part while preserving shared texture references.

Animation binding still requires local rotation with positive scale and no shear.
The graph itself accepts nonsingular affine shear and reflections.
World matrices can contain shear without violating the local animation contract.

## Reparenting

Without `keepWorld`, reparenting preserves the local matrix and allows the world pose to change.
With `keepWorld`, reparenting computes the current world pose from locals, including edits that were not yet published.
It compensates the new local matrix for the new parent's world transform and the node's pivot.
The node and its descendants preserve their world poses within Float32 precision.

Reparenting retains full matrices instead of decomposing them into translation, rotation and scale.
This permits compensation under rotated nonuniform scales, but the resulting local matrix can contain shear.
Existing animation bindings retain their captured base poses and authored local values.
Subsequent animation sampling can therefore overwrite the compensated pose. Reparenting does not retarget clips or recapture mixer base poses.

Topology changes allocate candidate parent links and traversal data.
They validate candidate matrices and depth before committing the parent name, local compensation or any world output.
Cycles, missing parents and invalid candidate transforms leave published graph state unchanged.

## Validation and limits

`maxNodes` defaults to `4096`, and `maxDepth` defaults to `256` with each root at depth one.
Both options must be positive safe integers. Traversal uses no recursion.
Duplicate names, missing parents, cycles and exceeded limits throw during creation or reparenting.

Local and composed world matrices must remain affine, nonsingular and finite in Float32 representation.
Invalid local edits, pivots, matrix overflow and singular results throw before any world matrix changes.
Caller edits to local buffers remain present after a failed update, so the caller must repair them before retrying.
This graph validation covers transforms and mesh object pairing. The renderer owns geometry, material and texture validation.

## API design choice

| Shape | Benefit | Cost |
| --- | --- | --- |
| Recursive mutable node objects | Expresses parent and child relationships directly. | Object references complicate JSON serialization and expose topology mutations. |
| Flat definitions with parent names | Supports JSON topology, forward references and centralized cycle checks. | Requires a compiled traversal order and explicit reparenting. |

Flat definitions fit the existing flat renderer parts and local animation bindings.
The graph does not add constraints, inverse kinematics, skinning, morph targets or clip retargeting.
