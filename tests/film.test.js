import assert from 'node:assert/strict';
import test from 'node:test';
import { createFilmScenes, FILM_DURATION, FILM_SHOTS, sampleFilm } from '../src/film.js';
import { resolveEffects } from '../src/effects.js';
import { planRenderSize } from '../src/budget.js';
import { validateMorphGeometry, validateMorphTransform } from '../src/morph.js';
import { sampleScientistHead } from '../src/film-character.js';
import { mat4 } from 'gl-matrix';
import { PerspectiveCamera, Vector3 } from 'three';

const distance = (first, second) => Math.hypot(...first.map((value, axis) => value - second[axis]));

test('187-second study has contiguous authored cuts, a late detonation and terminal black', () => {
  assert.equal(FILM_DURATION, 187);
  assert.ok(FILM_SHOTS.length >= 24 && FILM_SHOTS.length <= 35);
  assert.equal(FILM_SHOTS[0].start, 0);
  assert.equal(FILM_SHOTS.at(-1).end, FILM_DURATION);
  for (const [index, shot] of FILM_SHOTS.entries()) {
    assert.ok(shot.end > shot.start);
    if (index) assert.equal(shot.start, FILM_SHOTS[index - 1].end);
    assert.equal(sampleFilm(shot.start).shotIndex, index);
    assert.equal(sampleFilm(shot.start).scene, shot.scene);
    assert.equal(sampleFilm(shot.end - 0.00001).shotIndex, index);
  }
  assert.deepEqual(sampleFilm(-10), sampleFilm(0));
  assert.deepEqual(sampleFilm(1000), sampleFilm(FILM_DURATION));
  assert.equal(sampleFilm(0).fade, 1);
  assert.equal(sampleFilm(2).fade, 0);
  assert.equal(sampleFilm(FILM_DURATION).fade, 1);
  assert.equal(sampleFilm(180.9).title, '');
  assert.equal(sampleFilm(183).title, '');
  assert.equal(sampleFilm(185).title, 'OPPENHEIMER');
  assert.equal(sampleFilm(185).subtitle, 'A 67js trailer study');
  assert.equal(sampleFilm(185).titleOpacity, 1);
  assert.equal(sampleFilm(180.9).explosionProgress, 0);
  assert.equal(sampleFilm(181).sceneTime, 0);
  assert.equal(sampleFilm(181).flash, 1);
  assert.equal(sampleFilm(183).explosionProgress, 1);
  assert.ok(sampleFilm(182).explosionProgress > 0.6);
});

test('random-access frame samples are finite and independent of playback order', () => {
  const scenes = createFilmScenes();
  const times = Array.from({ length: FILM_DURATION * 24 + 1 }, (_, index) => index / 24);
  const samples = times.map(sampleFilm);
  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = sampleFilm(times[index]);
    assert.deepEqual(sample, samples[index]);
    assert.ok(scenes[sample.scene]);
    for (const value of [...sample.camera.eye, ...sample.camera.target, sample.camera.fov, sample.exposure, sample.time, sample.sceneTime]) {
      assert.ok(Number.isFinite(value));
    }
    for (const value of [sample.fade, sample.monochrome, sample.explosionProgress, sample.flash, sample.titleOpacity]) {
      assert.ok(value >= 0 && value <= 1);
    }
    assert.ok(sample.camera.fov >= 20 && sample.camera.fov <= 65);
    assert.ok(distance(sample.camera.eye, sample.camera.target) > 0.5);
    assert.doesNotThrow(() => resolveEffects(sample.effects));
  }
  for (const invalid of [NaN, Infinity, -Infinity, undefined, null, '1', {}]) {
    assert.throws(() => sampleFilm(invalid), TypeError);
  }
});

test('camera motion is continuous and eases to rest within each shot', () => {
  for (const shot of FILM_SHOTS) {
    assert.ok(distance(sampleFilm(shot.start).camera.eye, sampleFilm(shot.end - 0.001).camera.eye) > 0.1);
    assert.ok(distance(sampleFilm(shot.start).camera.eye, sampleFilm(shot.start + 0.001).camera.eye) < 0.001);
    assert.ok(distance(sampleFilm(shot.end - 0.002).camera.eye, sampleFilm(shot.end - 0.001).camera.eye) < 0.001);
    for (let time = shot.start; time + 0.01 < shot.end; time += 0.01) {
      assert.ok(distance(sampleFilm(time).camera.eye, sampleFilm(time + 0.01).camera.eye) < 0.12);
      assert.ok(distance(sampleFilm(time).camera.target, sampleFilm(time + 0.01).camera.target) < 0.05);
    }
  }
});

test('sets keep shared geometry, valid surfaces and the 384 MiB target budget', () => {
  const scenes = createFilmScenes();
  assert.ok(Object.keys(scenes).length >= 8);
  const referencedSets = new Set(FILM_SHOTS.map(shot => shot.scene));
  assert.deepEqual([...referencedSets].sort(), Object.keys(scenes).sort());
  const budgets = {};
  const checkedGeometries = new Set();
  for (const [name, scene] of Object.entries(scenes)) {
    assert.equal(scene.ground, false);
    assert.ok(scene.environment.fogDensity >= 0);
    assert.equal(scene.environment.lightDirection.length, 3);
    assert.ok(scene.parts.length > 100 && scene.parts.length <= 1500);
    const triangleCount = scene.parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
    assert.ok(triangleCount <= 700000, name);
    const geometries = new Set(scene.parts.map(part => part.geometry));
    // Two shared garment contours replace rectangular collars and lapels.
    assert.ok(geometries.size <= 15);
    let geometryBytes = scene.parts.length * 42 * 4;
    for (const geometry of geometries) {
      geometryBytes += geometry.positions.byteLength + geometry.normals.byteLength + geometry.indices.byteLength;
      geometryBytes += geometry.colors?.byteLength ?? 0;
      for (const target of geometry.morphTargets ?? []) {
        geometryBytes += (target.positions?.byteLength ?? 0) + (target.normals?.byteLength ?? 0);
      }
      if (checkedGeometries.has(geometry)) continue;
      checkedGeometries.add(geometry);
      assert.ok(geometry.positions instanceof Float32Array);
      assert.ok(geometry.normals instanceof Float32Array);
      assert.ok(geometry.indices instanceof Uint32Array);
      assert.equal(geometry.positions.length, geometry.normals.length);
      assert.ok(Array.from(geometry.positions).every(Number.isFinite));
      if (geometry.colors) {
        assert.equal(geometry.colors.length, geometry.positions.length);
        assert.ok(Array.from(geometry.colors).every(value => Number.isFinite(value) && value >= 0 && value <= 1));
      }
      for (let vertex = 0; vertex < geometry.normals.length; vertex += 3) {
        assert.ok(Math.abs(Math.hypot(...geometry.normals.slice(vertex, vertex + 3)) - 1) < 0.00001);
      }
      for (const index of geometry.indices) assert.ok(index < geometry.positions.length / 3);
    }
    for (const part of scene.parts) {
      assert.ok(part.name);
      assert.ok(part.matrix instanceof Float32Array);
      assert.equal(part.matrix.length, 16);
      assert.equal(part.matrix[15], 1);
      assert.ok(Array.from(part.matrix).every(Number.isFinite));
      assert.ok(part.material.color.every(value => value >= 0 && value <= 1));
      assert.ok(part.material.roughness > 0 && part.material.roughness <= 1);
      assert.ok(part.material.metallic >= 0 && part.material.metallic <= 1);
      assert.ok(part.material.emission >= 0);
    }
    const plan = planRenderSize({ width: 1280, height: 720, samples: 4, memoryBudgetMiB: 384, hdr: true, bloom: true, geometryBytes });
    assert.equal(plan.reduced, false);
    assert.ok(plan.estimatedBytes < 384 * 1024 * 1024);
    budgets[name] = { parts: scene.parts.length, triangles: triangleCount, geometries: geometries.size, estimatedMiB: Math.round(plan.estimatedBytes / 1024 / 1024) };
  }
  assert.ok(scenes.ignition.parts.some(part => part.material.tag === 'fire'));
  assert.ok(scenes.ignition.parts.some(part => part.material.tag === 'smoke'));
  assert.ok(scenes.portrait.parts.some(part => part.name === 'Fedora sweeping brim'));
  assert.ok(scenes.settlement.parts.some(part => part.name === 'Army jeep chassis'));
  console.log(JSON.stringify(budgets));
});


test('authored motion is visible, deterministic and retains render identities across seeks', () => {
  const scenes = createFilmScenes();
  const snapshot = scene => scene.parts.map(part => ({ matrix: Array.from(part.matrix), color: [...part.material.color], emission: part.material.emission }));
  for (const name of ['sparks', 'atom', 'waves', 'control', 'gadget', 'settlement', 'portrait', 'desert', 'night']) {
    const scene = scenes[name];
    const identities = scene.parts.map(part => ({ part, geometry: part.geometry, matrix: part.matrix }));
    scene.animate(2.75);
    const expected = snapshot(scene);
    scene.animate(7.3);
    assert.notDeepEqual(snapshot(scene), expected, name);
    scene.animate(0);
    scene.animate(2.75);
    assert.deepEqual(snapshot(scene), expected, name);
    scene.parts.forEach((part, index) => {
      assert.equal(part, identities[index].part);
      assert.equal(part.geometry, identities[index].geometry);
      assert.equal(part.matrix, identities[index].matrix);
      assert.ok(Array.from(part.matrix).every(Number.isFinite));
    });
  }
});


test('tailored figure surfaces face outward and keep a closed shoulder silhouette', () => {
  const scene = createFilmScenes().portrait;
  const coat = scene.parts.find(part => part.name === 'Sculpted tailored jacket').geometry;
  let farthest = 0;
  for (let index = 3; index < coat.positions.length; index += 3) {
    if (coat.positions[index] > coat.positions[farthest]) farthest = index;
  }
  assert.ok(coat.normals[farthest] > 0.5);
  assert.ok(scene.parts.some(part => part.name === 'Tailored shoulder line'));
});

test('authored actor joints retain attached headwear and hands through holds and arbitrary seeks', () => {
  const scene = createFilmScenes().portrait;
  const head = scene.parts.find(part => part.name === 'Continuous sculpted head');
  const hat = scene.parts.find(part => part.name === 'Fedora tapered felt crown');
  const hand = scene.parts.find(part => part.name === 'Resting hand silhouette');
  const cuff = scene.parts.find(part => part.name === 'Shirt cuff' && part.actorJoint.name === hand.actorJoint.name);
  const relative = (parent, child) => Array.from(mat4.multiply(mat4.create(), mat4.invert(mat4.create(), parent.matrix), child.matrix));
  scene.animate(0);
  const headAttachment = relative(head, hat);
  const armAttachment = relative(cuff, hand);
  const assembled = Array.from(head.matrix);
  scene.animate(5);
  const held = Array.from(head.matrix);
  assert.notDeepEqual(held, assembled);
  scene.animate(6.5);
  assert.deepEqual(Array.from(head.matrix), held);
  for (const time of [10.3, 2.7, 23.9, 0, 5]) {
    scene.animate(time);
    relative(head, hat).forEach((value, index) => assert.ok(Math.abs(value - headAttachment[index]) < 1e-5));
    relative(cuff, hand).forEach((value, index) => assert.ok(Math.abs(value - armAttachment[index]) < 1e-5));
  }
  assert.deepEqual(Array.from(head.matrix), held);
  scene.animate(12);
  assert.notDeepEqual(Array.from(head.matrix), assembled);
  scene.animate(16);
  const closeup = Array.from(head.matrix);
  scene.animate(17.2);
  assert.deepEqual(Array.from(head.matrix), closeup);
  assert.notDeepEqual(closeup, held);
});

test('integrated face topology and expression targets retain identities through backward seeks', () => {
  const scene = createFilmScenes().portrait;
  const head = scene.parts.find(part => part.name === 'Continuous sculpted head');
  assert.notEqual(head.material.tag, 'unlit');
  assert.equal(scene.parts.filter(part => part.name.startsWith('Facial ')).length, 0);
  const geometry = head.geometry;
  const targets = geometry.morphTargets;
  const weights = head.morph.weights;
  const morphMetadata = validateMorphGeometry(geometry, head.morph);
  assert.equal(targets.length, 4);
  assert.ok(targets.every(target => target.positions.some(value => Math.abs(value) > 0.01)));
  assert.ok(targets.every(target => target.normals.some(value => Math.abs(value) > 0.01)));
  const base = new Float32Array(geometry.positions);
  const normals = new Float32Array(geometry.normals);
  const colors = new Float32Array(geometry.colors);
  const snapshot = () => ({ matrix: Array.from(head.matrix), weights: Array.from(weights) });
  scene.animate(17.65);
  const expected = snapshot();
  for (const time of [19.8, 2.7, 16, 0, 17.65]) {
    scene.animate(time);
    assert.equal(head.geometry, geometry);
    assert.equal(head.geometry.morphTargets, targets);
    assert.equal(head.morph.weights, weights);
    validateMorphTransform(head.morph, morphMetadata, head.matrix);
  }
  assert.deepEqual(snapshot(), expected);
  assert.deepEqual(geometry.positions, base);
  assert.deepEqual(geometry.normals, normals);
  assert.deepEqual(geometry.colors, colors);
});

test('narrow portrait shots retain face and headwear through camera moves and backward seeks', () => {
  for (const aspect of [9 / 16, 390 / 844, 1]) {
    for (const time of [161, 162, 164.9, 150, 145, 153.9, 162]) {
      const sample = sampleFilm(time, { aspect });
      const expected = structuredClone(sample);
      sampleFilm(70, { aspect });
      assert.deepEqual(sampleFilm(time, { aspect }), expected);
      assert.equal(sample.camera.fov, sampleFilm(time).camera.fov);
      const camera = new PerspectiveCamera(sample.camera.fov, aspect, sample.camera.near, sample.camera.far);
      camera.position.fromArray(sample.camera.eye);
      camera.up.fromArray(sample.camera.up);
      camera.lookAt(...sample.camera.target);
      camera.updateMatrixWorld();
      for (const point of [[-0.22, 1.92, 0], [0.22, 1.92, 0], [0, 1.61, 0.15]]) {
        const projected = new Vector3(...point).project(camera);
        assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1, `${time}: ${point}`);
      }
    }
  }
  for (const time of [150, 162]) {
    const original = sampleFilm(time);
    assert.deepEqual(sampleFilm(time, { aspect: 16 / 9 }), original);
    const nearlyWide = sampleFilm(time, { aspect: 16 / 9 - 1e-6 });
    assert.ok(distance(original.camera.eye, nearlyWide.camera.eye) < 1e-5);
    assert.ok(distance(original.camera.target, nearlyWide.camera.target) < 1e-5);
  }
  for (const aspect of [0, -1, NaN, Infinity, 1e-320]) assert.throws(() => sampleFilm(10, { aspect }));
});

test('blink closes both inset eye surfaces and retains independent actor expressions', () => {
  const scene = createFilmScenes().portrait;
  const face = scene.parts.find(part => part.name === 'Continuous sculpted head');
  const weights = face.morph.weights;
  const geometry = face.geometry;
  scene.animate(17.4);
  assert.equal(weights[0], 0);
  scene.animate(17.65);
  assert.ok(weights[0] > 0.999);
  assert.ok(weights[1] > 0 && weights[2] > 0);
  const projectFace = pose => {
    const triangles = [];
    const point = vertex => [0, 1, 2].map(axis => geometry.morphTargets.reduce((value, target, index) => value + pose[index] * target.positions[vertex * 3 + axis], geometry.positions[vertex * 3 + axis]));
    for (let triangle = 0; triangle < geometry.indices.length; triangle += 3) {
      const vertices = Array.from(geometry.indices.subarray(triangle, triangle + 3));
      const isEye = vertices.some(vertex => [0, 1, 2].some(axis => geometry.morphTargets[3].positions[vertex * 3 + axis] !== 0));
      const [first, second, third] = vertices.map(point);
      if (Math.max(first[2], second[2], third[2]) < 0.5) continue;
      const minimumX = Math.min(first[0], second[0], third[0]);
      const maximumX = Math.max(first[0], second[0], third[0]);
      const minimumY = Math.min(first[1], second[1], third[1]);
      const maximumY = Math.max(first[1], second[1], third[1]);
      if (maximumY < 0.07 || minimumY > 0.235 || minimumX > 0.61 || maximumX < -0.61) continue;
      const divisor = (second[1] - third[1]) * (first[0] - third[0]) + (third[0] - second[0]) * (first[1] - third[1]);
      if (Math.abs(divisor) < 1e-12) continue;
      if (!isEye) {
        const [baseFirst, baseSecond, baseThird] = vertices.map(vertex => geometry.positions.subarray(vertex * 3, vertex * 3 + 3));
        const baseDivisor = (baseSecond[1] - baseThird[1]) * (baseFirst[0] - baseThird[0]) + (baseThird[0] - baseSecond[0]) * (baseFirst[1] - baseThird[1]);
        assert.ok(baseDivisor * divisor > 0, `skin triangle ${triangle / 3} must not fold in pose ${pose}`);
      }
      triangles.push({ first, second, third, divisor, isEye, minimumX, maximumX, minimumY, maximumY });
    }
    return (horizontal, height, eyeball) => {
      let depth = -Infinity;
      for (const triangle of triangles) {
        if (triangle.isEye !== eyeball || horizontal < triangle.minimumX || horizontal > triangle.maximumX || height < triangle.minimumY || height > triangle.maximumY) continue;
        const { first, second, third, divisor } = triangle;
        const firstWeight = ((second[1] - third[1]) * (horizontal - third[0]) + (third[0] - second[0]) * (height - third[1])) / divisor;
        const secondWeight = ((third[1] - first[1]) * (horizontal - third[0]) + (first[0] - third[0]) * (height - third[1])) / divisor;
        const thirdWeight = 1 - firstWeight - secondWeight;
        if (Math.min(firstWeight, secondWeight, thirdWeight) >= -1e-6) depth = Math.max(depth, firstWeight * first[2] + secondWeight * second[2] + thirdWeight * third[2]);
      }
      return depth;
    };
  };
  const openDepth = projectFace([0, 0, 0, 0]);
  for (const side of [-1, 1]) {
    for (const horizontal of [side * 0.4 - 0.055, side * 0.4, side * 0.4 + 0.055]) {
      const eyeDepth = openDepth(horizontal, 0.155, true);
      const openSkin = openDepth(horizontal, 0.155, false);
      assert.ok(eyeDepth > openSkin + 0.008, `eye ${side} sits in an open socket`);
    }
  }
  let coveredRays = 0;
  for (const pose of [[1, 0, 0, 0], Array.from(weights), [1, 1, 1, 1], [1, 1, 1, -1]]) {
    const closedDepth = projectFace(pose);
    for (const side of [-1, 1]) {
      for (let column = -10; column <= 10; column++) {
        for (let row = -4; row <= 4; row++) {
          const horizontal = side * 0.4 + column * 0.0195;
          const height = 0.155 + row * 0.018;
          const eyeDepth = closedDepth(horizontal, height, true);
          if (!Number.isFinite(eyeDepth)) continue;
          const skinDepth = closedDepth(horizontal, height, false);
          assert.ok(skinDepth > eyeDepth + 0.003, `closed lid leaks at [${horizontal}, ${height}], pose ${pose}: skin ${skinDepth}, eye ${eyeDepth}`);
          coveredRays++;
        }
      }
    }
  }
  assert.ok(coveredRays > 800, 'cover corners, upper/lower edges and independent expression combinations');
  const closedPose = Array.from(weights);
  scene.animate(19);
  scene.animate(17.65);
  assert.ok(weights[0] > 0.999);
  assert.deepEqual(Array.from(weights), closedPose);
  assert.equal(face.morph.weights, weights);
  assert.equal(face.geometry, geometry);
  scene.animate(17.9);
  assert.equal(weights[0], 0);
  const laboratory = createFilmScenes().laboratory;
  const actors = laboratory.parts.filter(part => part.name === 'Continuous sculpted head');
  assert.equal(actors.length, 2);
  assert.equal(actors[0].geometry, actors[1].geometry);
  assert.notEqual(actors[0].morph, actors[1].morph);
  laboratory.animate(2.7);
  assert.ok(actors[0].morph.weights[0] > 0.999);
  assert.equal(actors[1].morph.weights[0], 0);
  assert.notDeepEqual(Array.from(actors[0].morph.weights), Array.from(actors[1].morph.weights));
});

test('open and closed lids retain smooth surface normals throughout the brow range', () => {
  const scene = createFilmScenes().portrait;
  const face = scene.parts.find(part => part.morph);
  const geometry = face.geometry;
  scene.animate(17.65);
  const actualPose = Array.from(face.morph.weights);
  const poses = [actualPose];
  for (const blink of [0, 0.5, 1]) {
    for (const brow of [0, 0.25, 0.5, 0.75, 1]) {
      for (const mouth of [0, 1]) poses.push([blink, brow, mouth, 0]);
    }
  }
  const composedPoint = (horizontal, vertical, pose) => {
    const base = sampleScientistHead(horizontal, vertical);
    const result = [...base];
    for (let target = 0; target < pose.length; target++) {
      if (!pose[target]) continue;
      const posed = sampleScientistHead(horizontal, vertical, target);
      for (let axis = 0; axis < 3; axis++) result[axis] += pose[target] * (posed[axis] - base[axis]);
    }
    return result;
  };
  const minima = { open: 1, partial: 1, closed: 1, actual: 1 };
  for (const pose of poses) {
    let minimum = 1;
    for (let row = 62; row < 82; row++) {
      for (let column = 20; column < 78; column++) {
        const vertex = (row * 193 + column) * 3;
        const base = geometry.positions.subarray(vertex, vertex + 3);
        if (Math.abs(Math.abs(base[0]) - 0.4) > 0.25 || Math.abs(base[1] - 0.155) > 0.12) continue;
        const horizontal = column / 192;
        const vertical = row / 160;
        const right = composedPoint(horizontal + 0.0001, vertical, pose);
        const left = composedPoint(horizontal - 0.0001, vertical, pose);
        const below = composedPoint(horizontal, vertical + 0.0001, pose);
        const above = composedPoint(horizontal, vertical - 0.0001, pose);
        const tangent = right.map((value, axis) => value - left[axis]);
        const bitangent = below.map((value, axis) => value - above[axis]);
        const expected = [
          tangent[1] * bitangent[2] - tangent[2] * bitangent[1],
          tangent[2] * bitangent[0] - tangent[0] * bitangent[2],
          tangent[0] * bitangent[1] - tangent[1] * bitangent[0],
        ];
        const blended = [0, 1, 2].map(axis => geometry.morphTargets.reduce((value, target, index) => value + pose[index] * target.normals[vertex + axis], geometry.normals[vertex + axis]));
        const alignment = expected.reduce((sum, value, axis) => sum + value * blended[axis], 0) / Math.hypot(...expected) / Math.hypot(...blended);
        minimum = Math.min(minimum, alignment);
      }
    }
    const state = pose === actualPose ? 'actual' : pose[0] === 0 ? 'open' : pose[0] === 1 ? 'closed' : 'partial';
    minima[state] = Math.min(minima[state], minimum);
    assert.ok(minimum > 0.985, `combined surface normal agreement ${minimum} for pose ${pose}`);
  }
  console.log(JSON.stringify({ eyelidNormalAgreement: minima }));
});
