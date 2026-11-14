import { CrucibleRenderer, groupParts } from './renderer.js';
import { benchmarkVertexShader, benchmarkFragmentShader } from './shaders.js';

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measure(render, context) {
  const timings = [];
  for (let index = 0; index < 150; index++) {
    await new Promise(requestAnimationFrame);
    context.finish();
    const start = performance.now();
    for (let repetition = 0; repetition < 8; repetition++) render();
    const milliseconds = (performance.now() - start) / 8;
    context.finish();
    if (index >= 30) timings.push(milliseconds);
  }
  return median(timings);
}

export async function runBenchmark(parts, onProgress = () => {}) {
  const THREE = await import('three');
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:640px;height:480px;position:fixed;left:-1000px;top:0';
  document.body.appendChild(canvas);
  const results = [];
  let referencePixels;
  function comparePixels(context, render) {
    render();
    const pixels = new Uint8Array(640 * 480 * 4);
    context.readPixels(0, 0, 640, 480, context.RGBA, context.UNSIGNED_BYTE, pixels);
    if (!referencePixels) referencePixels = pixels;
    let matching = 0;
    for (let index = 0; index < pixels.length; index++) {
      if (Math.abs(pixels[index] - referencePixels[index]) <= 1) matching++;
    }
    return matching / pixels.length;
  }
  const camera = { eye: [4, 3.1, 5], target: [0, 1.2, 0] };
  try {
    for (const batching of [true, false]) {
      onProgress(`Measuring Crucible ${batching ? 'instanced' : 'individual meshes'}…`);
      const renderer = new CrucibleRenderer(canvas, parts, { batching, pixelRatio: 1, benchmark: true });
      try {
        const milliseconds = await measure(() => renderer.render(camera), renderer.context);
        results.push({ name: `Crucible ${batching ? 'instanced' : 'individual'}`, milliseconds, calls: renderer.batches.length, pixelAgreement: comparePixels(renderer.context, () => renderer.render(camera)) });
      } finally {
        renderer.dispose();
      }
    }
    for (const batching of [true, false]) {
      onProgress(`Measuring Three.js ${batching ? 'instanced' : 'individual meshes'}…`);
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
      renderer.setPixelRatio(1);
      renderer.setSize(640, 480, false);
      renderer.setClearColor(0x25292d);
      const scene = new THREE.Scene();
      const threeCamera = new THREE.PerspectiveCamera(180 / 5.5, 640 / 480, 0.1, 100);
      threeCamera.position.set(...camera.eye);
      threeCamera.lookAt(...camera.target);
      threeCamera.updateMatrixWorld();
      const viewProjection = new THREE.Matrix4().multiplyMatrices(threeCamera.projectionMatrix, threeCamera.matrixWorldInverse);
      const geometries = [];
      const material = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: benchmarkVertexShader.replace('#version 300 es', ''),
        fragmentShader: benchmarkFragmentShader.replace('#version 300 es', ''),
        uniforms: { viewProjection: { value: viewProjection } },
      });
      const floor = {
        geometry: { positions: new Float32Array([-100, 0.019, -100, -100, 0.019, 100, 100, 0.019, 100, 100, 0.019, -100]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) },
        matrix: new THREE.Matrix4().elements,
        name: 'Benchmark floor',
        material: { color: [0.04, 0.05, 0.06], metallic: 0, roughness: 1, emission: 0, tag: 'floor' },
      };
      for (const group of groupParts([...parts, floor], batching)) {
        const source = group[0].geometry;
        const geometry = new THREE.InstancedBufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(source.positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(source.indices, 1));
        geometry.setAttribute('instanceMatrix', new THREE.InstancedBufferAttribute(new Float32Array(group.flatMap((part) => Array.from(part.matrix))), 16));
        geometry.setAttribute('instanceColor', new THREE.InstancedBufferAttribute(new Float32Array(group.flatMap((part) => part.material.color)), 3));
        geometry.instanceCount = group.length;
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        scene.add(mesh);
        geometries.push(geometry);
      }
      try {
        const milliseconds = await measure(() => renderer.render(scene, threeCamera), renderer.getContext());
        results.push({ name: `Three.js ${batching ? 'instanced' : 'individual'}`, milliseconds, calls: renderer.info.render.calls, pixelAgreement: comparePixels(renderer.getContext(), () => renderer.render(scene, threeCamera)) });
      } finally {
        geometries.forEach((geometry) => geometry.dispose());
        material.dispose();
        renderer.dispose();
      }
    }
    return { results, resolution: [640, 480], samples: 120, submissionsPerSample: 8, isolated: window.crossOriginIsolated, metric: 'CPU draw submission median milliseconds, GPU synchronization outside timed region', browser: navigator.userAgent };
  } finally {
    canvas.remove();
  }
}
