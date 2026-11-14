export function createAgentPreviewFixture() {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'pedestal', type: 'lathe', profile: [[0,0],[0.8,0],[0.9,0.07],[0.9,0.16],[0.74,0.22],[0.48,0.28],[0.42,0.34],[0,0.34]], segments: 64 },
      { id: 'bulb', type: 'sphere', segments: 48, rings: 32 },
      { id: 'ring', type: 'torus', tubeRadius: 0.025, segments: 80, sides: 12 },
      { id: 'post', type: 'cylinder', segments: 40, bevel: 0.02, bevelSegments: 4 },
      { id: 'rail', type: 'tube', path: [[-0.65,-0.35,0],[-0.68,0.3,0],[-0.5,1.05,0],[0,1.38,0],[0.5,1.05,0],[0.68,0.3,0],[0.65,-0.35,0]], radius: 0.026, segments: 80, radialSegments: 12 },
      { id: 'fin', type: 'extrude', contour: [[0,0],[0.28,0],[0.38,0.2],[0.18,0.4],[0,0.32]], depth: 0.035, bevel: 0.008, bevelSegments: 2 },
      { id: 'panel', type: 'box', bevel: 0.06, subdivisions: 4 },
    ],
    materials: [
      { id: 'porcelain', color: [0.7,0.8,0.77], metallic: 0.15, roughness: 0.27 },
      { id: 'brass', color: [0.58,0.3,0.06], metallic: 0.85, roughness: 0.25 },
      { id: 'teal', color: [0.015,0.12,0.14], metallic: 0.72, roughness: 0.3 },
      { id: 'light', color: [0.23,0.8,0.65], metallic: 0.1, roughness: 0.21, emission: 2, emissiveColor: [0.23,0.8,0.65] },
    ],
    nodes: [
      { id: 'lamp', label: 'Aster lamp', translation: [0,0.82,0] },
      { id: 'foot', parent: 'lamp', geometry: 'pedestal', material: 'porcelain', translation: [0,-0.8,0] },
      { id: 'stem', parent: 'lamp', geometry: 'post', material: 'teal', translation: [0,-0.15,0], scale: [0.12,0.72,0.12] },
      { id: 'glow', parent: 'lamp', geometry: 'bulb', material: 'light', translation: [0,0.55,0], scale: [0.3,0.48,0.3] },
      { id: 'switch', parent: 'lamp', geometry: 'panel', material: 'teal', translation: [0,-0.65,0.82], scale: [0.16,0.06,0.04] },
    ],
    camera: { eye: [3.7,2.82,4.6], target: [0,1.06,0], fov: 36, near: 0.1, far: 40 },
  };
  for (let index = 0; index < 4; index++) {
    const angle = index * Math.PI / 4;
    recipe.nodes.push({ id: `rail-${index}`, parent: 'lamp', geometry: 'rail', material: 'brass', rotation: [0,Math.sin(angle/2),0,Math.cos(angle/2)] });
  }
  for (let index = 0; index < 3; index++) {
    recipe.nodes.push({ id: `ring-${index}`, parent: 'lamp', geometry: 'ring', material: index === 1 ? 'teal' : 'brass', translation: [0,-0.38 + index * 0.34,0], scale: [0.65,0.65,0.65], rotation: [Math.SQRT1_2,0,0,Math.SQRT1_2] });
  }
  for (let index = 0; index < 8; index++) {
    const angle = index * Math.PI / 4;
    recipe.nodes.push({ id: `fin-${index}`, parent: 'lamp', geometry: 'fin', material: 'brass', translation: [Math.sin(angle)*0.43,-0.46,Math.cos(angle)*0.43], rotation: [0,Math.sin(angle/2),0,Math.cos(angle/2)], scale: [0.4,0.4,0.4] });
  }
  return recipe;
}
