// One adapter per engine. Each uses the engine's normal path for the job, and draws the same data with the same lights.
import {
  AmbientLight, AnimationMixer, BufferAttribute, BufferGeometry, Color, CustomToneMapping,
  DirectionalLight, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, PerspectiveCamera, PointLight, Scene,
  ShaderChunk, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { Renderer67 } from '/src/renderer.js';
import { createEnvironmentMap } from '/src/hdri.js';
import { parseGltf } from '/src/gltf.js';
import { generateGeometryLods } from '/src/mesh-lod.js';

const AMBIENT_RADIANCE = 0.3;
const SECONDS_PER_CHARACTER_OFFSET = 0.4;

function acesLikeEngine(value) {
  return (value * (2.51 * value + 0.03)) / (value * (2.43 * value + 0.59) + 0.14);
}

// three.js has its own ACES curve. This gives it the curve in src/post.js, so the pictures can be compared.
function installSharedToneCurve() {
  const pattern = /vec3 CustomToneMapping\( vec3 color \) \{ return color; \}/;
  if (!pattern.test(ShaderChunk.tonemapping_pars_fragment)) return;
  ShaderChunk.tonemapping_pars_fragment = ShaderChunk.tonemapping_pars_fragment.replace(
    pattern,
    'vec3 CustomToneMapping( vec3 color ) { return saturate( ( color * ( 2.51 * color + 0.03 ) ) / ( color * ( 2.43 * color + 0.59 ) + 0.14 ) ); }',
  );
}

function engineMaterial(material) {
  const { opacity, ...rest } = material;
  return { tag: 'surface', emission: 0, ...rest, ...(opacity === undefined ? {} : { alphaMode: 'blend', opacity }) };
}

// The options turn culling and level selection off one at a time, so each one's share of a measured gain can be told apart.
function levelsForScene(scene) {
  const levels = new Map();
  for (const [name, ratios] of Object.entries(scene.lods ?? {})) levels.set(name, generateGeometryLods(scene.geometries[name], { ratios }));
  return levels;
}

export async function create67Adapter(canvas, scene, characters, { culling = true, lods = true, hdr = true, samples = 4, shading = 'full', checks = true } = {}) {
  const environment = {
    world: true, fillIntensity: 0, ambientIntensity: 1, fogDensity: 0,
    lightDirection: scene.sun.direction, keyColor: scene.sun.color,
    pointLights: scene.pointLights.map(light => ({ ...light, radius: 0.05 })),
    map: createEnvironmentMap({
      width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(AMBIENT_RADIANCE), showBackground: true,
    }),
  };
  const lodsByGeometry = lods ? levelsForScene(scene) : new Map();
  const parts = scene.objects.map((object, index) => ({
    name: `object-${index}`, geometry: scene.geometries[object.geometry], matrix: object.matrix, material: engineMaterial(object.material),
    ...(lodsByGeometry.has(object.geometry) ? { lods: lodsByGeometry.get(object.geometry) } : {}),
  }));
  const assets = [];
  if (characters) {
    const bytes = await (await fetch(characters.url)).arrayBuffer();
    for (let index = 0; index < characters.count; index++) {
      const asset = await parseGltf(bytes.slice(0));
      assets.push(asset);
      parts.push(...asset.parts);
    }
  }
  const shadowBounds = scene.shadowExtent
    ? { eye: scene.sun.direction.map(value => value * 5), target: [0, 0, 0], up: [0, 1, 0], extent: scene.shadowExtent, near: 0.1, far: 150 }
    : {};
  const renderer = new Renderer67(canvas, parts, {
    ground: false, hdr, depth: false, samples, pixelRatio: 1, memoryBudgetMiB: 2048, world: true, environment, shadowBounds, culling, shading,
  });
  renderer.resize();
  const frame = { eye: scene.camera.eye, target: scene.camera.target, up: [0, 1, 0], fov: scene.camera.fov, near: scene.camera.near, far: scene.camera.far, environment, time: 0, exposure: 1, effects: {} };
  return {
    context: renderer.context,
    memoryReport: () => renderer.memoryReport(),
    // Time spent in renderer.updateParts after animation, so the update splits into posing and upload.
    updatePartsTimes: [],
    update(time) {
      if (scene.update) {
        scene.update(time);
        renderer.updateParts(parts);
      }
      if (assets.length) {
        assets.forEach((asset, index) => asset.applyAnimation(time + index * SECONDS_PER_CHARACTER_OFFSET, 0, { checks }));
        const beforeUpload = performance.now();
        renderer.updateParts(parts, { checks });
        this.updatePartsTimes.push(performance.now() - beforeUpload);
      }
    },
    render() {
      renderer.render(frame);
    },
    dispose() {
      renderer.dispose();
    },
  };
}

function threeGeometry(source) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(source.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(source.normals, 3));
  geometry.setIndex(new BufferAttribute(source.indices, 1));
  return geometry;
}

function threeMaterial(material) {
  const transparent = material.opacity !== undefined;
  const color = new Color().setRGB(...material.color);
  return new MeshStandardMaterial({
    color, metalness: material.metallic, roughness: material.roughness, transparent, opacity: material.opacity ?? 1, depthWrite: !transparent,
  });
}

function addThreeLights(threeScene, scene) {
  threeScene.add(new AmbientLight(0xffffff, Math.PI * AMBIENT_RADIANCE));
  const strength = Math.max(...scene.sun.color);
  if (strength > 0) {
    const sun = new DirectionalLight(new Color().setRGB(...scene.sun.color.map(value => value / strength)), strength);
    sun.position.set(...scene.sun.direction);
    if (scene.shadowExtent) {
      sun.position.set(...scene.sun.direction.map(value => value * 5));
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      Object.assign(sun.shadow.camera, { left: -scene.shadowExtent, right: scene.shadowExtent, top: scene.shadowExtent, bottom: -scene.shadowExtent, near: 0.1, far: 150 });
    }
    threeScene.add(sun);
  }
  for (const light of scene.pointLights) {
    const point = new PointLight(new Color().setRGB(...light.color), light.intensity, 0, 2);
    point.position.set(...light.position);
    threeScene.add(point);
  }
}

function addIndividualMeshes(threeScene, scene) {
  const geometries = Object.fromEntries(Object.entries(scene.geometries).map(([name, source]) => [name, threeGeometry(source)]));
  const materials = new Map();
  const meshes = new Map();
  for (const object of scene.objects) {
    if (!materials.has(object.material)) materials.set(object.material, threeMaterial(object.material));
    const mesh = new Mesh(geometries[object.geometry], materials.get(object.material));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.fromArray(object.matrix);
    mesh.castShadow = Boolean(scene.shadowExtent);
    mesh.receiveShadow = Boolean(scene.shadowExtent);
    threeScene.add(mesh);
    meshes.set(object, mesh);
  }
  return meshes;
}

function addInstancedMesh(threeScene, scene) {
  const [first] = scene.objects;
  const mesh = new InstancedMesh(threeGeometry(scene.geometries[first.geometry]), threeMaterial(first.material), scene.objects.length);
  const matrix = new Matrix4();
  scene.objects.forEach((object, index) => mesh.setMatrixAt(index, matrix.fromArray(object.matrix)));
  threeScene.add(mesh);
}

export async function createThreeAdapter(canvas, scene, characters, { instanced = false, antialias = true } = {}) {
  installSharedToneCurve();
  const renderer = new WebGLRenderer({ canvas, antialias });
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.toneMapping = CustomToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = Boolean(scene.shadowExtent);
  const tonedBackground = acesLikeEngine(AMBIENT_RADIANCE) ** (1 / 2.2);
  renderer.setClearColor(new Color().setRGB(tonedBackground, tonedBackground, tonedBackground, SRGBColorSpace));
  const threeScene = new Scene();
  addThreeLights(threeScene, scene);
  const meshes = instanced ? new Map() : addIndividualMeshes(threeScene, scene);
  if (instanced) addInstancedMesh(threeScene, scene);
  const mixers = [];
  if (characters) {
    const gltf = await new GLTFLoader().loadAsync(characters.url);
    for (let index = 0; index < characters.count; index++) {
      const copy = cloneSkeleton(gltf.scene);
      copy.traverse(node => {
        node.castShadow = node.isMesh === true;
      });
      threeScene.add(copy);
      const mixer = new AnimationMixer(copy);
      mixer.clipAction(gltf.animations[0]).play();
      mixers.push(mixer);
    }
  }
  const camera = new PerspectiveCamera(scene.camera.fov, canvas.clientWidth / canvas.clientHeight, scene.camera.near, scene.camera.far);
  camera.position.set(...scene.camera.eye);
  camera.lookAt(new Vector3(...scene.camera.target));
  return {
    context: renderer.getContext(),
    update(time) {
      if (scene.update) {
        scene.update(time);
        for (const [object, mesh] of meshes) mesh.matrix.fromArray(object.matrix);
      }
      mixers.forEach((mixer, index) => mixer.setTime(time + index * SECONDS_PER_CHARACTER_OFFSET));
    },
    render() {
      renderer.render(threeScene, camera);
    },
    dispose() {
      renderer.dispose();
    },
  };
}

