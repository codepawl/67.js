// The two scenes of native-job-check.mjs: 200 copies of one mesh with an emissive shared mesh and a shadow-only copy, and
// twelve meshes none of which is shared.
function repeatedRecipe() {
  const nodes = [];
  const side = 6;
  for (let index = 0; index < 200; index++) {
    const column = index % side;
    const row = Math.floor(index / side) % side;
    const layer = Math.floor(index / (side * side));
    const glowing = index % 10 === 0;
    nodes.push({
      id: `ball-${index}`,
      geometry: 'ball',
      material: glowing ? 'glow' : ['red', 'blue', 'gold'][index % 3],
      translation: [(column - side / 2) * 1.2, (row - side / 2) * 1.2, -layer * 1.2],
      scale: [0.4 + 0.05 * (index % 3), 0.4, 0.4 + 0.05 * (index % 4)],
    });
  }
  nodes.push({ id: 'lamp-left', geometry: 'panel', material: 'glow', translation: [-5, 0, 4], scale: [0.2, 2, 2] });
  nodes.push({ id: 'lamp-right', geometry: 'panel', material: 'glow', translation: [5, 0, 4], scale: [0.2, 2, 2] });
  nodes.push({ id: 'gobo', geometry: 'panel', material: 'red', translation: [0, 4, 3], scale: [3, 0.1, 1], shadowOnly: true });
  return nodes;
}

function distinctRecipe() {
  const nodes = [];
  for (let index = 0; index < 12; index++) {
    nodes.push({
      id: `solid-${index}`,
      geometry: `solid-${index}`,
      material: ['red', 'blue', 'gold', 'glow'][index % 4],
      translation: [((index % 4) - 1.5) * 1.6, (Math.floor(index / 4) - 1) * 1.6, 0],
      scale: [0.5, 0.5, 0.5],
    });
  }
  return nodes;
}

export function recipeFor(scene) {
  const materials = [
    { id: 'red', color: [0.8, 0.2, 0.15], roughness: 0.5 },
    { id: 'blue', color: [0.15, 0.4, 0.85], roughness: 0.3, metallic: 0.8 },
    { id: 'gold', color: [0.9, 0.75, 0.25], roughness: 0.6 },
    { id: 'glow', color: [1, 0.7, 0.4], roughness: 0.7, emission: 4 },
  ];
  const camera = { eye: [0, 0, 14], target: [0, 0, -2], fov: 50, near: 0.1, far: 60 };
  const geometries = scene === 'repeated'
    ? [{ id: 'ball', type: 'sphere', segments: 16, rings: 8 }, { id: 'panel', type: 'box', bevel: 0 }]
    : Array.from({ length: 12 }, (_, index) => ({ id: `solid-${index}`, type: index % 2 ? 'box' : 'sphere', ...(index % 2 ? { bevel: 0 } : { segments: 12 + index, rings: 8 }) }));
  return { format: '67js.scene', schemaVersion: 1, geometries, materials, nodes: scene === 'repeated' ? repeatedRecipe() : distinctRecipe(), camera };
}
