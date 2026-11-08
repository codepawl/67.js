import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { Bone, Skeleton, SkinnedMesh, BufferGeometry, Float32BufferAttribute, Uint16BufferAttribute, Matrix4, Matrix3, Vector3 } from 'three';
import { createSkinPose, updateSkinPose, validateSkinGeometry, validateSkinPose, skinTextureLayout, packSkinInfluences, skinInfluenceSets, reflectedSkinReport, reflectedSkinDiagnostics } from '../src/skinning.js';

function influences() {
  return { positions: new Float32Array([0.2, 1, 0]), skinIndices: new Uint16Array([0, 1, 0, 0]), skinWeights: new Float32Array([0.3, 0.7, 0, 0]) };
}

test('mesh-local palette produces the same bent position as Three.js with inverse binds and mesh transforms', () => {
  const root = new Bone();
  const child = new Bone();
  root.add(child);
  child.position.y = 1;
  root.updateMatrixWorld(true);
  const skeleton = new Skeleton([root, child]);
  const geometry = new BufferGeometry();
  const input = influences();
  geometry.setAttribute('position', new Float32BufferAttribute(input.positions, 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(input.skinIndices, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(input.skinWeights, 4));
  const mesh = new SkinnedMesh(geometry);
  mesh.position.set(2, 3, 0);
  mesh.updateMatrixWorld(true);
  mesh.bind(skeleton, new Matrix4().makeTranslation(0.5, 0, 0));
  child.rotation.z = 0.8;
  child.scale.set(2, 0.7, 1);
  root.updateMatrixWorld(true);
  mesh.updateMatrixWorld(true);
  const world = new Float32Array(32);
  const inverse = new Float32Array(32);
  [root, child].forEach((bone, index) => {
    world.set(bone.matrixWorld.elements, index * 16);
    inverse.set(skeleton.boneInverses[index].elements, index * 16);
  });
  const pose = createSkinPose(2);
  updateSkinPose(pose, world, inverse, mesh.matrixWorld.elements, mesh.bindMatrix.elements);
  validateSkinGeometry(input, pose);
  const expected = mesh.applyBoneTransform(0, new Vector3(...input.positions));
  const actual = new Vector3();
  for (let influence = 0; influence < 4; influence++) {
    const joint = input.skinIndices[influence];
    actual.addScaledVector(new Vector3(...input.positions).applyMatrix4(new Matrix4().fromArray(pose.jointMatrices, joint * 16)), input.skinWeights[influence]);
  }
  assert.ok(actual.distanceTo(expected) < 1e-6);
  const blended = new Matrix4();
  blended.elements.fill(0);
  for (let component = 0; component < 16; component++) blended.elements[component] = pose.jointMatrices[component] * 0.3 + pose.jointMatrices[16 + component] * 0.7;
  const normal = new Vector3(1, 1, 0).normalize();
  const correct = normal.clone().applyMatrix3(new Matrix3().getNormalMatrix(blended)).normalize();
  const threeDirection = normal.clone().transformDirection(blended);
  assert.ok(correct.distanceTo(threeDirection) > 0.1, 'nonuniform scaling requires inverse-transpose, unlike Three skin normal chunk');
  const tangent = new Vector3(1, -1, 0).transformDirection(blended);
  assert.ok(Math.abs(correct.dot(tangent)) < 1e-6);
  geometry.dispose();
  mesh.material.dispose();
  skeleton.dispose();
});

test('pose update retains buffers and rejects invalid input atomically', context => {
  const pose = createSkinPose(2);
  const matrices = pose.jointMatrices;
  const world = new Float32Array(matrices);
  const inverses = new Float32Array(matrices);
  world[28] = 2;
  context.mock.method(mat4, 'create', () => { throw new Error('Per-frame matrix allocation'); });
  updateSkinPose(pose, world, inverses);
  assert.equal(pose.jointMatrices, matrices);
  assert.equal(matrices[28], 2);
  const before = Array.from(matrices);
  world[16] = 0;
  assert.throws(() => updateSkinPose(pose, world, inverses), /singular/);
  assert.deepEqual(Array.from(matrices), before);
  world[16] = Infinity;
  assert.throws(() => updateSkinPose(pose, world, inverses), /finite/);
  assert.deepEqual(Array.from(matrices), before);
  assert.throws(() => createSkinPose(0), /Joint count/);
});

test('influences normalize explicitly without modifying inputs and guard malformed skin data', () => {
  const geometry = influences();
  const pose = createSkinPose(2);
  geometry.skinWeights.set([0.2, 0.2, 0, 0]);
  validateSkinGeometry(geometry, pose);
  const layout = skinTextureLayout(2, 16, 2);
  const data = packSkinInfluences(geometry, layout);
  assert.deepEqual(Array.from(data.subarray(0, 8)), [0, 1, 0, 0, 0.5, 0.5, 0, 0]);
  assert.ok(Math.abs(geometry.skinWeights[0] - 0.2) < 1e-7);
  geometry.skinWeights.fill(0);
  assert.throws(() => validateSkinGeometry(geometry, pose), /positive total/);
  geometry.skinWeights[0] = -1;
  assert.throws(() => validateSkinGeometry(geometry, pose), /weights/);
  geometry.skinWeights[0] = NaN;
  assert.throws(() => validateSkinGeometry(geometry, pose), /weights/);
  geometry.skinWeights[0] = 1;
  geometry.skinIndices[0] = 2;
  assert.throws(() => validateSkinGeometry(geometry, pose), /index/);
  assert.throws(() => validateSkinGeometry(geometry, null), /pose/);
  assert.throws(() => validateSkinGeometry({ ...geometry, skinWeights: new Float32Array(3) }, pose), /four values/);
});

test('singular weighted transforms and texture capacity limits fail explicitly', () => {
  const pose = createSkinPose(2);
  const geometry = influences();
  geometry.skinWeights.set([0.5, 0.5, 0, 0]);
  mat4.fromScaling(pose.jointMatrices.subarray(16), [-1, -1, 1]);
  assert.throws(() => validateSkinPose(pose, geometry), /weighted vertex/);
  assert.throws(() => skinTextureLayout(65, 8, 4), /MAX_TEXTURE_SIZE/);
  assert.equal(skinTextureLayout(64, 8, 4).bytes, 1024);
});

test('Float64 influences that round to a singular GPU blend are rejected', () => {
  const pose = createSkinPose(2);
  mat4.fromScaling(pose.jointMatrices.subarray(16), [-1, 1, 1]);
  const geometry = influences();
  geometry.skinWeights = new Float64Array([0.500000007, 0.499999993, 0, 0]);
  const packed = packSkinInfluences(geometry, skinTextureLayout(2, 16, 2));
  assert.deepEqual(Array.from(packed.subarray(4, 8)), [0.5, 0.5, 0, 0]);
  assert.throws(() => validateSkinGeometry(geometry, pose), /singular weighted vertex/);
  assert.throws(() => validateSkinPose(pose, geometry), /singular weighted vertex/);
});

test('near-affine singular mesh input cannot reuse a stale inverse or mutate the palette', () => {
  const pose = createSkinPose(1);
  const world = new Float64Array(pose.jointMatrices);
  const inverseBind = new Float64Array(pose.jointMatrices);
  const initialMesh = new Float64Array(pose.jointMatrices);
  initialMesh[12] = 3;
  updateSkinPose(pose, world, inverseBind, initialMesh);
  const before = Array.from(pose.jointMatrices);
  const invalidMesh = new Float64Array(mat4.create());
  invalidMesh[3] = 1e-6;
  invalidMesh[12] = 1e6;
  assert.equal(mat4.determinant(invalidMesh), 0);
  assert.throws(() => updateSkinPose(pose, world, inverseBind, invalidMesh), /affine/);
  assert.deepEqual(Array.from(pose.jointMatrices), before);
});

test('matrix preflight rejects singular Float32 rounding for every pose input atomically', context => {
  const pose = createSkinPose(1);
  const identity = new Float64Array(pose.jointMatrices);
  const roundedSingular = new Float64Array(identity);
  roundedSingular[0] = 1;
  roundedSingular[1] = 1;
  roundedSingular[4] = 1;
  roundedSingular[5] = 1.00000001;
  assert.ok(mat4.determinant(roundedSingular) > 1e-10);
  assert.equal(mat4.determinant(new Float32Array(roundedSingular)), 0);
  const before = Array.from(pose.jointMatrices);
  context.mock.method(mat4, 'multiply', () => { throw new Error('Math ran before Float32 input validation'); });
  for (let input = 0; input < 4; input++) {
    const inputs = [identity, identity, identity, identity];
    inputs[input] = roundedSingular;
    assert.throws(() => updateSkinPose(pose, ...inputs), /singular/);
    assert.deepEqual(Array.from(pose.jointMatrices), before);
  }
});

test('failed matrix inversion leaves the retained palette unchanged', context => {
  const pose = createSkinPose(1);
  const identity = new Float32Array(pose.jointMatrices);
  const before = Array.from(pose.jointMatrices);
  context.mock.method(mat4, 'invert', () => null);
  assert.throws(() => updateSkinPose(pose, identity, identity), /invert/);
  assert.deepEqual(Array.from(pose.jointMatrices), before);
});

test('pose calculations use Float32 mesh and bind matrices before inversion and multiplication', () => {
  const pose = createSkinPose(1);
  const identity = new Float64Array(pose.jointMatrices);
  const mesh = new Float64Array(identity);
  mesh[0] = 1.00000007;
  const bind = new Float64Array(identity);
  bind[0] = 1.00000007;
  const expectedInverse = mat4.invert(mat4.create(), new Float32Array(mesh));
  const expected = mat4.multiply(mat4.create(), expectedInverse, new Float32Array(bind));
  updateSkinPose(pose, identity, identity, mesh, bind);
  assert.deepEqual(Array.from(pose.jointMatrices), Array.from(expected));
  updateSkinPose(pose, identity, identity, mesh);
  assert.deepEqual(Array.from(pose.jointMatrices), Array.from(expectedInverse));
});

test('validateSkinPose checks each distinct influence set once and still finds a singular one', () => {
  const pose = createSkinPose(2);
  // Joint 1 mirrors x. Each joint is healthy, but a 50/50 blend with the identity flattens x to zero.
  pose.jointMatrices.set([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 16);
  const repeatedHealthy = Array.from({ length: 50 }, () => [0, 0, 0, 0]).flat();
  const geometry = {
    skinIndices: new Uint16Array([...repeatedHealthy, 0, 1, 0, 0]),
    skinWeights: new Float32Array([...Array.from({ length: 50 }, () => [1, 0, 0, 0]).flat(), 0.5, 0.5, 0, 0]),
  };
  assert.equal(skinInfluenceSets(geometry).joints.length / 4, 2);
  assert.throws(() => validateSkinPose(pose, geometry), /singular weighted vertex transform/);
});

test('skinInfluenceSets rebuilds when the index array is replaced', () => {
  const skinWeights = new Float32Array([1, 0, 0, 0, 0.5, 0.5, 0, 0]);
  const first = skinInfluenceSets({ skinIndices: new Uint16Array([0, 0, 0, 0, 0, 1, 0, 0]), skinWeights });
  const replaced = skinInfluenceSets({ skinIndices: new Uint16Array([1, 0, 0, 0, 1, 1, 0, 0]), skinWeights });
  assert.notEqual(first, replaced);
  assert.deepEqual([...replaced.joints.subarray(0, 4)], [1, 0, 0, 0]);
});

test('a mirrored weighted vertex draws pinched and is reported instead of failing the pose (issue #581)', () => {
  const pose = createSkinPose(2);
  // Joint 1 mirrors x. A 25/75 blend with the identity scales x by -0.5: a mirrored but healthy transform.
  pose.jointMatrices.set([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 16);
  const geometry = {
    skinIndices: new Uint16Array([0, 0, 0, 0, 0, 1, 0, 0]),
    skinWeights: new Float32Array([1, 0, 0, 0, 0.25, 0.75, 0, 0]),
  };
  const world = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.doesNotThrow(() => validateSkinPose(pose, geometry, world));
  assert.deepEqual(reflectedSkinReport(pose), { sets: 1, joints: [0, 1], weights: [0.25, 0.75] });
  const [problem] = reflectedSkinDiagnostics(new Map([[{ name: "knight" }, { skin: pose }]]));
  assert.equal(problem.kind, 'skin-reflected-vertices');
  assert.match(problem.message, /1 vertex weight set\(s\) of knight mirror .*joint 0 at 0\.25, joint 1 at 0\.75/);
  // Once the joint stops mirroring, the report clears.
  pose.jointMatrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 16);
  validateSkinPose(pose, geometry, world);
  assert.equal(reflectedSkinReport(pose), null);
  assert.deepEqual(reflectedSkinDiagnostics(new Map([[{ name: "knight" }, { skin: pose }]])), []);
});
