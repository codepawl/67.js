// Twelve scenes written the way a model writes three.js from memory. The Node tests build each one and check the parts,
// and the render test draws each one in Chrome. Each snippet gets THREE (the addon), a canvas and a helper that makes a
// small checkerboard picture, and returns what to draw.

const GLB_URL = new URL('../RobotExpressive.glb', import.meta.url).href;

function lookingAt(camera, x, y, z) {
  camera.lookAt(x, y, z);
  return camera;
}

function floor(THREE, color = 0x303844) {
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshStandardMaterial({ color, roughness: 0.9 }));
  plane.rotation.x = -Math.PI / 2;
  return plane;
}

export const snippets = [
  {
    name: 'lit box',
    build(THREE) {
      const scene = new THREE.Scene();
      const camera = lookingAt(new THREE.PerspectiveCamera(45, 1, 0.1, 100), 0, 0.5, 0);
      camera.position.set(3, 2.2, 4);
      const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x2f9e6b, roughness: 0.5 }));
      cube.position.y = 0.5;
      const sun = new THREE.DirectionalLight(0xffffff, 3);
      sun.position.set(4, 6, 3);
      scene.add(floor(THREE), cube, sun, new THREE.AmbientLight(0xffffff, 0.4));
      return { scene, camera };
    },
  },
  {
    name: 'metal sphere under a point light',
    build(THREE) {
      const scene = new THREE.Scene();
      const camera = lookingAt(new THREE.PerspectiveCamera(50, 1, 0.1, 100), 0, 0.8, 0);
      camera.position.set(0, 1.5, 4);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.8, 48, 24), new THREE.MeshStandardMaterial({ color: 0xffb86c, metalness: 1, roughness: 0.25 }));
      ball.position.y = 0.8;
      const lamp = new THREE.PointLight(0xfff0dd, 30, 12);
      lamp.position.set(1.5, 3, 2);
      scene.add(floor(THREE), ball, lamp, new THREE.AmbientLight(0xffffff, 0.3));
      return { scene, camera };
    },
  },
  {
    name: 'group of a cylinder and a torus',
    build(THREE) {
      const scene = new THREE.Scene();
      const camera = lookingAt(new THREE.PerspectiveCamera(45, 1, 0.1, 100), 0, 0.6, 0);
      camera.position.set(3, 2, 4);
      const group = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.2, 32), new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.4 }));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.12, 16, 64), new THREE.MeshStandardMaterial({ color: 0xcc3355, roughness: 0.3 }));
      post.position.y = 0.6;
      ring.position.y = 1.4;
      ring.rotation.x = Math.PI / 2;
      group.add(post, ring);
      group.rotation.y = 0.5;
      scene.add(floor(THREE), group, new THREE.HemisphereLight(0xffffff, 0x444444, 1.2), new THREE.DirectionalLight(0xffffff, 2.5));
      return { scene, camera };
    },
  },
  {
    name: 'textured mesh',
    build(THREE, { checkerboard }) {
      const scene = new THREE.Scene();
      const camera = lookingAt(new THREE.PerspectiveCamera(45, 1, 0.1, 100), 0, 0.8, 0);
      camera.position.set(2.5, 2, 3.5);
      const texture = new THREE.CanvasTexture(checkerboard());
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.9, 48, 24), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.6 }));
      ball.position.y = 0.9;
      const sun = new THREE.DirectionalLight(0xffffff, 3);
      sun.position.set(3, 5, 4);
      scene.add(floor(THREE), ball, sun, new THREE.AmbientLight(0xffffff, 0.5));
      return { scene, camera };
    },
  },
  {
    name: 'loaded GLB',
    browserOnly: true,
    async build(THREE) {
      const scene = new THREE.Scene();
      const camera = lookingAt(new THREE.PerspectiveCamera(40, 1, 0.1, 200), 0, 1.5, 0);
      camera.position.set(6, 4, 9);
      const gltf = await new THREE.GLTFLoader().loadAsync(GLB_URL);
      scene.add(gltf.scene, new THREE.HemisphereLight(0xffffff, 0x555555, 1.5), new THREE.DirectionalLight(0xffffff, 3));
      return { scene, camera };
    },
  },
  {
    name: 'orbiting camera',
    build(THREE, { canvas }) {
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
      camera.position.set(0, 2, 5);
      const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x4488ff, roughness: 0.4 }));
      cube.position.y = 0.5;
      const controls = new THREE.OrbitControls(camera, canvas);
      controls.target.set(0, 0.5, 0);
      controls.rotate(0.8, 0.1);
      scene.add(floor(THREE), cube, new THREE.AmbientLight(0xffffff, 0.5), new THREE.DirectionalLight(0xffffff, 3));
      return { scene, camera };
    },
  },
  {
    name: 'light rig with spot, point and area lights',
    build(THREE) {
      const scene = new THREE.Scene();
      const camera = lookingAt(new THREE.PerspectiveCamera(50, 1, 0.1, 100), 0, 0.5, 0);
      camera.position.set(0, 2.5, 5);
      const statue = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.5, 32), new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.5 }));
      statue.position.y = 0.75;
      const spot = new THREE.SpotLight(0xffffff, 80, 15, Math.PI / 5, 0.4);
      spot.position.set(-3, 4, 3);
      spot.target.position.set(0, 0.7, 0);
      const warm = new THREE.PointLight(0xff8844, 20, 10);
      warm.position.set(2.5, 1.5, 1);
      const panel = new THREE.RectAreaLight(0x88aaff, 20, 3, 2);
      panel.position.set(0, 3, -2);
      panel.lookAt(0, 0.7, 0);
      scene.add(floor(THREE), statue, spot, warm, panel);
      return { scene, camera };
    },
  },
  {
    name: 'orthographic camera',
    build(THREE) {
      const scene = new THREE.Scene();
      const camera = lookingAt(new THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 100), 0, 0.5, 0);
      camera.position.set(5, 5, 5);
      const cube = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1, 1), new THREE.MeshStandardMaterial({ color: 0xe0a030, roughness: 0.5 }));
      cube.position.y = 0.5;
      scene.add(floor(THREE), cube, new THREE.AmbientLight(0xffffff, 0.5), new THREE.DirectionalLight(0xffffff, 3));
      return { scene, camera };
    },
  },
  {
    name: 'physical material with a clear coat',
    build(THREE) {
      const scene = new THREE.Scene();
      const camera = lookingAt(new THREE.PerspectiveCamera(45, 1, 0.1, 100), 0, 0.7, 0);
      camera.position.set(2.5, 1.8, 3.5);
      const paint = new THREE.MeshPhysicalMaterial({ color: 0xaa1122, metalness: 0.6, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.05 });
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.8, 48, 24), paint);
      ball.position.y = 0.8;
      scene.add(floor(THREE), ball, new THREE.AmbientLight(0xffffff, 0.4), new THREE.DirectionalLight(0xffffff, 3));
      return { scene, camera };
    },
  },
  {
    name: 'transparent and emissive parts',
    build(THREE) {
      const scene = new THREE.Scene();
      const camera = lookingAt(new THREE.PerspectiveCamera(45, 1, 0.1, 100), 0, 0.6, 0);
      camera.position.set(2.5, 2, 4);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ color: 0x66ccff, transparent: true, opacity: 0.4, roughness: 0.1 }));
      glass.position.y = 0.6;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.25, 24, 12), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffaa33, emissiveIntensity: 4 }));
      bulb.position.set(0, 0.6, 0);
      scene.add(floor(THREE), glass, bulb, new THREE.AmbientLight(0xffffff, 0.5), new THREE.DirectionalLight(0xffffff, 2.5));
      return { scene, camera };
    },
  },
  {
    name: 'animation loop',
    loop: true,
    build(THREE) {
      const scene = new THREE.Scene();
      const camera = lookingAt(new THREE.PerspectiveCamera(45, 1, 0.1, 100), 0, 0.5, 0);
      camera.position.set(3, 2.2, 4);
      const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x2f9e6b, roughness: 0.5 }));
      cube.position.y = 0.5;
      scene.add(floor(THREE), cube, new THREE.AmbientLight(0xffffff, 0.5), new THREE.DirectionalLight(0xffffff, 3));
      return { scene, camera, animate: () => { cube.rotation.y += 0.3; } };
    },
  },
  {
    name: 'nested groups, scale and a background',
    build(THREE) {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x203050);
      const camera = lookingAt(new THREE.PerspectiveCamera(45, 1, 0.1, 100), 0, 1, 0);
      camera.position.set(4, 3, 6);
      const outer = new THREE.Group();
      const inner = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xff6644, roughness: 0.5 }));
      inner.position.set(1, 0, 0);
      inner.scale.set(1.5, 1.5, 1.5);
      box.position.y = 0.5;
      inner.add(box);
      outer.add(inner);
      outer.rotation.y = 0.6;
      scene.add(floor(THREE), outer, new THREE.AmbientLight(0xffffff, 0.6), new THREE.DirectionalLight(0xffffff, 3));
      return { scene, camera };
    },
  },
];
