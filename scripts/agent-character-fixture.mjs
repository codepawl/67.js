import { readFile } from 'node:fs/promises';
import { sphere, box, cylinder } from '../src/geometry.js';
import { skinnedStripAsset } from '../tests/fixtures/skinned-strip.js';

/** Original toy astronaut with an actual nine-joint skin and embedded suit patch. */
export async function createAgentCharacterFixture() {
  const texture = JSON.parse(await readFile(new URL('../tests/fixtures/textured-triangle.gltf', import.meta.url), 'utf8'));
  const image = Buffer.from(texture.images[0].uri.split(',')[1], 'base64');
  const jointPositions = [
    [0, 1, 0], [0, 1.8, 0], [0, 2.55, 0],
    [-0.65, 2.05, 0], [-0.95, 1.6, 0], [-1.02, 1.08, 0],
    [0.65, 2.05, 0], [0.95, 1.6, 0], [1.02, 1.08, 0],
  ];
  const parents = [-1, 0, 1, 1, 3, 4, 1, 6, 7];
  const labels = ['Hips', 'Chest', 'Helmet', 'Left shoulder', 'Left elbow', 'Left glove', 'Right shoulder', 'Right elbow', 'Right glove'];
  const bytes = skinnedStripAsset((document, append) => {
    document.nodes = [{ name: 'Pip the astronaut', children: [1] }];
    jointPositions.forEach((position, index) => {
      const parentPosition = parents[index] < 0 ? [0, 0, 0] : jointPositions[parents[index]];
      document.nodes.push({ name: labels[index], translation: position.map((value, axis) => value - parentPosition[axis]), children: [] });
    });
    parents.forEach((parent, index) => {
      if (parent >= 0) document.nodes[parent + 1].children.push(index + 1);
    });
    document.meshes = [];
    document.animations = [];
    const colors = [[0.78, 0.84, 0.82], [0.015, 0.095, 0.11], [0.035, 0.42, 0.38], [0.83, 0.46, 0.12], [0.22, 0.25, 0.28], [0.82, 0.95, 1], [1, 1, 1], [0.19, 0.23, 0.24]];
    document.materials = colors.map((color, index) => ({
      name: ['Ceramic suit', 'Visor', 'Teal trim', 'Brass', 'Boots', 'Eyes', 'Suit patch', 'Stage'][index],
      pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: index === 3 ? 0.8 : 0.15, roughnessFactor: index === 1 ? 0.19 : 0.4 },
      ...(index === 5 ? { emissiveFactor: [0.08, 0.2, 0.22] } : {}),
    }));
    append(new Uint8Array(image), 'SCALAR');
    document.images = [{ bufferView: document.bufferViews.length - 1, mimeType: 'image/png' }];
    document.textures = [{ source: 0 }];
    document.materials[6].pbrMetallicRoughness.baseColorTexture = { index: 0 };
    const inverseBind = new Float32Array(9 * 16);
    jointPositions.forEach((position, index) => {
      inverseBind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...position.map(value => -value), 1], index * 16);
    });
    document.skins = [{ joints: jointPositions.map((_, index) => index + 1), skeleton: 1, inverseBindMatrices: append(inverseBind, 'MAT4') }];
    function mesh(label, geometry, position, scale, joint, material, blend = null) {
      const positions = new Float32Array(geometry.positions.length);
      const normals = new Float32Array(geometry.normals.length);
      const count = positions.length / 3;
      const joints = new Uint16Array(count * 4);
      const weights = new Float32Array(count * 4);
      const uvs = new Float32Array(count * 2);
      const minimum = [Infinity, Infinity, Infinity];
      const maximum = [-Infinity, -Infinity, -Infinity];
      for (let vertex = 0; vertex < count; vertex++) {
        let normalLength = 0;
        for (let axis = 0; axis < 3; axis++) {
          const offset = vertex * 3 + axis;
          const value = geometry.positions[offset] * scale[axis] + position[axis];
          positions[offset] = value;
          minimum[axis] = Math.min(minimum[axis], value);
          maximum[axis] = Math.max(maximum[axis], value);
          normals[offset] = geometry.normals[offset] / scale[axis];
          normalLength += normals[offset] ** 2;
        }
        for (let axis = 0; axis < 3; axis++) normals[vertex * 3 + axis] /= Math.sqrt(normalLength);
        joints[vertex * 4] = joint;
        weights[vertex * 4] = 1;
        if (blend) {
          const amount = Math.max(0, Math.min(1, (positions[vertex * 3 + 1] - blend.bottom) / (blend.top - blend.bottom)));
          joints[vertex * 4 + 1] = blend.joint;
          weights[vertex * 4] = 1 - amount;
          weights[vertex * 4 + 1] = amount;
        }
        uvs[vertex * 2] = geometry.positions[vertex * 3] + 0.5;
        uvs[vertex * 2 + 1] = geometry.positions[vertex * 3 + 1] + 0.5;
      }
      const positionAccessor = append(positions, 'VEC3');
      document.accessors[positionAccessor].min = minimum;
      document.accessors[positionAccessor].max = maximum;
      const primitive = { attributes: { POSITION: positionAccessor, NORMAL: append(normals, 'VEC3'),
        TEXCOORD_0: append(uvs, 'VEC2'), ...(joint === null ? {} : { JOINTS_0: append(joints, 'VEC4'), WEIGHTS_0: append(weights, 'VEC4') }) },
      indices: append(new Uint16Array(geometry.indices), 'SCALAR'), material };
      const meshIndex = document.meshes.push({ name: label, primitives: [primitive] }) - 1;
      if (joint === null) document.scenes[0].nodes.push(document.nodes.length);
      else document.nodes[0].children.push(document.nodes.length);
      document.nodes.push({ name: label, mesh: meshIndex, ...(joint === null ? {} : { skin: 0 }) });
    }
    const rounded = box(0.16, 4);
    const ball = sphere(32, 20);
    const tube = cylinder(24, 0.08, 4);
    mesh('Suit torso', rounded, [0, 1.76, 0], [1.03, 0.98, 0.63], 1, 0);
    mesh('Backpack', rounded, [0, 1.75, -0.42], [0.76, 0.8, 0.32], 1, 2);
    mesh('Waist belt', rounded, [0, 1.22, 0], [0.96, 0.18, 0.68], 0, 2);
    mesh('Helmet shell', ball, [0, 2.62, 0], [0.59, 0.58, 0.53], 2, 0);
    mesh('Visor', ball, [0, 2.64, 0.22], [0.51, 0.39, 0.42], 2, 1);
    for (const side of [-1, 1]) {
      mesh('Glowing eye', rounded, [side * 0.17, 2.67, 0.614], [0.1, 0.17, 0.045], 2, 5);
      mesh('Helmet hinge', tube, [side * 0.54, 2.54, 0], [0.1, 0.14, 0.1], 2, 3);
      const shoulder = side < 0 ? 3 : 6;
      const elbow = shoulder + 1;
      const glove = shoulder + 2;
      mesh('Shoulder cap', ball, [side * 0.67, 2.04, 0], [0.25, 0.25, 0.28], shoulder, 2);
      mesh('Flexible upper sleeve', tube, [side * 0.88, 1.81, 0], [0.19, 0.58, 0.19], elbow, 0, { joint: shoulder, bottom: 1.59, top: 2.06 });
      mesh('Elbow seam', ball, [side * 0.96, 1.57, 0], [0.19, 0.17, 0.19], elbow, 4);
      mesh('Forearm sleeve', tube, [side * 1.0, 1.31, 0], [0.18, 0.48, 0.18], elbow, 0);
      mesh('Cuff', tube, [side * 1.02, 1.1, 0], [0.19, 0.13, 0.19], glove, 2);
      mesh('Glove', rounded, [side * 1.03, 0.94, 0.04], [0.32, 0.34, 0.31], glove, 0);
      mesh('Trouser', rounded, [side * 0.27, 0.72, 0], [0.4, 0.85, 0.47], 0, 0);
      mesh('Boot', rounded, [side * 0.28, 0.24, 0.1], [0.48, 0.39, 0.7], 0, 4);
      mesh('Chest button', ball, [side * 0.12, 1.62, 0.335], [0.045, 0.045, 0.025], 1, side < 0 ? 3 : 2);
    }
    mesh('Chest control', rounded, [0, 1.83, 0.34], [0.51, 0.35, 0.075], 1, 2);
    mesh('Suit patch', rounded, [0, 1.87, 0.385], [0.31, 0.15, 0.028], 1, 6);
    mesh('Circular stage', cylinder(64, 0.018, 4), [0, 0.005, 0], [2.2, 0.08, 2.2], null, 7);
    const times = append(new Float32Array([0, 3]), 'SCALAR');
    const chestRotation = append(new Float32Array([0, 0, 0, 1, 0, Math.sin(0.13), 0, Math.cos(0.13)]), 'VEC4');
    document.animations = [{ name: 'Gentle chest turn', samplers: [{ input: times, output: chestRotation }], channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }] }];
  });
  const rotation = (axis, angle) => [...axis.map(value => value * Math.sin(angle / 2)), Math.cos(angle / 2)];
  return {
    bytes: Buffer.from(bytes),
    recipe: {
      format: 'crucible.asset', schemaVersion: 1,
      camera: { eye: [5.2, 3.3, 7.8], target: [0, 1.62, 0], fov: 38, near: 0.1, far: 100 },
      environment: { daylight: 1, keyIntensity: 1.9, fillIntensity: 2.4, ambientIntensity: 1.05, lightDirection: [-0.7, 1, 0.65] },
      effects: { bloom: { strength: 0.14 }, grain: 0, vignette: 0.08 },
      animation: { clip: 0, time: 0 },
      motion: { duration: 3, tracks: [
        { kind: 'node', id: 'node-0', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 3, value: [0.35, 0, 0] }] },
        { kind: 'node', id: 'node-3', property: 'rotation', interpolation: 'SMOOTH', keyframes: [{ time: 0, value: rotation([0, 1, 0], -0.15) }, { time: 1.5, value: rotation([0, 1, 0], 0.38) }, { time: 3, value: rotation([0, 1, 0], -0.2) }] },
        { kind: 'node', id: 'node-7', property: 'rotation', interpolation: 'SMOOTH', keyframes: [{ time: 0, value: rotation([0, 0, 1], 0) }, { time: 1.5, value: rotation([0, 0, 1], 1.1) }, { time: 3, value: rotation([0, 0, 1], 0.35) }] },
        { kind: 'node', id: 'node-8', property: 'rotation', interpolation: 'SMOOTH', keyframes: [{ time: 0, value: rotation([0, 0, 1], 0) }, { time: 1.5, value: rotation([0, 0, 1], 0.95) }, { time: 3, value: rotation([0, 0, 1], 0.3) }] },
      ] },
    },
  };
}
