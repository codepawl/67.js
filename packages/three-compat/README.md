# @codepawlhq/67js-three-compat

Optional addon that lets code written from memory in the three.js style build a 67js scene. It imports neither `three` nor `67js`: you pass the 67js exports to it, so the core gains no dependency and this package gains none. It is not part of the core `67js` archive.

```js
import * as core from '@codepawlhq/67js';
import { loadGltf } from '@codepawlhq/67js/addons/gltf';
import { createThreeCompat } from '@codepawlhq/67js-three-compat';

const THREE = createThreeCompat({ ...core, loadGltf });

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(3, 2, 4);
camera.lookAt(0, 0.5, 0);
const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x2f9e6b, roughness: 0.5 }));
cube.position.y = 0.5;
scene.add(cube, new THREE.DirectionalLight(0xffffff, 3), new THREE.AmbientLight(0xffffff, 0.4));

const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('#scene') });
renderer.setAnimationLoop(() => {
  cube.rotation.y += 0.01;
  renderer.render(scene, camera);
});
```

## What it accepts

`Scene`, `Group`, `Object3D`, `Mesh`, `BoxGeometry`, `PlaneGeometry`, `SphereGeometry`, `CylinderGeometry` (equal radii), `TorusGeometry`, `MeshStandardMaterial`, `MeshPhysicalMaterial`, `Texture`, `CanvasTexture`, `PerspectiveCamera`, `OrthographicCamera`, `AmbientLight`, `HemisphereLight`, `DirectionalLight`, `PointLight`, `SpotLight`, `RectAreaLight`, `GLTFLoader` (`load` and `loadAsync`), `OrbitControls`, `WebGLRenderer` (`render`, `setSize`, `setPixelRatio`, `setAnimationLoop`, `dispose`), `Clock`, `Color`, `Vector2`, `Vector3` and `Euler` (order XYZ).

Light intensities pass through unchanged: three.js and 67js use different units, so tune them by eye. A scene with at least one light switches the studio rig off, as in three.js; a scene with none keeps it. `AmbientLight` and `HemisphereLight` use their intensity only, not their colour.

## What it refuses

Any other capitalised name, such as `MeshBasicMaterial`, `ShaderMaterial`, `WebGLRenderTarget` or `Fog`, throws an error that names the three.js call and the 67js call to use instead. The full mapping is in [If you know three.js](../../docs/learn/if-you-know-three-js.md).

`createThreeCompat(core).collectScene(scene, camera)` returns `{ parts, environment, frame }` without a renderer, which is what the tests use.
