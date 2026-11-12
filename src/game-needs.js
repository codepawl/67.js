// What a game recipe needs from the runtime, as pure data checks. startGame loads an optional piece only when a recipe needs it,
// and the web export copies that piece only when the same check says so, so a plain game does not carry the physics engine or the
// texture swap code.

const UNSUPPORTED_SHAPES = ['trimesh', 'cone', 'compound'];

/** Why a recipe cannot play physics in a game (the engine is Jolt), or null. */
export function gamePhysicsProblem(recipe) {
  const physics = recipe.physics;
  if (!physics?.bodies?.length) return 'game.physics is true, but the recipe has no physics section with bodies. Add one with set-physics, or set game.physics to false with set-game.';
  if (physics.joints?.length || physics.ragdoll) return 'The game physics engine builds no joints or ragdolls yet. Remove physics.joints and physics.ragdoll, or set game.physics to false with set-game.';
  const unsupported = physics.bodies.find(body => UNSUPPORTED_SHAPES.includes(body.shape));
  if (unsupported) return `Body "${unsupported.node}" has shape ${unsupported.shape}, which the game physics engine does not build. Use box, ball, capsule or convex (give a fixed body shape "box": its default is trimesh).`;
  return null;
}

// A textured part is swapped by replaceParts only once the replace-textured-parts addon is loaded, and the first scene update
// after a pattern or map bake can swap the parts.
export function hasTexturedMaterial(recipe) {
  return (recipe.materials ?? []).some(material => Object.keys(material).some(key => key === 'pattern' || key === 'map' || key.endsWith('Map')));
}
