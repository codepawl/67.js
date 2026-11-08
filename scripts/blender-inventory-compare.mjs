// Compares bench/parity/blender-inventory.json (from scripts/blender-inventory.py) with what 67js records:
// docs/parity.md, scene_capabilities and the MCP tool list. Writes bench/parity/blender-inventory-report.md.
// Run: node scripts/blender-inventory-compare.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { parseLedger } from './parity-ledger.mjs';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { createAgentMcpServer } from './mcp-server.mjs';

const STATUSES = ['done', 'partial', 'missing', 'out of scope'];
const inventoryUrl = new URL('../bench/parity/blender-inventory.json', import.meta.url);
const reportUrl = new URL('../bench/parity/blender-inventory-report.md', import.meta.url);

function normalizeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function listMcpToolNames() {
  const server = createAgentMcpServer({ async close() {} });
  const client = new Client({ name: '67js-inventory-compare', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.map(tool => tool.name);
}

// ---------- ledger lookups ----------

function ledgerRowsEndingWith(manualRows, suffix) {
  const byName = new Map();
  for (const row of manualRows) {
    const lastSegment = row.path.split(' > ').pop();
    if (lastSegment.endsWith(suffix)) byName.set(normalizeName(lastSegment.slice(0, -suffix.length)), row);
  }
  return byName;
}

function summarizeItems(items) {
  const counts = Object.fromEntries([...STATUSES, 'not in ledger'].map(status => [status, 0]));
  for (const item of items) counts[item.status] += 1;
  return counts;
}

// ---------- modifiers and constraints: matched one by one against ledger rows ----------

function compareModifiers(inventory, manualRows) {
  const ledger = ledgerRowsEndingWith(manualRows, ' Modifier');
  const items = [];
  const seen = new Set();
  for (const modifier of inventory.modifiers_and_constraints.modifier_types) {
    if (seen.has(modifier.identifier)) continue;
    seen.add(modifier.identifier);
    if (modifier.identifier.startsWith('GREASE_PENCIL') || modifier.identifier === 'LINEART') {
      items.push({ name: `${modifier.name} (Grease Pencil)`, status: 'out of scope', note: 'Grease Pencil, docs/goal.md' });
      continue;
    }
    if (modifier.identifier === 'SURFACE') {
      items.push({ name: modifier.name, status: 'out of scope', note: 'Internal helper of the physics modifiers' });
      continue;
    }
    const row = ledger.get(normalizeName(modifier.name));
    items.push(row
      ? { name: modifier.name, status: row.status, note: row.path }
      : { name: modifier.name, status: 'not in ledger', note: '' });
  }
  return items;
}

const MOTION_TRACKING_CONSTRAINTS = new Set(['Camera Solver', 'Follow Track', 'Object Solver']);

function compareConstraints(inventory, manualRows) {
  const ledger = ledgerRowsEndingWith(manualRows, ' Constraint');
  return inventory.modifiers_and_constraints.constraint_types.map(constraint => {
    if (MOTION_TRACKING_CONSTRAINTS.has(constraint.name)) {
      return { name: constraint.name, status: 'out of scope', note: 'Motion Tracking, docs/goal.md' };
    }
    const row = ledger.get(normalizeName(constraint.name));
    return row ? { name: constraint.name, status: row.status, note: row.path } : { name: constraint.name, status: 'not in ledger', note: '' };
  });
}

// ---------- node trees: the ledger has one row per tree, so status comes from a table of categories ----------
// These tables are judgement from reading docs/parity.md and scene_capabilities (inferred, not measured).

const GEOMETRY_NODE_CATEGORY_STATUS = {
  'Attribute': ['partial', 'Fields read position, normal, index, tags and noise; no Capture, Store Named or Transfer Attribute'],
  'Color': ['missing', 'Only colours in materials'],
  'Input > Constant': ['partial', 'Numbers and vectors inside field expressions'],
  'Input > Scene': ['missing', 'No object, collection or scene-time inputs'],
  'Input > Import': ['out of scope', 'GLB is the exchange format, docs/goal.md'],
  'Input > Gizmo': ['out of scope', 'Mouse interface'],
  'Geometry': ['partial', 'Parent nodes group parts; no Join Geometry node'],
  'Geometry > Operations': ['partial', 'meshEdits and mesh_stack hold most operations; no Bounding Box or Convex Hull'],
  'Geometry > Read': ['partial', 'position, normal, index, tag'],
  'Geometry > Write': ['partial', 'set_position and tag'],
  'Geometry > Sample': ['missing', 'No raycast, proximity or nearest-surface sampling in fields'],
  'Grease Pencil > Operations': ['out of scope', 'Grease Pencil, docs/goal.md'],
  'Grease Pencil > Read': ['out of scope', 'Grease Pencil, docs/goal.md'],
  'Grease Pencil > Write': ['out of scope', 'Grease Pencil, docs/goal.md'],
  'Instances': ['partial', 'instancing sources grid, scatter, surface; no per-instance transforms or realize'],
  'Material': ['partial', 'Tags and materials per face tag'],
  'Mesh > Operations': ['partial', 'extrude, inset, bevel, boolean, subdivide, triangulate, split edges, flip normals; no dual mesh, scale elements, mesh to curve'],
  'Mesh > Primitives': ['partial', 'box, cylinder, sphere, torus, grid; no cone, ico sphere, line, circle'],
  'Mesh > Read': ['partial', 'position, normal, index'],
  'Mesh > Sample': ['missing', 'No sample nearest or UV sample'],
  'Mesh > Topology': ['missing', 'No corner, edge or face topology inputs in fields'],
  'Mesh > UV': ['partial', 'uv_unwrap; no UV nodes in fields'],
  'Mesh > Write': ['partial', 'set_position and tag'],
  'Output': ['missing', 'No viewer or group output; edits are a list'],
  'Point': ['missing', 'No point clouds, issue #43'],
  'Simulation': ['missing', 'No simulation zones'],
  'Texture': ['partial', 'noise and random in fields'],
  'Utilities': ['partial', 'Switch and random value as if and random'],
  'Utilities > Deprecated': ['out of scope', 'Deprecated by Blender'],
  'Utilities > Field': ['partial', 'Field expressions; no accumulate or evaluate-at-index'],
  'Utilities > List': ['missing', 'No lists'],
  'Utilities > Math': ['partial', 'add, sub, mul, div, min, max, pow, clamp, mix, comparisons, boolean and, or, not'],
  'Utilities > Matrix': ['missing', 'No matrices in fields'],
  'Utilities > Rotation': ['missing', 'No rotation values in fields'],
  'Utilities > Sound': ['out of scope', 'Audio analysis is not a geometry task'],
  'Utilities > Text': ['partial', 'text geometry; no string processing nodes'],
  'Utilities > Bundle': ['missing', 'No bundles'],
  'Utilities > Closure': ['missing', 'No closures'],
  'Utilities > Vector': ['partial', 'vec, dot, cross, length, normalize, distance'],
  'Volume > Operations': ['missing', 'No volume grids, issue #63'],
  'Volume > Primitives': ['missing', 'No volume grids, issue #63'],
  'Volume > Read': ['missing', 'No volume grids, issue #63'],
  'Volume > Sample': ['missing', 'No volume grids, issue #63'],
  'Volume > Write': ['missing', 'No volume grids, issue #63'],
  'Curve > Operations': ['partial', 'curve geometry sweeps a profile (Curve to Mesh); no resample, fillet or fill'],
  'Curve > Primitives': ['missing', 'No curve primitives'],
  'Curve > Read': ['missing', 'No curve inputs'],
  'Curve > Sample': ['missing', 'No curve sampling'],
  'Curve > Topology': ['missing', 'No curve topology'],
  'Curve > Write': ['missing', 'No curve attributes'],
  'Curve': ['partial', 'curve geometry'],
};

const SHADER_NODE_CATEGORY_STATUS = {
  'Color': ['partial', 'Material graph: ramp, mix, invert, maths; no hue, saturation, RGB curves or blackbody'],
  'Displacement': ['partial', 'height output becomes a normal map; no true displacement'],
  'Input': ['partial', 'uv and box mapping; no light path, fresnel, AO or attribute inputs'],
  'Input > Constant': ['partial', 'Numbers and vectors'],
  'Math': ['partial', 'add, sub, mul, div, min, max, pow, abs, clamp, smoothstep, mix'],
  'Output': ['partial', 'Material output only; no AOV, light or world output nodes'],
  'Shader': ['partial', 'One metal-roughness surface with clear coat, transmission, sheen, specular, subsurface; no BSDF mixing'],
  'Texture': ['partial', 'noise, voronoi, wave, checker, gradient; 11 pattern types; image maps'],
  'Utilities': ['out of scope', 'Script node runs agent code, docs/goal.md'],
  'Vector': ['partial', 'vec maths and box or uv mapping; no Mapping, Normal or Vector Rotate nodes'],
};

const COMPOSITOR_NODE_CATEGORY_STATUS = {
  'Color': ['partial', 'Grading and view transform in a fixed chain'],
  'Color > Adjust': ['partial', 'Exposure, contrast and looks in the fixed grading step'],
  'Creative': ['missing', 'No Kuwahara, pixelate or posterize'],
  'Filter': ['partial', 'FXAA and bloom only; no denoise node, glare modes or dilate'],
  'Filter > Blur': ['partial', 'Depth of field and camera motion blur are render features, not nodes'],
  'Input': ['missing', 'No node graph, issue #54'],
  'Input > Constant': ['missing', 'No node graph, issue #54'],
  'Input > Scene': ['missing', 'No node graph, issue #54'],
  'Keying': ['missing', 'No chroma keying'],
  'Mask': ['missing', 'No mask nodes or cryptomatte'],
  'Output': ['partial', 'PNG and MP4 output through render jobs'],
  'Tracking': ['out of scope', 'Motion Tracking, docs/goal.md'],
  'Transform': ['missing', 'No transform, crop or lens distortion nodes'],
  'Utilities': ['missing', 'No node graph, issue #54'],
};

const NODE_LABEL_OVERRIDES = {
  geometry: {
    'Set Position': 'done', 'Instance on Points': 'partial', 'Extrude Mesh': 'done', 'Subdivision Surface': 'done',
    'Triangulate': 'done', 'Mesh Boolean': 'done', 'Flip Faces': 'done', 'Split Edges': 'done', 'Mesh Bevel': 'done',
    'Curve to Mesh': 'partial', 'Set Material': 'partial', 'String to Curves': 'partial',
  },
  shader: { 'Principled BSDF': 'partial', 'Noise Texture': 'partial', 'Voronoi Texture': 'partial', 'Image Texture': 'partial', 'Material Output': 'done' },
  compositor: { 'Glare': 'missing', 'Viewer': 'out of scope', 'File Output': 'done' },
};

function compareNodeTree(tree, categoryStatus, overrides) {
  const items = [];
  const unmapped = [];
  const seen = new Set();
  for (const [category, nodes] of Object.entries(tree.add_menu_categories)) {
    const entry = categoryStatus[category];
    if (!entry) unmapped.push(category);
    const [status, note] = entry ?? ['missing', 'No 67js equivalent recorded'];
    for (const node of nodes) {
      if (seen.has(node.idname)) continue;
      seen.add(node.idname);
      items.push({ name: node.label, category, status: overrides[node.label] ?? status, note });
    }
  }
  for (const node of tree.not_in_add_menu) {
    if (seen.has(node.idname)) continue;
    const isGroupOrZone = /Group|Repeat|Simulation|For Each/.test(node.label);
    const isLegacy = /Legacy|Glossy/.test(node.label);
    items.push({
      name: node.label, category: 'Not in the Add menu',
      status: isLegacy ? 'out of scope' : isGroupOrZone ? 'missing' : 'missing',
      note: isGroupOrZone ? 'Node groups and zones need a node graph' : 'Legacy or hidden node',
    });
  }
  return { items, unmapped };
}

// ---------- physics ----------

function mapEnum(identifiers, table) {
  return identifiers.map(identifier => {
    const [status, note] = table[identifier] ?? ['missing', ''];
    return { name: identifier, status, note };
  });
}

function comparePhysics(inventory) {
  const physics = inventory.physics;
  const bodyShapes = { BOX: 'box', SPHERE: 'ball', CAPSULE: 'capsule', CONVEX_HULL: 'convex', MESH: 'trimesh' };
  const jointTypes = { FIXED: 'fixed', HINGE: 'revolute', SLIDER: 'prismatic', POINT: 'spherical' };
  const ids = key => physics[key].map(item => item.identifier);
  const groups = {
    'Rigid body type': mapEnum(ids('rigid_body_types'), { ACTIVE: ['done', 'dynamic'], PASSIVE: ['done', 'fixed and kinematic'] }),
    'Rigid body collision shape': mapEnum(ids('rigid_body_collision_shapes'),
      Object.fromEntries(Object.entries(bodyShapes).map(([blender, name]) => [blender, ['done', name]]))),
    'Rigid body constraint': mapEnum(ids('rigid_body_constraint_types'),
      Object.fromEntries(Object.entries(jointTypes).map(([blender, name]) => [blender, ['done', name]]))),
    'Force field': mapEnum(ids('force_field_types'), { NONE: ['out of scope', 'not a field'], FORCE: ['partial', 'gravity only'] }),
    'Particle system': mapEnum(ids('particle_system_types'), { EMITTER: ['partial', 'recipe particles emitter'], HAIR: ['partial', 'recipe particles hair'] }),
    'Fluid': mapEnum(ids('fluid_types'), { NONE: ['out of scope', 'not a fluid'], DOMAIN: ['partial', 'liquid tag and water presets, no grid solver'], FLOW: ['partial', 'water presets'], EFFECTOR: ['missing', ''] }),
    'Dynamic paint': mapEnum(ids('dynamic_paint_types'), {}),
    'Other simulations': [
      { name: 'Cloth', status: 'partial', note: 'set-cloth, sheet geometry' },
      { name: 'Soft body', status: 'missing', note: 'issue #62' },
      { name: 'Collision', status: 'partial', note: 'physics shapes and collision layers' },
    ],
  };
  const settingGroups = Object.entries(physics.settings).map(([name, properties]) => ({ name, count: properties.length }));
  return { groups, settingGroups };
}

// ---------- render, lights, camera, world, colour management, files ----------

function compareRender(inventory) {
  const colour = inventory.color_management;
  const viewTransformMap = { 'Khronos PBR Neutral': ['done', 'neutral'], 'AgX': ['done', 'agx'], 'ACES 2.0': ['partial', 'aces (ACES 1.3 style fit)'], 'ACES 1.3': ['partial', 'aces'] };
  const engineMap = { CYCLES: ['partial', 'CPU path tracer, addons/path-tracer'], BLENDER_EEVEE: ['partial', 'WebGL2 rasterizer'], BLENDER_WORKBENCH: ['out of scope', 'Workbench is a viewport engine'] };
  const lightMap = { POINT: ['done', 'pointLights (16)'], SUN: ['done', 'directional key light'], SPOT: ['done', 'spotLights (8)'], AREA: ['partial', 'areaLights (7), no shadow'] };
  const probeMap = { SPHERE: ['partial', 'bake.probes, specular only'], PLANE: ['missing', ''], VOLUME: ['missing', 'irradiance grid in progress, issue #543'] };
  const lookCounts = Object.fromEntries(Object.entries(colour.looks_by_view_transform).map(([name, looks]) => [name, looks.length]));
  return {
    engines: mapEnum(inventory.render.engines.map(engine => engine.identifier), engineMap),
    lights: mapEnum(inventory.lights_cameras_world.light_types.map(item => item.identifier), lightMap),
    probes: mapEnum(inventory.lights_cameras_world.light_probe_types.map(item => item.identifier), probeMap),
    viewTransforms: colour.view_transforms.map(name => ({ name, status: viewTransformMap[name]?.[0] ?? 'missing', note: viewTransformMap[name]?.[1] ?? 'Not offered; 67js has aces, agx, neutral' })),
    lookCounts,
    displayDevices: colour.display_devices,
    settingGroups: Object.entries(inventory.render.engine_settings).map(([name, properties]) => ({ name, count: properties.length })),
    renderSettingCount: inventory.render.scene_render.length,
  };
}

function compareFiles(inventory) {
  const supported = { 'export_scene.gltf': ['partial', 'scene_export_glb'], 'import_scene.gltf': ['partial', 'GLB and glTF import'] };
  return inventory.import_export_operators
    .filter(entry => /^(wm|export_scene|import_scene|export_anim|import_anim|import_curve|object|collection)\./.test(entry.operator))
    .filter(entry => !/keyconfig|keying_set|export_layout|subtitles|exporter_export|export_all|import_as_mesh_planes/.test(entry.operator))
    .map(entry => ({
      name: entry.operator,
      status: supported[entry.operator]?.[0] ?? 'out of scope',
      note: supported[entry.operator]?.[1] ?? 'GLB is the exchange format, docs/goal.md',
    }));
}

// ---------- layout taxonomy ----------

const PROPERTIES_TABS = [
  ['render', 'Render', ['renderPasses', 'bake', 'ambientOcclusion', 'shadowCascades', 'viewTransform', 'lineArt', 'depthBias'], ['scene_render_submit', 'scene_review', 'scene_look']],
  ['output', 'Output', ['filmTimeline', 'renderPasses'], ['scene_render_submit', 'scene_render_status', 'scene_render_result']],
  ['view_layer', 'View Layer', ['renderPasses'], ['scene_render_submit']],
  ['scene', 'Scene', ['operations', 'checkpoints', 'filmTimeline', 'relations'], ['scene_create', 'scene_apply', 'scene_checkpoint', 'scene_restore']],
  ['world', 'World', ['lightingSetups', 'ambientOcclusion', 'viewTransform', 'water'], ['scene_look']],
  ['object', 'Object', ['placedAssets', 'instancing', 'relations', 'depthBias'], ['scene_apply', 'scene_inspect', 'scene_asset_catalog']],
  ['modifier', 'Modifiers', ['meshStack', 'meshModifiers', 'meshEdits', 'meshSculpt', 'fieldExpressions'], ['mesh_stack', 'mesh_edit', 'mesh_inspect']],
  ['particle', 'Particles', ['particles'], ['scene_apply']],
  ['physics', 'Physics', ['physics', 'cloth', 'bake'], ['scene_apply']],
  ['constraint', 'Constraints', ['motionConstraints', 'motionDrivers', 'motionIk'], ['scene_apply']],
  ['data', 'Data (mesh, light, camera, armature)', ['geometryTypes', 'terrain', 'curveText', 'rigging', 'maxPointLights', 'maxSpotLights', 'maxAreaLights', 'lightLinking'], ['scene_create', 'scene_apply']],
  ['material', 'Material', ['materialTags', 'materialLayers', 'materialSubsurface', 'materialGraph', 'materialPatterns', 'materialMappings', 'alphaModes'], ['scene_apply']],
  ['texture', 'Texture', ['materialPatterns', 'materialGraph'], ['scene_apply']],
];

function layoutTaxonomy(inventory) {
  const panels = inventory.ui.panels;
  const spaceCounts = {};
  for (const panel of panels) spaceCounts[panel.space_type] = (spaceCounts[panel.space_type] ?? 0) + 1;
  const capabilityKeys = Object.keys(AGENT_SCENE_CAPABILITIES);
  const rows = PROPERTIES_TABS.map(([context, label, keys, tools]) => {
    const tabPanels = panels.filter(panel => panel.space_type === 'PROPERTIES' && panel.context === context);
    const topLevel = tabPanels.filter(panel => !panel.parent_id);
    const subpanels = tabPanels.length - topLevel.length;
    return { context, label, topLevel: topLevel.map(panel => panel.label), subpanels, keys: keys.filter(key => capabilityKeys.includes(key)), tools };
  });
  const mappedKeys = new Set(PROPERTIES_TABS.flatMap(([, , keys]) => keys));
  const unmappedKeys = capabilityKeys.filter(key => !mappedKeys.has(key));
  return { spaceCounts, rows, unmappedKeys, panelTotal: panels.length, menuTotal: inventory.ui.menus.length };
}

function nameSuggestions(inventory) {
  const modifierNames = new Map(inventory.modifiers_and_constraints.modifier_types.map(modifier => [normalizeName(modifier.name), modifier.name]));
  const constraintNames = new Map(inventory.modifiers_and_constraints.constraint_types.map(constraint => [normalizeName(constraint.name), constraint.name]));
  const differing = [];
  for (const operation of AGENT_SCENE_CAPABILITIES.meshStack.operations) {
    if (!modifierNames.has(normalizeName(operation))) differing.push(operation);
  }
  const constraintsDiffering = AGENT_SCENE_CAPABILITIES.motionConstraints.filter(name => !constraintNames.has(normalizeName(name)));
  return { stackOperationsWithoutBlenderName: differing, constraintsWithoutBlenderName: constraintsDiffering };
}

// ---------- ledger rows the inventory suggests ----------

const SUGGESTED_LEDGER_ROWS = [
  { key: 'Geometry node data types', status: 'missing', why: 'Blender 5.2 has Matrix (12 nodes), Rotation (11), List (6), Bundle and Closure nodes, and Repeat, Simulation and For Each zones. Fields have none of them, and the ledger names only "Geometry Nodes".' },
  { key: 'Rigid body shapes and joints', status: 'missing', why: 'Blender has cylinder, cone and compound shapes and piston, generic, generic spring and motor joints; physics has box, ball, capsule, convex and trimesh with fixed, revolute, prismatic and spherical joints.' },
  { key: 'Light probes', status: 'partial', why: 'Blender has sphere, plane and volume probes; `bake.probes` gives specular sphere probes only. The EEVEE row mentions probes but no row counts them.' },
  { key: 'Mesh interchange formats', status: 'out of scope', why: 'Blender 5.2 imports and exports OBJ, PLY, STL, USD, Alembic and FBX, plus SVG and BVH; GLB is the exchange format (docs/goal.md).' },
];

function ledgerHasRow(otherWork, key) {
  return otherWork.some(row => row.work.toLowerCase().includes(key.toLowerCase()));
}

// ---------- shortlist ----------

const SHORTLIST = [
  ['Constraint batch: Copy Transforms, Limit Distance, Limit Scale, Stretch To, Locked Track, Transformation, Action', 'Rigs, cameras and props follow other parts without hand-made keyframes; 14 of 29 constraints have no ledger coverage yet (issue #58).', 'S each, M together'],
  ['Mesh primitives: plane, cone, ico sphere, circle and line', 'Every agent asks for a plane or cone first; today it builds them from cylinder or lathe.', 'S'],
  ['Sampling in fields: nearest surface, raycast, proximity, plus Capture and Store Named Attribute', 'Scatter that avoids paths, grows on terrain and keeps density maps is how agents dress a world; fields cannot read other surfaces.', 'M'],
  ['Force fields: wind, turbulence, vortex, drag, magnet', 'Moves particles, hair and cloth in one call; the ledger row is missing (issue #63).', 'M'],
  ['Ocean modifier', 'Water scenes have a shader and no moving surface; a spectrum displacement is a bounded, deterministic pass.', 'M'],
  ['Object motion blur', 'Camera blur exists; fast props and characters in films still look frozen (ledger: Cameras).', 'M'],
  ['Lighting passes: diffuse, glossy, shadow, AO, mist', 'Agents and compositing steps need separable lighting to grade; only albedo, normal, emission, depth and object ID exist.', 'M'],
  ['Compositor subset: color balance, glare, lens distortion, vignette, defocus', 'Film grade without a graph; a short list of named post steps beats a node editor for agents.', 'M'],
  ['Shader mixing: Mix and Add Shader, Emission, Toon BSDF as a bounded graph', 'Surfaces that blend two materials (wet over dry, painted over rust) need mixing, not just layers.', 'L'],
  ['Curve operations: resample, fillet, fill, reverse, profile sweep with caps', 'Rails, pipes, cables and roads start as curves; only the sweep exists (issue #45).', 'M'],
  ['Rotation and Matrix math in fields: align to vector, rotate, transform point', 'Instances need orientation along a normal or path; fields hold position only.', 'S to M'],
  ['Soft body', 'Jelly, cushions and flags; cloth covers flags, so this ranks last (issue #62).', 'L'],
];

// ---------- report ----------

function table(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.map(cell => String(cell).replace(/\|/g, '/')).join(' | ')} |`);
  return lines.join('\n');
}

function coverageRow(area, blenderCount, items, extra = '') {
  const counts = summarizeItems(items);
  return [area, blenderCount, counts.done, counts.partial, counts.missing, counts['out of scope'], counts['not in ledger'], extra];
}

function listByStatus(items, status) {
  return items.filter(item => item.status === status).map(item => item.name).join(', ') || 'none';
}

async function main() {
  const inventory = JSON.parse(await readFile(inventoryUrl, 'utf8'));
  const ledgerText = await readFile(new URL('../docs/parity.md', import.meta.url), 'utf8');
  const { manualRows, otherWork } = parseLedger(ledgerText);
  const toolNames = await listMcpToolNames();

  const modifiers = compareModifiers(inventory, manualRows);
  const constraints = compareConstraints(inventory, manualRows);
  const geometry = compareNodeTree(inventory.geometry_nodes, GEOMETRY_NODE_CATEGORY_STATUS, NODE_LABEL_OVERRIDES.geometry);
  const shader = compareNodeTree(inventory.shader_nodes, SHADER_NODE_CATEGORY_STATUS, NODE_LABEL_OVERRIDES.shader);
  const compositor = compareNodeTree(inventory.compositor_nodes, COMPOSITOR_NODE_CATEGORY_STATUS, NODE_LABEL_OVERRIDES.compositor);
  const physics = comparePhysics(inventory);
  const render = compareRender(inventory);
  const files = compareFiles(inventory);
  const layout = layoutTaxonomy(inventory);
  const names = nameSuggestions(inventory);

  const physicsItems = Object.values(physics.groups).flat().filter(item => item.status !== 'out of scope' || item.note.startsWith('GLB'));
  const renderItems = [...render.engines, ...render.lights, ...render.probes, ...render.viewTransforms];
  const coverageRows = [
    coverageRow('Modifiers', modifiers.length, modifiers, 'per-item ledger rows'),
    coverageRow('Constraints (object and bone share one list)', constraints.length, constraints, 'per-item ledger rows'),
    coverageRow('Geometry nodes', inventory.geometry_nodes.count, geometry.items, 'status by category (inferred)'),
    coverageRow('Shader nodes', inventory.shader_nodes.count, shader.items, 'status by category (inferred)'),
    coverageRow('Compositor nodes', inventory.compositor_nodes.count, compositor.items, 'status by category (inferred)'),
    coverageRow('Physics types and shapes', physicsItems.length, physicsItems),
    coverageRow('Engines, lights, probes, view transforms', renderItems.length, renderItems),
    coverageRow('Import and export operators', files.length, files),
  ];

  const sections = [];
  sections.push(`# Blender ${inventory.blender_version} inventory against 67js

Generated by \`node scripts/blender-inventory-compare.mjs\` from \`bench/parity/blender-inventory.json\` (\`scripts/blender-inventory.py\`, factory settings). 67js side: \`docs/parity.md\`, \`scene_capabilities\` and ${toolNames.length} MCP tools.

Node-tree, physics and render statuses are read from the ledger notes and the capability lists by hand-kept tables in the compare script; they are inferred, not measured. Modifier and constraint statuses are the ledger's own rows.

Blender build: ${inventory.operator_totals.operators} operators in ${inventory.operator_totals.categories} categories, ${inventory.ui.panels.length} panels, ${inventory.ui.menus.length} menus, ${inventory.modifiers_and_constraints.modifier_types.length} modifier entries, ${inventory.modifiers_and_constraints.bone_constraint_types.length} constraints, ${inventory.geometry_nodes.count} geometry nodes, ${inventory.shader_nodes.count} shader nodes, ${inventory.compositor_nodes.count} compositor nodes.`);

  sections.push(`## Coverage by area\n\n${table(['Area', 'Blender items', 'done', 'partial', 'missing', 'out of scope', 'not in ledger', 'Basis'], coverageRows)}`);

  sections.push(`## Modifiers

Missing: ${listByStatus(modifiers, 'missing')}.

Partial: ${listByStatus(modifiers, 'partial')}.

Not in the ledger: ${listByStatus(modifiers, 'not in ledger')}.`);

  sections.push(`## Constraints

Missing: ${listByStatus(constraints, 'missing')}.

Partial: ${listByStatus(constraints, 'partial')}.

Out of scope: ${listByStatus(constraints, 'out of scope')}.`);

  for (const [title, result, tree] of [['Geometry nodes', geometry, inventory.geometry_nodes], ['Shader nodes', shader, inventory.shader_nodes], ['Compositor nodes', compositor, inventory.compositor_nodes]]) {
    const categories = Object.keys(tree.add_menu_categories).map(category => {
      const items = result.items.filter(item => item.category === category);
      const counts = summarizeItems(items);
      const sample = items.slice(0, 4).map(item => item.name).join(', ');
      return [category, items.length, counts.done, counts.partial, counts.missing, counts['out of scope'], sample];
    });
    sections.push(`## ${title} by Add menu category\n\n${table(['Add menu category', 'nodes', 'done', 'partial', 'missing', 'out of scope', 'examples'], categories)}\n\nNot in the Add menu: ${tree.not_in_add_menu.map(node => node.label).join(', ') || 'none'}.${result.unmapped.length ? `\n\nCategories with no status in the compare script: ${result.unmapped.join(', ')}.` : ''}`);
  }

  const physicsLines = Object.entries(physics.groups).map(([group, items]) => `- ${group}: ${items.map(item => `${item.name} (${item.status})`).join(', ')}`);
  sections.push(`## Physics\n\n${physicsLines.join('\n')}\n\nSettings groups in Blender (property counts): ${physics.settingGroups.map(group => `${group.name} ${group.count}`).join(', ')}.`);

  sections.push(`## Render, lights, camera, world and colour management

- Engines: ${render.engines.map(item => `${item.name} (${item.status}: ${item.note})`).join('; ')}.
- Engine settings groups (property counts): ${render.settingGroups.map(group => `${group.name} ${group.count}`).join(', ')}; scene.render ${render.renderSettingCount}; camera ${inventory.lights_cameras_world.camera_settings.length}; depth of field ${inventory.lights_cameras_world.camera_dof.length}; world ${inventory.lights_cameras_world.world_settings.length}; light ${inventory.lights_cameras_world.light_settings.Light.length}.
- Lights: ${render.lights.map(item => `${item.name} (${item.status})`).join(', ')}. Light probes: ${render.probes.map(item => `${item.name} (${item.status})`).join(', ')}.
- View transforms: ${render.viewTransforms.map(item => `${item.name} (${item.status})`).join(', ')}. Looks per transform: ${Object.entries(render.lookCounts).map(([name, count]) => `${name} ${count}`).join(', ')}. Display devices: ${render.displayDevices.join(', ')} (67js has no display device choice).
- Video: ${inventory.render.video_containers.length} containers and ${inventory.render.video_codecs.length} codecs in Blender; 67js writes PNG and MP4.`);

  sections.push(`## Import and export operators\n\n${table(['Operator', 'Status', 'Note'], files.map(item => [item.name, item.status, item.note]))}`);

  const tabRows = layout.rows.map(row => [row.label, row.topLevel.length, row.subpanels, row.topLevel.slice(0, 6).join(', '), row.keys.join(', '), row.tools.join(', ')]);
  sections.push(`## Layout taxonomy: editor, tab, panel, subpanel

Blender has ${layout.panelTotal} panels in ${Object.keys(layout.spaceCounts).length} editors: ${Object.entries(layout.spaceCounts).map(([space, count]) => `${space} ${count}`).join(', ')}. The Properties editor groups settings by tab (the context), then panel, then subpanel (\`bl_parent_id\`). The table pairs each Properties tab with the 67js capability keys and MCP tools that expose the same thing today.

${table(['Properties tab', 'panels', 'subpanels', 'first panels', '67js capability keys', 'MCP tools'], tabRows)}

Capability keys that fit no tab: ${layout.unmappedKeys.join(', ')}.`);

  sections.push(`## Suggestions

1. Add a \`tabs\` index to \`scene_capabilities\` that lists, in the Properties editor order (Render, Output, View Layer, Scene, World, Object, Modifiers, Particles, Physics, Constraints, Data, Material, Texture), the capability keys and the tool that edits each. \`scene_capabilities\` is a flat object of ${Object.keys(AGENT_SCENE_CAPABILITIES).length} keys; an agent that knows Blender looks for a tab, not a key name. The table above is a first draft of that index.
2. Offer Blender's terms as aliases in the index, without renaming keys: \`meshModifiers\` and \`meshStack\` under "Modifiers", \`motionConstraints\` under "Constraints", \`viewTransform\` under "Color Management", \`renderPasses\` under "View Layer". Stack operations without a Blender modifier name: ${names.stackOperationsWithoutBlenderName.join(', ') || 'none'} (\`subdivide\` is Blender's Subdivision Surface; accept \`subdivision_surface\` and \`subsurf\` as input aliases).
3. Order \`docs/guide.md\` and the tool descriptions by the same tab order, and give each tab one line that names the Blender tab, so a search for "Physics tab" or "Modifiers tab" lands on the right page.
4. Keep Blender's identifiers where 67js already matches them (weld, edge_split, simple_deform, smooth_by_angle, weighted_normal); constraints without a Blender name: ${names.constraintsWithoutBlenderName.join(', ') || 'none'}.`);

  const suggestedRows = SUGGESTED_LEDGER_ROWS.map(row => [row.key, row.status, ledgerHasRow(otherWork, row.key) ? 'in ledger' : 'to add', row.why]);
  sections.push(`## Items in Blender that the ledger does not list

${table(['Work', 'Status', 'Ledger', 'Why'], suggestedRows)}

Other gaps sit under one umbrella row: all ${inventory.geometry_nodes.count} geometry nodes under "Modeling > Geometry Nodes", all ${inventory.shader_nodes.count} shader nodes under seven category rows, and all ${inventory.compositor_nodes.count} compositor nodes under "Compositing".`);

  sections.push(`## Ranked shortlist of missing features\n\nRanked by value to agents that build scenes, films and renders in the browser; sizes are rough (S under a day, M a few days, L a week or more). Out of scope per docs/goal.md and left out: mouse editor, video sequencer, motion tracking, Grease Pencil, .blend files, Python API.\n\n${table(['#', 'Feature', 'Why', 'Size'], SHORTLIST.map((entry, index) => [index + 1, ...entry]))}`);

  await writeFile(reportUrl, `${sections.join('\n\n')}\n`, 'utf8');
  console.log(`wrote ${reportUrl.pathname.split('/').slice(-2).join('/')}`);
  console.log(table(['Area', 'Blender', 'done', 'partial', 'missing', 'out', 'unlisted'], coverageRows.map(row => row.slice(0, 7))));
}

await main();
