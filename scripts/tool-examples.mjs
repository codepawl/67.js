/**
 * One complete, valid call for each of the four hardest tools. scene_capabilities serves them from the MCP server (not the scene bundle) under the topic
 * `examples`, so the tool schemas stay small: they are read on every turn and this text only when asked for.
 * A test sends every example through the tool's own input schema and the scene it targets.
 */
export const AGENT_TOOL_EXAMPLES = Object.freeze({
  scene_create: Object.freeze({
    recipe: {
      format: '67js.scene', schemaVersion: 1,
      geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
      materials: [{ id: 'wood', color: [0.55, 0.36, 0.2], roughness: 0.8 }, { id: 'stone', color: [0.5, 0.5, 0.52] }],
      nodes: [
        { id: 'floor', geometry: 'cube', material: 'stone', translation: [0, -0.05, 0], scale: [8, 0.1, 8] },
        { id: 'crate', geometry: 'cube', material: 'wood', translation: [0, 0.5, 0] },
      ],
      camera: { eye: [3, 2, 4], target: [0, 0.5, 0], fov: 45 },
    },
  }),
  scene_apply: Object.freeze({
    expectedRevision: 0,
    operations: [
      { type: 'set-node', id: 'crate', translation: [1, 0.5, 0] },
      { type: 'set-material', id: 'wood', color: [0.7, 0.2, 0.1], roughness: 0.5 },
      { type: 'add-node', node: { id: 'crate2', geometry: 'cube', material: 'wood', translation: [-1.2, 0.5, 0], scale: [1, 0.6, 1] } },
      { type: 'set-camera', eye: [4, 3, 5], target: [0, 0.5, 0] },
    ],
  }),
  scene_create_asset: Object.freeze({
    recipe: {
      format: '67js.asset', schemaVersion: 1,
      assetId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      camera: { eye: [2, 1.5, 3], target: [0, 0.8, 0], fov: 40 },
      root: { rotation: [0, 0.7071, 0, 0.7071] },
    },
  }),
  scene_render_submit: Object.freeze({
    expectedRevision: 1,
    settings: { kind: 'image', width: 1280, height: 720 },
  }),
  notes: 'sessionId stays out: the active scene is used. expectedRevision is the revision the last call returned. scene_create_asset takes assetId from scene_asset_catalog. Use topic examples.<tool> for one.',
});
