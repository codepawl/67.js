function rotationZ(angle) {
  return [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
}

function headRotation(angle) {
  const pitch = -0.8;
  return [Math.sin(pitch / 2) * Math.cos(angle / 2), Math.sin(pitch / 2) * Math.sin(angle / 2),
    Math.cos(pitch / 2) * Math.sin(angle / 2), Math.cos(pitch / 2) * Math.cos(angle / 2)];
}

/** A JSON-only articulated lamp for the real MCP motion and rendering proof. */
export function createAgentMotionFixture() {
  const nodes = [];
  function mesh(id, geometry, material, parent, translation, scale, rotation = [0, 0, 0, 1]) {
    nodes.push({ id, geometry, material, parent, translation, scale, rotation });
  }
  const alongZ = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  mesh('desk', 'cylinder', 'desk', null, [0, -0.035, 0], [4, 0.07, 4]);
  mesh('base-foot', 'cylinder', 'rubber', null, [0, 0.06, 0], [0.57, 0.12, 0.57]);
  mesh('base-shell', 'cylinder', 'paint', null, [0, 0.14, 0], [0.54, 0.14, 0.54]);
  mesh('base-cap', 'cylinder', 'paint', null, [0, 0.225, 0], [0.3, 0.06, 0.3]);
  nodes.push({ id: 'shoulder', translation: [0, 0.34, 0], rotation: rotationZ(-0.46) });
  mesh('shoulder-axle', 'cylinder', 'steel', 'shoulder', [0, 0, 0], [0.13, 0.52, 0.13], alongZ);
  for (const side of [-1, 1]) {
    const suffix = side < 0 ? 'back' : 'front';
    mesh(`lower-arm-${suffix}`, 'box', 'paint', 'shoulder', [0, 0.7, side * 0.15], [0.105, 1.34, 0.075]);
    mesh(`shoulder-bolt-${suffix}`, 'cylinder', 'brass', 'shoulder', [0, 0, side * 0.29], [0.078, 0.055, 0.078], alongZ);
    mesh(`spring-${suffix}`, 'spring', 'steel', 'shoulder', [0.15, 0.25, side * 0.15], [1, 1, 1]);
  }
  nodes.push({ id: 'elbow', parent: 'shoulder', translation: [0, 1.4, 0], rotation: rotationZ(1.12) });
  mesh('elbow-axle', 'cylinder', 'steel', 'elbow', [0, 0, 0], [0.12, 0.52, 0.12], alongZ);
  for (const side of [-1, 1]) {
    const suffix = side < 0 ? 'back' : 'front';
    mesh(`upper-arm-${suffix}`, 'box', 'paint', 'elbow', [0, 0.52, side * 0.15], [0.105, 1, 0.075]);
    mesh(`elbow-bolt-${suffix}`, 'cylinder', 'brass', 'elbow', [0, 0, side * 0.29], [0.078, 0.055, 0.078], alongZ);
  }
  nodes.push({ id: 'head', parent: 'elbow', translation: [0, 1.04, 0], rotation: headRotation(-0.68) });
  mesh('head-axle', 'cylinder', 'steel', 'head', [0, 0, 0], [0.095, 0.42, 0.095], alongZ);
  mesh('shade', 'shade', 'paint', 'head', [0, -0.02, 0], [1, 1, 1]);
  mesh('reflector', 'reflector', 'cream', 'head', [0, -0.02, 0], [1, 1, 1]);
  mesh('bulb', 'sphere', 'bulb', 'head', [0, -0.30, 0], [0.17, 0.2, 0.17]);
  mesh('socket', 'cylinder', 'steel', 'head', [0, -0.08, 0], [0.085, 0.16, 0.085]);
  const springPath = Array.from({ length: 97 }, (_, index) => {
    const angle = index / 96 * Math.PI * 16;
    return [Math.cos(angle) * 0.05, index / 96 * 0.7, Math.sin(angle) * 0.05];
  });
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'box', type: 'box', bevel: 0.14, subdivisions: 3 },
      { id: 'cylinder', type: 'cylinder', segments: 48, bevel: 0.04, bevelSegments: 4 },
      { id: 'sphere', type: 'sphere', segments: 40, rings: 24 },
      { id: 'shade', type: 'lathe', segments: 64,
        profile: [[0.085, 0], [0.13, -0.1], [0.45, -0.48], [0.5, -0.56], [0.485, -0.58], [0.435, -0.5], [0.11, -0.1], [0.07, 0], [0.085, 0]] },
      { id: 'reflector', type: 'lathe', segments: 64,
        profile: [[0.074, -0.04], [0.108, -0.11], [0.426, -0.5], [0.47, -0.556], [0.465, -0.56], [0.422, -0.5], [0.1, -0.11], [0.068, -0.04], [0.074, -0.04]] },
      { id: 'spring', type: 'tube', path: springPath, radius: 0.012, radialSegments: 8 },
    ],
    materials: [
      { id: 'paint', color: [0.06, 0.32, 0.27], metallic: 0.55, roughness: 0.28 },
      { id: 'steel', color: [0.25, 0.29, 0.31], metallic: 0.92, roughness: 0.25 },
      { id: 'brass', color: [0.63, 0.36, 0.12], metallic: 0.85, roughness: 0.27 },
      { id: 'cream', color: [0.72, 0.66, 0.49], metallic: 0.2, roughness: 0.35 },
      { id: 'rubber', color: [0.012, 0.016, 0.019], roughness: 0.9 },
      { id: 'desk', color: [0.08, 0.10, 0.12], roughness: 0.72 },
      { id: 'bulb', color: [0.95, 0.67, 0.30], emissiveColor: [1, 0.57, 0.22], emission: 3, roughness: 0.35 },
    ],
    nodes,
    camera: { eye: [4.2, 2.9, 5.4], target: [0.15, 1.2, 0], fov: 34, near: 0.1, far: 40 },
    environment: { world: true, daylight: 1, keyColor: [0.8, 0.9, 1], keyIntensity: 1.6,
      fillIntensity: 3, ambientIntensity: 1.3, lightDirection: [-0.7, 1, 0.7],
      skyTop: [0.10, 0.13, 0.17], skyBottom: [0.22, 0.25, 0.30], fogDensity: 0 },
    effects: { exposure: 1.15, grain: 0, vignette: 0.15, bloom: { strength: 0.16, threshold: 1.5 } },
    shadow: { target: [0.1, 1.1, 0], extent: 4.5, distance: 9, far: 22 },
    motion: {
      duration: 3,
      tracks: [
        { kind: 'node', id: 'shoulder', property: 'rotation', interpolation: 'SMOOTH', keyframes: [
          { time: 0, value: rotationZ(-0.46) }, { time: 1.5, value: rotationZ(-0.20) }, { time: 3, value: rotationZ(-0.55) },
        ] },
        { kind: 'node', id: 'elbow', property: 'rotation', interpolation: 'SMOOTH', keyframes: [
          { time: 0, value: rotationZ(1.12) }, { time: 1.5, value: rotationZ(0.65) }, { time: 3, value: rotationZ(1.35) },
        ] },
        { kind: 'node', id: 'head', property: 'rotation', interpolation: 'SMOOTH', keyframes: [
          { time: 0, value: headRotation(-0.68) }, { time: 1.5, value: headRotation(-0.85) }, { time: 3, value: headRotation(-0.48) },
        ] },
        { kind: 'material', id: 'bulb', property: 'emission', interpolation: 'SMOOTH', keyframes: [
          { time: 0, value: 1 }, { time: 1.5, value: 5 }, { time: 3, value: 2 },
        ] },
        { kind: 'camera', property: 'eye', interpolation: 'SMOOTH', keyframes: [
          { time: 0, value: [4.2, 2.9, 5.4] }, { time: 3, value: [3.4, 2.6, 5.2] },
        ] },
      ],
    },
  };
}
