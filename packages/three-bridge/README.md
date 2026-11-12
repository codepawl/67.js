# @codepawlhq/67js-three-bridge

Optional addon that imports a three.js object tree as 67js parts and builds three.js meshes from 67js parts. It imports neither `three` nor 67js. `three` is a peer dependency of this package only; the core gains none. Not part of the core `67js` archive.

```js
import * as THREE from 'three';
import { exportGlb } from '@codepawlhq/67js';
import { fromThreeObject, toThreeObject } from '@codepawlhq/67js-three-bridge';

const { parts, warnings } = fromThreeObject(group);   // three.js Object3D -> 67js parts
const { object } = toThreeObject(parts, THREE);        // 67js parts -> Group of Mesh
const glb = exportGlb(parts);                          // 67js parts -> GLB
```

Anything it cannot map is listed in `warnings`. A `ShaderMaterial` and a `SkinnedMesh` without bones throw an error that names the object. The guide with the mapping table, limits and options is [docs/three-bridge.md](../../docs/three-bridge.md).
