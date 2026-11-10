/**
 * Diagnostics for things that load or validate without error but do not do what the agent probably meant: a material
 * field the renderer ignores, an asset feature that is accepted but not drawn, a rig with nothing to move. Each has a
 * kind, a severity, a target (the material, node or asset it concerns), a message and a fix that names the next action.
 * Reads of an inspected scene include them only when there is something to say, to keep default results small.
 */
const PLAIN_SURFACE_TAGS = new Set(['surface', 'gltf']);
const LAYER_FIELDS = ['clearcoat', 'sheenColor', 'specular', 'specularColor', 'anisotropy', 'iridescence'];
// The pass that draws transmission is a separate shader without these layers.
const FIELDS_IGNORED_BY_TRANSMISSION = ['anisotropy', 'iridescence'];
const TRANSMISSION_DETAIL_FIELDS = ['thickness', 'attenuationColor', 'attenuationDistance'];

function diagnostic(kind, severity, target, message, fix) {
  return { kind, severity, target, message, fix };
}

function hasValue(material, field) {
  const value = material[field];
  if (Array.isArray(value)) return value.some(component => component !== 0);
  return typeof value === 'number' && value !== 0;
}

function materialProblems(material) {
  const problems = [];
  const tag = material.tag ?? 'surface';
  const transmitting = hasValue(material, 'transmission');
  if (tag !== 'surface' && tag !== 'liquid') {
    for (const field of LAYER_FIELDS.filter(layer => hasValue(material, layer))) {
      problems.push(diagnostic('ignored-material-field', 'warning', material.id,
        `${field} is ignored on a material with tag ${tag}.`,
        `Remove ${field}, or set the material tag to surface with scene_apply set-material.`));
    }
  }
  if (transmitting) {
    for (const field of FIELDS_IGNORED_BY_TRANSMISSION.filter(layer => hasValue(material, layer))) {
      problems.push(diagnostic('ignored-material-field', 'warning', material.id,
        `${field} is ignored on a transmitting material.`,
        `Set transmission to 0 to see ${field}, or remove ${field}.`));
    }
  } else {
    for (const field of TRANSMISSION_DETAIL_FIELDS.filter(detail => hasValue(material, detail))) {
      problems.push(diagnostic('ignored-material-field', 'warning', material.id,
        `${field} only matters with transmission, and transmission is 0.`,
        `Set transmission above 0 for glass or gems, or remove ${field}.`));
    }
  }
  if (transmitting && (material.alphaMode === 'blend' || material.opacity < 1)) {
    problems.push(diagnostic('transmission-blended', 'warning', material.id,
      'A transmitting material that is also blended does not refract what is behind it.',
      'Set opacity to 1 and alphaMode to opaque for refraction, or drop transmission and keep the blended look.'));
  }
  if (material.pattern && (tag === 'liquid' || tag === 'foam' || tag === 'unlit')) {
    problems.push(diagnostic('ignored-material-field', 'warning', material.id,
      `pattern is not applied to a material with tag ${tag}.`,
      'Move the pattern to a surface material, or remove it.'));
  }
  return problems;
}

/** Material and resource diagnostics for a normalized procedural recipe. */
export function recipeDiagnostics(recipe) {
  const problems = recipe.materials.flatMap(materialProblems);
  const usedMaterials = new Set(recipe.nodes.map(node => node.material).filter(Boolean));
  const usedGeometries = new Set(recipe.nodes.map(node => node.geometry).filter(Boolean));
  for (const material of recipe.materials.filter(candidate => !usedMaterials.has(candidate.id))) {
    problems.push(diagnostic('unused-material', 'info', material.id,
      `Material ${material.id} is used by no node.`,
      'Assign it to a node with scene_apply set-node, or remove it with remove-material.'));
  }
  for (const geometry of recipe.geometries.filter(candidate => !usedGeometries.has(candidate.id))) {
    problems.push(diagnostic('unused-geometry', 'info', geometry.id,
      `Geometry ${geometry.id} is used by no node, so nothing draws it.`,
      'Add a node that uses it with scene_apply add-node, or remove it with remove-geometry.'));
  }
  return problems;
}

/**
 * The scene looks like a closed room and asks for no bake, so the world's light reaches it through the walls and the room
 * renders lifted and flat. `share` is the share of rays from the middle of the scene that hit an inner face.
 */
export function closedRoomDiagnostic(share, litByLampsOnly = false) {
  if (litByLampsOnly) {
    return diagnostic('closed-room-without-bake', 'warning', 'bake',
      `${Math.round(share * 100)} percent of rays from the middle of the scene hit a wall, so this is a closed room lit only by its point, spot or area lights. Without a bake the walls bounce light only as one average colour over the whole room: no brighter corner beside a lamp, no colour bleeding off a red wall onto the floor next to it.`,
      'Add "bake": { "preset": "standard" } (scene_apply set-bake) for bounced light that follows the lamps and the wall colours.');
  }
  return diagnostic('closed-room-without-bake', 'warning', 'bake',
    `${Math.round(share * 100)} percent of rays from the middle of the scene hit a wall, so this is a closed room, and without a bake the world's light still reaches it: the room renders lifted and grey, with weak contact shadows.`,
    'Add "bake": { "preset": "standard" } (scene_apply set-bake). It darkens what the sky cannot see and adds bounced light, halving the indirect-light error of a closed room.');
}

/**
 * Rig and asset diagnostics. `warnings` are the decoder's notes about features it accepted but does not draw.
 */
export function assetDiagnostics({ assetId, warnings = [], skinnedParts, jointCount, clipCount }) {
  const problems = warnings.map(warning => diagnostic('unsupported-asset-feature', 'warning', assetId,
    String(warning),
    'The asset loads without it. Remove the feature from the GLB, or bake it into the base colour texture.'));
  if (skinnedParts > 0 && jointCount === 0) {
    problems.push(diagnostic('rig-without-joints', 'error', assetId,
      `${skinnedParts} meshes are skinned but the asset has no joint nodes, so no pose or ik can move them.`,
      'Re-export the GLB with its armature, or use an asset that has joints.'));
  }
  if (skinnedParts === 0 && jointCount > 0) {
    problems.push(diagnostic('rig-without-skin', 'warning', assetId,
      `The asset has ${jointCount} joint nodes but no mesh is skinned to them, so moving a joint changes nothing you can see.`,
      'Move the parent node with set-asset-node instead, or fix the skin binding in the source file.'));
  }
  if (clipCount === 0) {
    problems.push(diagnostic('asset-without-clips', 'info', assetId,
      'The asset has no animation clips, so set-animation and the export clip option are unavailable.',
      'Pose it with motion tracks or ik, or choose an asset that ships clips.'));
  }
  return problems;
}
