// three.js-shaped names that build 67js parts, materials, cameras and lights.
// It imports neither three.js nor 67js: pass the 67js exports you have to createThreeCompat(core).
//   import * as core from '@codepawlhq/67js';
//   import { loadGltf } from '@codepawlhq/67js/addons/gltf';
//   const THREE = createThreeCompat({ ...core, loadGltf });
// Names it does not support throw an error that names the 67js call to use instead.

const DEGREES_TO_RADIANS = Math.PI / 180;
const WHITE_HEX = 0xffffff;
const FRONT_SIDE = 0;
const BACK_SIDE = 1;
const DOUBLE_SIDE = 2;
const PLANE_THICKNESS = 0.002;

const GUIDE = 'docs/learn/if-you-know-three-js.md';

const UNSUPPORTED = {
  MeshBasicMaterial: 'Use MeshStandardMaterial with emissive and emissiveIntensity (67js: material { color, emission }).',
  MeshLambertMaterial: 'Use MeshStandardMaterial (67js: material { color, metallic: 0, roughness }).',
  MeshPhongMaterial: 'Use MeshStandardMaterial (67js: material { color, metallic, roughness }).',
  MeshNormalMaterial: 'Use MeshStandardMaterial (67js: material { color, metallic, roughness }).',
  ShaderMaterial: '67js has no custom shaders. Use the material fields of materials-and-color (67js: part.material).',
  RawShaderMaterial: '67js has no custom shaders. Use the material fields of materials-and-color (67js: part.material).',
  ConeGeometry: 'Model a cone with createModel() from 67js/addons/model, or use CylinderGeometry with equal radii.',
  CapsuleGeometry: 'Model it with createModel() from 67js/addons/model, or combine CylinderGeometry and SphereGeometry.',
  CircleGeometry: 'Use CylinderGeometry with a small height (67js: cylinder()).',
  IcosahedronGeometry: 'Use SphereGeometry (67js: sphere()).',
  BufferGeometry: 'A part takes a geometry object { positions, normals, indices } (67js: geometry in a part). Build one with box(), sphere(), cylinder(), torus() or createModel().',
  InstancedMesh: 'Give parts the same geometry object: the renderer batches them (67js: Renderer67 with batching: true).',
  SkinnedMesh: 'Load a rigged GLB with GLTFLoader, then drive it with createSkinPose() and updateSkinPose().',
  AnimationMixer: 'Use createAnimationMixer(parts) from 67js.',
  Points: '67js draws triangle parts only. Use small SphereGeometry parts, or the spume addon for particles.',
  Line: '67js draws triangle parts only. Use thin CylinderGeometry parts.',
  LineSegments: '67js draws triangle parts only. Use thin CylinderGeometry parts.',
  Sprite: '67js draws triangle parts only. Use PlaneGeometry with a map.',
  WebGLRenderTarget: 'Renderer67 draws to its canvas. Read it with canvas.toBlob(), or render a PNG with the scene_render_submit tool.',
  EffectComposer: 'Post effects are frame fields: frame.effects with EFFECT_PRESETS and resolveEffects().',
  Fog: 'Set environment { fogColor, fogDensity } on Renderer67.',
  FogExp2: 'Set environment { fogColor, fogDensity } on Renderer67.',
  TextureLoader: 'Load the image yourself and pass new Texture(image) as the map (67js: material.map = { image, colorSpace: "srgb" }).',
  CubeTextureLoader: 'Use createEnvironmentMap() from 67js for image based light.',
  RGBELoader: 'Use createEnvironmentMap() from 67js for image based light.',
  DRACOLoader: 'loadGltf() from 67js/addons/gltf takes decoders in its options.',
  FBXLoader: 'Convert the file to GLB and use loadGltf() from 67js/addons/gltf.',
  OBJLoader: 'Convert the file to GLB and use loadGltf() from 67js/addons/gltf.',
  TransformControls: '67js has no mouse editor. Change part.matrix and call updateParts().',
  DragControls: '67js has no mouse editor. Change part.matrix and call updateParts().',
  TrackballControls: 'Use OrbitControls from this addon, or move frame.eye yourself.',
  FlyControls: 'Use OrbitControls from this addon, or move frame.eye yourself.',
};

const UNSUPPORTED_OPTIONS = {
  MeshStandardMaterial: {
    aoMap: 'Use the occlusionMap field of a 67js material (materials-and-color).',
    envMap: 'Use createEnvironmentMap() and the Renderer67 environment.map option.',
    roughnessMap: 'Use the roughness field, or a glTF with a metallicRoughness map.',
    metalnessMap: 'Use the metalness field, or a glTF with a metallicRoughness map.',
    bumpMap: 'Use normalMap.',
    displacementMap: 'Model the relief in the geometry.',
    wireframe: '67js has no wireframe view.',
    flatShading: 'Use a box() or a geometry with split vertices.',
    vertexColors: 'Give each part its own color.',
  },
};

class CompatError extends Error {
  constructor(message) {
    super(`${message} See ${GUIDE}.`);
    this.name = 'ThreeCompatError';
  }
}

function unsupported(name, replacement) {
  return new CompatError(`THREE.${name} is not supported by 67js three-compat. ${replacement}`);
}

function srgbToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function hexToLinear(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map(value => srgbToLinear(value / 255));
}

class Color {
  constructor(first = WHITE_HEX, green, blue) {
    this.r = 1;
    this.g = 1;
    this.b = 1;
    this.set(first, green, blue);
  }

  set(first, green, blue) {
    if (typeof first === 'number' && green === undefined) {
      [this.r, this.g, this.b] = hexToLinear(first);
    } else if (typeof first === 'string') {
      const digits = first.replace('#', '');
      const expanded = digits.length === 3 ? [...digits].map(digit => digit + digit).join('') : digits;
      if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
        throw new CompatError(`Color "${first}" is not a hex string. Pass 0xRRGGBB, "#rrggbb", or linear red, green and blue numbers (67js: material.color = [r, g, b]).`);
      }
      [this.r, this.g, this.b] = hexToLinear(parseInt(expanded, 16));
    } else if (first instanceof Color) {
      [this.r, this.g, this.b] = [first.r, first.g, first.b];
    } else if (typeof first === 'number') {
      [this.r, this.g, this.b] = [first, green, blue];
    }
    return this;
  }

  setHex(hex) {
    return this.set(hex);
  }

  setRGB(red, green, blue) {
    [this.r, this.g, this.b] = [red, green, blue];
    return this;
  }

  copy(other) {
    return this.set(other);
  }

  clone() {
    return new Color(this);
  }

  toArray() {
    return [this.r, this.g, this.b];
  }
}

function asColor(value) {
  return value instanceof Color ? value : new Color(value);
}

class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set(x, y, z) {
    [this.x, this.y, this.z] = [x, y, z];
    return this;
  }

  setScalar(value) {
    return this.set(value, value, value);
  }

  copy(other) {
    return this.set(other.x, other.y, other.z);
  }

  clone() {
    return new Vector3(this.x, this.y, this.z);
  }

  toArray() {
    return [this.x, this.y, this.z];
  }
}

class Euler extends Vector3 {
  constructor(x = 0, y = 0, z = 0, order = 'XYZ') {
    super(x, y, z);
    if (order !== 'XYZ') throw new CompatError(`Euler order "${order}" is not supported. Use XYZ, or set part.matrix yourself.`);
    this.order = order;
  }
}

class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  set(x, y) {
    [this.x, this.y] = [x, y];
    return this;
  }
}

// Column-major 4x4 products, the layout of part.matrix.
function multiply(left, right) {
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let step = 0; step < 4; step++) sum += left[step * 4 + row] * right[column * 4 + step];
      result[column * 4 + row] = sum;
    }
  }
  return result;
}

function composeMatrix(position, rotation, scale) {
  const [sinX, cosX] = [Math.sin(rotation.x), Math.cos(rotation.x)];
  const [sinY, cosY] = [Math.sin(rotation.y), Math.cos(rotation.y)];
  const [sinZ, cosZ] = [Math.sin(rotation.z), Math.cos(rotation.z)];
  // R = Rx * Ry * Rz, three.js order XYZ.
  const xAxis = [cosY * cosZ, cosX * sinZ + sinX * sinY * cosZ, sinX * sinZ - cosX * sinY * cosZ];
  const yAxis = [-cosY * sinZ, cosX * cosZ - sinX * sinY * sinZ, sinX * cosZ + cosX * sinY * sinZ];
  const zAxis = [sinY, -sinX * cosY, cosX * cosY];
  return new Float32Array([
    ...xAxis.map(value => value * scale.x), 0,
    ...yAxis.map(value => value * scale.y), 0,
    ...zAxis.map(value => value * scale.z), 0,
    position.x, position.y, position.z, 1,
  ]);
}

function transformPoint(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

class Object3D {
  constructor() {
    this.name = '';
    this.visible = true;
    this.children = [];
    this.parent = null;
    this.position = new Vector3();
    this.rotation = new Euler();
    this.scale = new Vector3(1, 1, 1);
    this.up = new Vector3(0, 1, 0);
    this.lookAtPoint = null;
  }

  add(...objects) {
    for (const object of objects) {
      if (!(object instanceof Object3D)) throw new CompatError('add() takes objects made by this addon (Group, Mesh, lights, cameras).');
      object.parent?.remove(object);
      object.parent = this;
      this.children.push(object);
    }
    return this;
  }

  remove(...objects) {
    for (const object of objects) {
      const index = this.children.indexOf(object);
      if (index >= 0) {
        this.children.splice(index, 1);
        object.parent = null;
      }
    }
    return this;
  }

  lookAt(x, y, z) {
    this.lookAtPoint = x instanceof Vector3 ? x.toArray() : [x, y, z];
    return this;
  }

  localMatrix() {
    return composeMatrix(this.position, this.rotation, this.scale);
  }

  worldMatrix() {
    const local = this.localMatrix();
    return this.parent ? multiply(this.parent.worldMatrix(), local) : local;
  }

  worldPosition() {
    return transformPoint(this.worldMatrix(), 0, 0, 0);
  }
}

class Group extends Object3D {}

class Scene extends Object3D {
  constructor() {
    super();
    this.background = null;
  }
}

const geometrySymbol = Symbol('geometry');

export function createThreeCompat(core) {
  for (const name of ['Renderer67', 'box', 'sphere', 'cylinder', 'torus']) {
    if (typeof core?.[name] !== 'function') {
      throw new TypeError(`createThreeCompat needs the 67js export ${name}. Pass { ...core } from import * as core from '@codepawlhq/67js'.`);
    }
  }
  const shapeCache = new Map();

  function shared(key, build) {
    if (!shapeCache.has(key)) shapeCache.set(key, build());
    return shapeCache.get(key);
  }

  class BoxGeometry {
    constructor(width = 1, height = 1, depth = 1) {
      this[geometrySymbol] = { build: () => shared('box', () => core.box(0)), scale: [width, height, depth] };
    }
  }

  class PlaneGeometry {
    constructor(width = 1, height = 1) {
      this[geometrySymbol] = { build: () => shared('plane', () => core.box(0)), scale: [width, height, PLANE_THICKNESS] };
    }
  }

  class SphereGeometry {
    constructor(radius = 1, widthSegments = 32, heightSegments = 16) {
      this[geometrySymbol] = {
        build: () => shared(`sphere:${widthSegments}:${heightSegments}`, () => core.sphere(widthSegments, heightSegments)),
        scale: [radius, radius, radius],
      };
    }
  }

  class CylinderGeometry {
    constructor(radiusTop = 1, radiusBottom = 1, height = 1, radialSegments = 32) {
      if (radiusTop !== radiusBottom) {
        throw unsupported('CylinderGeometry with different radii', 'Use equal radii, or model a cone with createModel() from 67js/addons/model.');
      }
      this[geometrySymbol] = {
        build: () => shared(`cylinder:${radialSegments}`, () => core.cylinder(radialSegments)),
        scale: [radiusTop, height, radiusTop],
      };
    }
  }

  class TorusGeometry {
    constructor(radius = 1, tube = 0.4, radialSegments = 12, tubularSegments = 48) {
      const tubeRatio = tube / radius;
      this[geometrySymbol] = {
        build: () => shared(`torus:${tubeRatio}:${tubularSegments}:${radialSegments}`, () => core.torus(tubeRatio, tubularSegments, radialSegments)),
        scale: [radius, radius, radius],
      };
    }
  }

  class Texture {
    constructor(image, colorSpace = 'srgb') {
      this.image = image;
      this.colorSpace = colorSpace;
    }
  }

  class CanvasTexture extends Texture {}

  function textureDescriptor(texture, colorSpace) {
    if (!(texture instanceof Texture)) {
      throw new CompatError('A map must be a THREE.Texture or THREE.CanvasTexture made by this addon (67js: material.map = { image, colorSpace }).');
    }
    return { image: texture.image, colorSpace };
  }

  class MeshStandardMaterial {
    constructor(parameters = {}) {
      const rejected = UNSUPPORTED_OPTIONS[new.target.name === 'MeshPhysicalMaterial' ? 'MeshStandardMaterial' : new.target.name] ?? {};
      for (const option of Object.keys(parameters)) {
        if (rejected[option]) throw unsupported(`${new.target.name} option "${option}"`, rejected[option]);
      }
      this.color = asColor(parameters.color ?? WHITE_HEX);
      this.metalness = parameters.metalness ?? 0;
      this.roughness = parameters.roughness ?? 1;
      this.emissive = asColor(parameters.emissive ?? 0x000000);
      this.emissiveIntensity = parameters.emissiveIntensity ?? 1;
      this.map = parameters.map ?? null;
      this.normalMap = parameters.normalMap ?? null;
      this.normalScale = parameters.normalScale ?? new Vector2(1, 1);
      this.opacity = parameters.opacity ?? 1;
      this.transparent = parameters.transparent ?? false;
      this.alphaTest = parameters.alphaTest ?? 0;
      this.side = parameters.side ?? FRONT_SIDE;
    }

    toMaterial() {
      if (this.side === BACK_SIDE) throw unsupported('BackSide', 'Use DoubleSide (67js: material.doubleSided = true).');
      const isEmissive = this.emissive.r + this.emissive.g + this.emissive.b > 0;
      const material = {
        color: this.color.toArray(),
        metallic: this.metalness,
        roughness: this.roughness,
      };
      if (isEmissive) {
        material.emission = this.emissiveIntensity;
        material.emissiveColor = this.emissive.toArray();
      }
      if (this.map) material.map = textureDescriptor(this.map, 'srgb');
      if (this.normalMap) {
        material.normalMap = textureDescriptor(this.normalMap, 'linear');
        material.normalScale = this.normalScale.x;
      }
      if (this.alphaTest > 0) {
        material.alphaMode = 'mask';
        material.alphaCutoff = this.alphaTest;
      } else if (this.transparent) {
        material.alphaMode = 'blend';
      }
      if (this.opacity !== 1) material.opacity = this.opacity;
      if (this.side === DOUBLE_SIDE) material.doubleSided = true;
      return material;
    }
  }

  const PHYSICAL_FIELDS = ['clearcoat', 'clearcoatRoughness', 'transmission', 'thickness', 'ior', 'specularIntensity', 'iridescence', 'sheenRoughness', 'anisotropy'];
  const PHYSICAL_FIELD_NAMES = { specularIntensity: 'specular' };

  class MeshPhysicalMaterial extends MeshStandardMaterial {
    constructor(parameters = {}) {
      super(parameters);
      for (const field of PHYSICAL_FIELDS) this[field] = parameters[field];
    }

    toMaterial() {
      const material = super.toMaterial();
      for (const field of PHYSICAL_FIELDS) {
        if (this[field] !== undefined) material[PHYSICAL_FIELD_NAMES[field] ?? field] = this[field];
      }
      return material;
    }
  }

  class Mesh extends Object3D {
    constructor(geometry, material = new MeshStandardMaterial()) {
      super();
      if (!geometry?.[geometrySymbol]) {
        throw new CompatError('Mesh needs BoxGeometry, SphereGeometry, CylinderGeometry, TorusGeometry or PlaneGeometry (67js: box(), sphere(), cylinder(), torus()).');
      }
      if (!(material instanceof MeshStandardMaterial)) {
        throw new CompatError('Mesh needs MeshStandardMaterial or MeshPhysicalMaterial (67js: a material { color, metallic, roughness }).');
      }
      this.geometry = geometry;
      this.material = material;
    }
  }

  class PerspectiveCamera extends Object3D {
    constructor(fov = 50, aspect = 1, near = 0.1, far = 2000) {
      super();
      Object.assign(this, { fov, aspect, near, far, isPerspectiveCamera: true });
    }

    updateProjectionMatrix() {}
  }

  class OrthographicCamera extends Object3D {
    constructor(left = -1, right = 1, top = 1, bottom = -1, near = 0.1, far = 2000) {
      super();
      Object.assign(this, { left, right, top, bottom, near, far, zoom: 1, isOrthographicCamera: true });
    }

    updateProjectionMatrix() {}
  }

  class Light extends Object3D {
    constructor(color = WHITE_HEX, intensity = 1) {
      super();
      this.color = asColor(color);
      this.intensity = intensity;
      this.target = new Object3D();
    }

    targetPoint() {
      return this.lookAtPoint ?? this.target.worldPosition();
    }
  }

  class AmbientLight extends Light {}
  class HemisphereLight extends Light {
    constructor(skyColor = WHITE_HEX, groundColor = 0x000000, intensity = 1) {
      super(skyColor, intensity);
    }
  }
  class DirectionalLight extends Light {}
  class PointLight extends Light {
    constructor(color, intensity, distance = 0) {
      super(color, intensity);
      this.distance = distance;
    }
  }
  class SpotLight extends Light {
    constructor(color, intensity, distance = 0, angle = Math.PI / 3, penumbra = 0) {
      super(color, intensity);
      Object.assign(this, { distance, angle, penumbra });
    }
  }
  class RectAreaLight extends Light {
    constructor(color, intensity, width = 10, height = 10) {
      super(color, intensity);
      Object.assign(this, { width, height });
    }
  }

  function traverse(object, visit) {
    if (!object.visible) return;
    visit(object);
    for (const child of object.children) traverse(child, visit);
  }

  function colorOrUndefined(color) {
    return color.r === 1 && color.g === 1 && color.b === 1 ? undefined : color.toArray();
  }

  function withoutUndefined(fields) {
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  }

  function environmentFor(lights, scene) {
    const environment = {};
    const background = scene.background instanceof Color ? scene.background.toArray() : null;
    if (background) {
      environment.skyTop = background;
      environment.skyBottom = background;
    }
    if (lights.length === 0) return environment;
    // A three.js scene is dark until it has lights, so the studio rig is switched off once the scene brings its own.
    Object.assign(environment, { keyIntensity: 0, fillIntensity: 0, ambientIntensity: 0, pointLights: [], spotLights: [], areaLights: [] });
    for (const light of lights) {
      const position = light.worldPosition();
      if (light instanceof AmbientLight || light instanceof HemisphereLight) {
        environment.ambientIntensity += light.intensity;
      } else if (light instanceof DirectionalLight) {
        const direction = subtract(position, light.targetPoint());
        Object.assign(environment, withoutUndefined({ keyIntensity: light.intensity, lightDirection: direction, keyColor: colorOrUndefined(light.color) }));
      } else if (light instanceof PointLight) {
        environment.pointLights.push(withoutUndefined({
          position, color: light.color.toArray(), intensity: light.intensity, range: light.distance > 0 ? light.distance : undefined,
        }));
      } else if (light instanceof SpotLight) {
        environment.spotLights.push(withoutUndefined({
          position,
          direction: subtract(light.targetPoint(), position),
          angle: light.angle,
          penumbra: light.penumbra,
          color: light.color.toArray(),
          intensity: light.intensity,
          range: light.distance > 0 ? light.distance : undefined,
        }));
      } else if (light instanceof RectAreaLight) {
        environment.areaLights.push({
          position, direction: subtract(light.targetPoint(), position), width: light.width, height: light.height,
          color: light.color.toArray(), intensity: light.intensity,
        });
      }
    }
    return environment;
  }

  function cameraFrame(camera) {
    if (!(camera instanceof PerspectiveCamera || camera instanceof OrthographicCamera)) {
      throw new CompatError('render() needs a PerspectiveCamera or OrthographicCamera from this addon (67js: renderer.render({ eye, target, fov })).');
    }
    const matrix = camera.worldMatrix();
    const eye = transformPoint(matrix, 0, 0, 0);
    const target = camera.lookAtPoint ?? transformPoint(matrix, 0, 0, -1);
    const frame = { eye, target, up: camera.up.toArray(), near: camera.near, far: camera.far };
    if (camera instanceof PerspectiveCamera) {
      frame.fov = camera.fov;
    } else {
      frame.projection = 'orthographic';
      frame.orthographicHeight = (camera.top - camera.bottom) / camera.zoom;
    }
    return frame;
  }

  /** Walk a scene and return what Renderer67 draws: the parts, the environment of its lights and a frame from the camera. */
  function collectScene(scene, camera) {
    if (!(scene instanceof Scene)) throw new CompatError('render() needs a THREE.Scene from this addon.');
    const parts = [];
    const lights = [];
    traverse(scene, object => {
      if (object instanceof Light) {
        lights.push(object);
      } else if (object instanceof Mesh) {
        const { build, scale } = object.geometry[geometrySymbol];
        const sizing = composeMatrix({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: scale[0], y: scale[1], z: scale[2] });
        parts.push({
          name: `${object.name || 'mesh'}-${parts.length}`,
          geometry: build(),
          matrix: multiply(object.worldMatrix(), sizing),
          material: object.material.toMaterial(),
        });
      } else if (object.loadedParts) {
        const world = object.worldMatrix();
        for (const loaded of object.loadedParts) {
          parts.push({ ...loaded, name: `${object.name || 'gltf'}-${loaded.name}`, matrix: multiply(world, loaded.matrix) });
        }
      }
    });
    return { parts, environment: environmentFor(lights, scene), frame: cameraFrame(camera) };
  }

  class WebGLRenderer {
    constructor(parameters = {}) {
      if (!parameters.canvas) throw new CompatError('WebGLRenderer needs { canvas } (67js: new Renderer67(canvas, parts)).');
      this.domElement = parameters.canvas;
      this.antialias = parameters.antialias ?? true;
      this.pixelRatio = 1.5;
      this.shadowMap = { enabled: true, type: undefined };
      this.clearColor = null;
      this.renderer67 = null;
      this.structure = null;
      this.geometries = new Map();
      this.loopHandle = null;
    }

    setSize(width, height) {
      this.domElement.style.width = `${width}px`;
      this.domElement.style.height = `${height}px`;
      this.renderer67?.resize();
    }

    setPixelRatio(ratio) {
      this.pixelRatio = ratio;
    }

    setClearColor(color) {
      this.clearColor = asColor(color);
    }

    render(scene, camera) {
      const { parts, environment, frame } = collectScene(scene, camera);
      if (!scene.background && this.clearColor) {
        environment.skyTop = this.clearColor.toArray();
        environment.skyBottom = this.clearColor.toArray();
      }
      const key = this.structureKey(parts);
      if (!this.renderer67 || key !== this.structure) {
        this.renderer67?.dispose();
        this.renderer67 = new core.Renderer67(this.domElement, parts, {
          ground: false, samples: this.antialias ? 4 : 1, pixelRatio: this.pixelRatio, environment,
        });
        this.structure = key;
      } else {
        this.renderer67.updateParts(parts);
      }
      this.renderer67.resize();
      this.renderer67.render({ ...frame, environment });
    }

    structureKey(parts) {
      for (const part of parts) {
        if (!this.geometries.has(part.geometry)) this.geometries.set(part.geometry, this.geometries.size);
      }
      return parts.map(part => [
        part.name, this.geometries.get(part.geometry), part.material.alphaMode ?? '', part.material.doubleSided ?? '',
        part.material.map ? 'map' : '', part.material.normalMap ? 'normal' : '',
      ].join('|')).join('\n');
    }

    setAnimationLoop(callback) {
      if (this.loopHandle !== null) globalThis.cancelAnimationFrame(this.loopHandle);
      this.loopHandle = null;
      if (!callback) return;
      const step = time => {
        callback(time);
        this.loopHandle = globalThis.requestAnimationFrame(step);
      };
      this.loopHandle = globalThis.requestAnimationFrame(step);
    }

    dispose() {
      this.setAnimationLoop(null);
      this.renderer67?.dispose();
      this.renderer67 = null;
    }
  }

  class Clock {
    constructor(autoStart = true) {
      this.startTime = autoStart ? performance.now() : null;
      this.previousTime = this.startTime;
      this.elapsedTime = 0;
    }

    getDelta() {
      const now = performance.now();
      this.startTime ??= now;
      this.previousTime ??= now;
      const delta = (now - this.previousTime) / 1000;
      this.previousTime = now;
      this.elapsedTime += delta;
      return delta;
    }

    getElapsedTime() {
      this.getDelta();
      return this.elapsedTime;
    }
  }

  class OrbitControls {
    constructor(camera, domElement) {
      this.object = camera;
      this.domElement = domElement;
      this.target = new Vector3();
      this.enableDamping = false;
      this.enabled = true;
      this.onChange = null;
      const offset = subtract(camera.worldPosition(), this.target.toArray());
      this.distance = Math.hypot(...offset);
      this.yaw = Math.atan2(offset[0], offset[2]);
      this.pitch = Math.asin(offset[1] / (this.distance || 1));
      domElement.style.touchAction = 'none';
      domElement.addEventListener('pointerdown', event => domElement.setPointerCapture?.(event.pointerId));
      domElement.addEventListener('pointermove', event => {
        if (!this.enabled || !domElement.hasPointerCapture?.(event.pointerId)) return;
        this.rotate(-event.movementX * 0.01, event.movementY * 0.01);
      });
      domElement.addEventListener('wheel', event => {
        event.preventDefault();
        this.distance = Math.min(1000, Math.max(0.01, this.distance * Math.exp(event.deltaY * 0.001)));
        this.update();
      }, { passive: false });
    }

    rotate(yawChange, pitchChange) {
      this.yaw += yawChange;
      this.pitch = Math.min(1.5, Math.max(-1.5, this.pitch + pitchChange));
      this.update();
    }

    update() {
      const flat = Math.cos(this.pitch) * this.distance;
      this.object.position.set(
        this.target.x + Math.sin(this.yaw) * flat,
        this.target.y + Math.sin(this.pitch) * this.distance,
        this.target.z + Math.cos(this.yaw) * flat,
      );
      this.object.lookAt(this.target.x, this.target.y, this.target.z);
      this.onChange?.();
      return true;
    }

    dispose() {}
  }

  class GLTFLoader {
    async loadAsync(url, onProgress) {
      if (typeof core.loadGltf !== 'function') {
        throw new CompatError('GLTFLoader needs loadGltf. Pass createThreeCompat({ ...core, loadGltf }) with loadGltf from 67js/addons/gltf.');
      }
      const asset = await core.loadGltf(url);
      onProgress?.({ loaded: 1, total: 1 });
      const scene = new Group();
      scene.loadedParts = asset.parts;
      return { scene, scenes: [scene], animations: asset.animations ?? [], asset };
    }

    load(url, onLoad, onProgress, onError) {
      this.loadAsync(url, onProgress).then(onLoad, onError ?? (error => { throw error; }));
    }
  }

  const exported = {
    Color, Vector2, Vector3, Euler, Object3D, Group, Scene, Mesh, Clock,
    BoxGeometry, PlaneGeometry, SphereGeometry, CylinderGeometry, TorusGeometry,
    Texture, CanvasTexture, MeshStandardMaterial, MeshPhysicalMaterial,
    PerspectiveCamera, OrthographicCamera,
    AmbientLight, HemisphereLight, DirectionalLight, PointLight, SpotLight, RectAreaLight,
    WebGLRenderer, OrbitControls, GLTFLoader,
    FrontSide: FRONT_SIDE, BackSide: BACK_SIDE, DoubleSide: DOUBLE_SIDE,
    collectScene,
  };

  return new Proxy(exported, {
    get(target, name) {
      if (typeof name === 'string' && !(name in target)) {
        if (UNSUPPORTED[name]) throw unsupported(name, UNSUPPORTED[name]);
        if (/^[A-Z]/.test(name)) throw unsupported(name, 'It is not part of the common subset. Build the 67js part, material, camera or light directly.');
      }
      return target[name];
    },
  });
}

export const unsupportedNames = Object.freeze(Object.keys(UNSUPPORTED));
