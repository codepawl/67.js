// Runs in the page: draws one bare scene with 67js and with three.js, each at its own defaults, for the default look bench (issue #988).
// three.js is a devDependency used by bench/ only. It is never imported by src/.
import * as THREE from 'three';
import { Renderer67 } from '/src/renderer.js';
import { DEFAULT_LOOK_SCENES } from './default-look-scenes.js';
import { DEFAULT_LOOK_VARIANTS, IMAGE_HEIGHT, IMAGE_WIDTH, SKY_RADIANCE } from './default-look-variants.js';

function createCanvas() {
  const canvas = document.createElement('canvas');
  canvas.style.width = `${IMAGE_WIDTH}px`;
  canvas.style.height = `${IMAGE_HEIGHT}px`;
  document.body.append(canvas);
  return canvas;
}

function pngOf(canvas) {
  return canvas.toDataURL('image/png').split(',')[1];
}

// 67js with the options a variant names, and every other option left at the constructor's default.
function drawWith67js(scene, variant) {
  const canvas = createCanvas();
  const renderer = new Renderer67(canvas, scene.parts, {
    ground: false, world: true, pixelRatio: 1, environment: scene.environment, shadowBounds: scene.shadow, ...variant.rendererOptions,
  });
  renderer.resize();
  const frame = { ...scene.camera, environment: scene.environment, time: 0, wind: 0, exposure: 1, effects: variant.effects };
  renderer.render(frame);
  renderer.render(frame);
  const image = pngOf(canvas);
  renderer.dispose();
  canvas.remove();
  return image;
}

function threeGeometry(geometry) {
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.BufferAttribute(geometry.positions, 3));
  result.setAttribute('normal', new THREE.BufferAttribute(geometry.normals, 3));
  result.setIndex(new THREE.BufferAttribute(geometry.indices, 1));
  return result;
}

function threeMaterial(material) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(...material.color),
    roughness: material.roughness,
    metalness: material.metallic ?? 0,
  });
}

// The uniform sky as light: a constant environment gives diffuse light of pi times its radiance, as Cycles' constant world does.
function skyLighting(renderer, scene) {
  const skyColor = new THREE.Color().setRGB(SKY_RADIANCE, SKY_RADIANCE, SKY_RADIANCE);
  const lightSource = new THREE.Scene();
  lightSource.background = skyColor;
  const generator = new THREE.PMREMGenerator(renderer);
  scene.environment = generator.fromScene(lightSource, 0, 0.1, 100).texture;
  generator.dispose();
  // A mesh, so the sky goes through the tone mapping as the geometry does (a background colour would not).
  const dome = new THREE.Mesh(new THREE.SphereGeometry(60, 16, 8), new THREE.MeshBasicMaterial({ color: skyColor, side: THREE.BackSide }));
  scene.add(dome);
}

function sunLight(description, shadow) {
  const strength = Math.max(...description.environment.keyColor);
  const color = new THREE.Color().setRGB(...description.environment.keyColor.map(channel => channel / strength));
  const light = new THREE.DirectionalLight(color, strength);
  light.position.set(...shadow.eye);
  light.target.position.set(...shadow.target);
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  Object.assign(light.shadow.camera, { left: -shadow.extent, right: shadow.extent, top: shadow.extent, bottom: -shadow.extent, near: shadow.near, far: shadow.far });
  light.shadow.bias = -0.0005;
  light.shadow.normalBias = 0.02;
  return light;
}

// three.js with its own defaults for the renderer (antialias on, as a first example would have it) and the lights above.
function drawWithThree(scene, variant) {
  const canvas = createCanvas();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(IMAGE_WIDTH, IMAGE_HEIGHT, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  Object.assign(renderer, variant.rendererSettings(THREE));
  const threeScene = new THREE.Scene();
  skyLighting(renderer, threeScene);
  const sun = sunLight(scene, scene.shadow);
  threeScene.add(sun, sun.target);
  const geometries = new Map();
  for (const part of scene.parts) {
    if (!geometries.has(part.geometry)) geometries.set(part.geometry, threeGeometry(part.geometry));
    const mesh = new THREE.Mesh(geometries.get(part.geometry), threeMaterial(part.material));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.fromArray(part.matrix);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    threeScene.add(mesh);
  }
  const { camera } = scene;
  const view = new THREE.PerspectiveCamera(camera.fov, IMAGE_WIDTH / IMAGE_HEIGHT, camera.near, camera.far);
  view.position.set(...camera.eye);
  view.up.set(...camera.up);
  view.lookAt(...camera.target);
  renderer.render(threeScene, view);
  const image = pngOf(canvas);
  renderer.dispose();
  renderer.forceContextLoss();
  canvas.remove();
  return image;
}

async function renderDefaultLook(sceneId, variantName) {
  const variant = DEFAULT_LOOK_VARIANTS[variantName];
  if (!variant) throw new Error(`Unknown variant ${variantName}. Pass one of ${Object.keys(DEFAULT_LOOK_VARIANTS).join(', ')}.`);
  const scene = await DEFAULT_LOOK_SCENES[sceneId]();
  const image = variant.engine === 'three' ? drawWithThree(scene, variant) : drawWith67js(scene, variant);
  return { image };
}

window.renderDefaultLook = renderDefaultLook;
