// The scene validator for pack recipes and materials. It runs in `npm run pack:check` and in tests, never in the MCP server:
// the server does not carry the scene engine (scripts/build-mcp.mjs), and scene_create and scene_apply run these same
// checks on a recipe or material when an agent uses it.
import { createAgentScene, loadAgentSceneModules } from '../src/agent-scene.js';

/** Throws the error scene_create would throw for this recipe; a material is checked as the only material of an empty scene. */
export async function validatePackScene(kind, id, json) {
  const recipe = kind === 'recipes'
    ? json
    : { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [{ ...json, id: json?.id ?? id }], nodes: [] };
  await loadAgentSceneModules(recipe);
  createAgentScene(recipe);
}
