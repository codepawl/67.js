# If you know three.js

Crucible does not copy the three.js API, but every common three.js idea has a Crucible call. This page maps one to the other. A test checks that each Crucible name below exists, so the page cannot drift from the code.

The main difference: three.js keeps a tree of objects that you change. Crucible keeps a flat list of parts, which are plain objects with a `name`, a `geometry`, a 16 number `matrix` and a `material`. You change the list and call `renderer.updateParts(parts)`, then draw with `renderer.render(frame)`. The camera and the lights are not objects in the scene. They are fields of the frame and of the `environment` option.

If you would rather write three.js-shaped code, the optional addon `packages/three-compat` accepts the common names and builds the Crucible parts for you. It is at the end of this page.

## Scene, objects and meshes

| three.js | Crucible |
| --- | --- |
| `new THREE.Scene()` | A `parts` array: `const parts = []`. |
| `new THREE.Group()` | A shared matrix. Multiply it into each child matrix, or use `createSceneGraph()`, which keeps named nodes with a parent and retained world matrices. |
| `new THREE.Mesh(geometry, material)` | A part `{ name, geometry, matrix, material }`. `name` must be unique. |
| `scene.add(mesh)` | `parts.push(part)`, then `new CrucibleRenderer(canvas, parts)`. |
| `mesh.position.set(x, y, z)` | The last four numbers of `part.matrix`: `matrix[12]`, `matrix[13]`, `matrix[14]`. |
| `mesh.rotation`, `mesh.scale` | The other numbers of `part.matrix`, which is column-major. |
| Change a mesh after the first frame | Change the part, then call `renderer.updateParts(parts)`. |

## Geometry

| three.js | Crucible |
| --- | --- |
| `new THREE.BoxGeometry(w, h, d)` | `box()` is a cube of side 1 with rounded edges. Scale it in the matrix, and use `box(0)` for sharp edges. |
| `new THREE.SphereGeometry(radius, widthSegments, heightSegments)` | `sphere(segments, rings)` has radius 1. Scale it in the matrix. |
| `new THREE.CylinderGeometry(r, r, height, segments)` | `cylinder(segments)` has radius 1 and height 1. |
| `new THREE.TorusGeometry(radius, tube)` | `torus(tubeRadius)` has a ring radius of 1. `tubeRadius` is `tube / radius`. |
| `new THREE.PlaneGeometry(w, h)` | `box(0)` scaled flat. |
| `new THREE.ConeGeometry()` | `createModel()` from `crucible/addons/model`. |
| `new THREE.BufferGeometry()` | An object with `positions`, `normals` and `indices`. See [Parts and geometry](#parts-and-geometry). |

## Materials

| three.js | Crucible |
| --- | --- |
| `new THREE.MeshStandardMaterial({ color, metalness, roughness })` | `material: { color, metallic, roughness }`. `color` is three linear numbers from 0 to 1, not a hex number. |
| `emissive` and `emissiveIntensity` | `material.emission` and `material.emissiveColor`. |
| `map`, `normalMap` | `material.map` and `material.normalMap`, each `{ image, colorSpace }`. |
| `transparent` and `opacity` | `material.alphaMode` set to `'blend'`, and `material.opacity`. |
| `alphaTest` | `material.alphaMode` set to `'mask'`, and `material.alphaCutoff`. |
| `side: THREE.DoubleSide` | `material.doubleSided` set to `true`. |
| `new THREE.MeshPhysicalMaterial({ clearcoat, transmission, ior })` | The same `material` with `material.clearcoat`, `material.transmission` and `material.ior`. The fields are listed in `docs/material-maps.md` in the repository. |
| `ShaderMaterial` | None. Crucible has no custom shaders. |

## Cameras

The camera is a frame passed to `renderer.render(frame)`.

| three.js | Crucible |
| --- | --- |
| `new THREE.PerspectiveCamera(fov, aspect, near, far)` | `renderer.render({ eye, target, fov, near, far })`. `frame.fov` is the vertical angle in degrees. The aspect comes from the canvas. |
| `new THREE.OrthographicCamera(...)` | `frame.projection` set to `'orthographic'`, and `frame.orthographicHeight`. |
| `camera.position.set(x, y, z)` | `frame.eye`. |
| `camera.lookAt(x, y, z)` | `frame.target`. |
| `camera.up` | `frame.up`. |
| `renderer.setSize(w, h)` and a window resize handler | Size the canvas in CSS, then call `renderer.resize()`. |
| `camera.updateProjectionMatrix()` | Not needed. `renderer.render()` reads the frame every time. |

## Lights

The lights are fields of the `environment` option of `CrucibleRenderer`, or of `frame.environment` for one frame. The studio rig (a key light, two fills and ambient light) is on by default.

| three.js | Crucible |
| --- | --- |
| `new THREE.AmbientLight(color, intensity)` | `environment.ambientIntensity`. |
| `new THREE.HemisphereLight()` | `environment.ambientIntensity`. |
| `new THREE.DirectionalLight(color, intensity)` | `environment.lightDirection`, `environment.keyIntensity` and `environment.keyColor`. It casts shadows. |
| `new THREE.PointLight(color, intensity, distance)` | An entry of `environment.pointLights`: `{ position, color, intensity, range }`. At most 16. |
| `new THREE.SpotLight(...)` | An entry of `environment.spotLights`: `{ position, direction, angle, penumbra, intensity }`. At most 8. |
| `new THREE.RectAreaLight(...)` | An entry of `environment.areaLights`: `{ position, direction, width, height, intensity }`. At most 7. |
| `light.castShadow = true` | `castShadow: true` on a point, spot or area light. The key light always casts. |
| `scene.background` | `environment.skyTop` and `environment.skyBottom`. |
| `scene.fog` | `environment.fogColor` and `environment.fogDensity`. |

Light units differ, so a copied intensity is not the same brightness. Tune by eye. The [lighting contract](/lighting.md) lists the fields.

## Loaders

| three.js | Crucible |
| --- | --- |
| `new GLTFLoader().load(url, onLoad)` | `loadGltf(url)` from `crucible/addons/gltf`. It returns an asset, and `asset.parts` are ordinary parts. |
| `gltf.scene` | `asset.parts`. |
| `gltf.animations` and `new THREE.AnimationMixer(scene)` | `createAnimationMixer(parts)`, or `createAnimationPlayer(clip, parts)`. |
| `DRACOLoader`, `KTX2Loader` | The `decoders` option of `loadGltf`. See [Import and export models](#import-and-export-models). |
| `new THREE.TextureLoader().load(url)` | Load an `Image` yourself and put it in `material.map`. |
| `RGBELoader` and `scene.environment` | `createEnvironmentMap()` and the `environment.map` option. |

## The render loop

| three.js | Crucible |
| --- | --- |
| `renderer.setAnimationLoop(fn)` | Call `requestAnimationFrame` yourself, change the parts, call `renderer.updateParts(parts)` and `renderer.render(frame)`. |
| `renderer.render(scene, camera)` | `renderer.render(frame)`. |
| `new THREE.Clock()` and `clock.getDelta()` | `performance.now()`. For motion that must repeat exactly, pass absolute time to `sampleAnimationClip()`. |
| `renderer.setPixelRatio(ratio)` | The `pixelRatio` option of `CrucibleRenderer`. |
| `renderer.dispose()` | `renderer.dispose()`. |
| `new THREE.WebGLRenderer({ antialias: true })` | `new CrucibleRenderer(canvas, parts, { samples: 4 })`. |

## Controls and render targets

| three.js | Crucible |
| --- | --- |
| `new OrbitControls(camera, canvas)` | Keep a yaw, a pitch and a distance, then compute `frame.eye` from them on `pointermove` and `wheel`. [Cameras and framing](#cameras-and-framing) has the code. `cameraView()` and `fitPerspectiveDistance()` frame a subject. |
| `new THREE.WebGLRenderTarget(w, h)` | None. `CrucibleRenderer` draws to its canvas. Read the picture with `canvas.toBlob()`. For a PNG job in an agent, use the `scene_render_submit` tool. |
| `EffectComposer` and passes | `frame.effects`, built with `resolveEffects()`. |
| `renderer.shadowMap.enabled` | Shadows are always on. A part leaves them with `castShadow: false`. |

## Names the addon refuses

`packages/three-compat` is an optional addon that accepts the common three.js names and builds Crucible parts, materials, cameras and lights from them. It has no import of `three` and no dependency on the core: you pass it the Crucible exports.

```js
import * as core from 'crucible';
import { loadGltf } from 'crucible/addons/gltf';
import { createThreeCompat } from '@codepawlhq/crucible-three-compat';

const THREE = createThreeCompat({ ...core, loadGltf });
```

It accepts `Scene`, `Group`, `Mesh`, the box, plane, sphere, cylinder and torus geometries, `MeshStandardMaterial`, `MeshPhysicalMaterial`, both cameras, the light classes, `GLTFLoader`, `OrbitControls` and `WebGLRenderer` with `setAnimationLoop`. For any other three.js name it throws an error that names the Crucible call to use. For example, `THREE.MeshBasicMaterial` tells you to use `MeshStandardMaterial` with `emissive`, which is `material.emission` in Crucible.

To move a scene you already have, the [three.js bridge](../three-bridge.md) imports a three.js object tree as Crucible parts and builds three.js meshes from parts.

The addon is a bridge for code that an agent writes from memory. For new code, write parts directly: it is shorter and has no extra layer.
