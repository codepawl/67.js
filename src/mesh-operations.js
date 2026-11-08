// The mesh edit vocabulary as plain data, with no geometry code, so capability listings and the MCP server can
// describe it without bundling the mesh engine.

export const MAX_MESH_EDITS = 64;

// Modifiers that work on the whole mesh and take no selection or name. Their fields are checked in mesh-modifiers.js and
// each one is described for agents by MESH_MODIFIER_NOTES in agent-scene-capabilities.js.
export const MODIFIER_OPERATIONS = Object.freeze({
  weld: { fields: ['distance'], tags: [] },
  triangulate: { fields: ['minVertices'], tags: [] },
  edge_split: { fields: ['angle'], tags: [] },
  smooth: { fields: ['factor', 'iterations'], tags: [] },
  simple_deform: { fields: ['mode', 'axis', 'angle', 'factor'], tags: [] },
  cast: { fields: ['factor', 'size'], tags: [] },
  screw: { fields: ['axis', 'angle', 'steps', 'iterations', 'lift'], tags: [] },
  wireframe: { fields: ['thickness', 'offset', 'evenOffset', 'replace'], tags: [] },
  skin: { fields: ['radius'], tags: [] },
  lattice: { fields: ['divisions', 'moves'], tags: [] },
  curve: { fields: ['path', 'axis'], tags: [] },
  hook: { fields: ['center', 'radius', 'translation', 'strength', 'falloff'], tags: [] },
  wave: { fields: ['height', 'width', 'narrowness', 'speed', 'time', 'timeOffset', 'start', 'cyclic', 'axes', 'normal'], tags: [] },
  weighted_normal: { fields: ['angle', 'weight'], tags: [] },
  smooth_by_angle: { fields: ['angle', 'ignoreSharp'], tags: [] },
  bounding_box: { fields: [], tags: [] },
  convex_hull: { fields: [], tags: [] },
});

export const MESH_EDIT_OPERATIONS = Object.freeze({
  extrude_face_region: { fields: ['select', 'name', 'offset', 'direction', 'alongNormals'], tags: ['cap', 'side'] },
  extrude_individual: { fields: ['select', 'name', 'offset', 'direction'], tags: ['cap', 'side'] },
  inset_region: { fields: ['select', 'name', 'thickness', 'depth'], tags: ['cap', 'rim'] },
  inset_individual: { fields: ['select', 'name', 'thickness', 'depth'], tags: ['cap', 'rim'] },
  delete: { fields: ['select'], tags: [] },
  flip_normals: { fields: ['select'], tags: [] },
  translate: { fields: ['select', 'offset', 'falloff'], tags: [] },
  merge_by_distance: { fields: ['distance'], tags: [] },
  tag: { fields: ['select', 'name'], tags: [] },
  boolean: { fields: ['name', 'operation', 'cutter', 'translation', 'rotation', 'scale'], tags: ['cut'] },
  mirror: { fields: ['name', 'axis', 'merge'], tags: ['mirrored'] },
  array: { fields: ['name', 'count', 'offset', 'relativeOffset', 'merge'], tags: ['last'] },
  solidify: { fields: ['name', 'thickness', 'offset', 'evenThickness'], tags: ['inner', 'rim'] },
  bevel: { fields: ['name', 'edges', 'width', 'segments', 'profile', 'clampOverlap'], tags: ['strip', 'corner'] },
  loop_cut: { fields: ['name', 'edges', 'cuts', 'factor'], tags: ['band-<k>'] },
  uv_unwrap: { fields: ['seams', 'margin', 'maxDistortion'], tags: [] },
  subdivide: { fields: ['levels', 'crease', 'sharpness'], tags: [] },
  fill_holes: { fields: ['name', 'sides'], tags: ['fill'] },
  dissolve_faces: { fields: ['select', 'name'], tags: ['merged'] },
  dissolve_edges: { fields: ['edges', 'name'], tags: ['merged'] },
  dissolve_verts: { fields: ['verts', 'name'], tags: ['merged'] },
  dissolve_limited: { fields: ['edges', 'angle', 'name'], tags: ['merged'] },
  bisect_plane: { fields: ['name', 'point', 'normal', 'distance', 'clearInner', 'clearOuter', 'fill'], tags: ['inner', 'outer', 'cap'] },
  bridge_edge_loops: { fields: ['edges', 'name', 'segments', 'twistOffset'], tags: ['bridge'] },
  subdivide_edges: { fields: ['edges', 'name', 'cuts'], tags: ['split'] },
  grid_fill: { fields: ['edges', 'name'], tags: ['fill'] },
  knife_project: { fields: ['name', 'path', 'direction'], tags: ['cut'] },
  set_position: { fields: ['select', 'position', 'offset'], tags: [] },
  displace: { fields: ['select', 'field', 'strength', 'midlevel', 'direction', 'group'], tags: [] },
  vertex_group: { fields: ['select', 'name', 'weight', 'field', 'gradient'], tags: [] },
  vertex_color: { fields: ['select', 'color', 'field', 'gradient'], tags: [] },
  decimate: { fields: ['ratio'], tags: [] },
  remesh: { fields: ['voxelSize', 'resolution'], tags: [] },
  sculpt: { fields: ['select', 'strokes'], tags: [] },
  shrinkwrap: { fields: ['select', 'target', 'translation', 'rotation', 'scale', 'mode', 'direction', 'offset', 'maxDistance', 'onMiss'], tags: [] },
  ...MODIFIER_OPERATIONS,
});

// Limits of the sculpt and shrinkwrap edits, and their vocabulary, as plain data.
export const SCULPT_STROKE_TYPES = Object.freeze(['inflate', 'displace', 'smooth']);
export const MAX_SCULPT_STROKES = 32;
export const MAX_SCULPT_VISITS = 5_000_000;
export const SHRINKWRAP_MODES = Object.freeze(['nearest', 'project']);
export const MAX_SHRINKWRAP_TRIANGLE_TESTS = 20_000_000;

export const STACK_OPERATIONS = Object.freeze(['mirror', 'array', 'solidify', 'bevel', 'uv_unwrap', 'subdivide', 'set_position', 'displace', 'decimate', 'remesh', ...Object.keys(MODIFIER_OPERATIONS)]);
export const MAX_STACK_NODES = 16;

// Field expressions (mesh-fields.js) and instancing (mesh-instances.js): limits and names as plain data. A test
// keeps FIELD_OPERATOR_NAMES equal to the operators the language really has.
export const MAX_FIELD_NODES = 64;
export const MAX_FIELD_DEPTH = 12;
export const MAX_FIELD_ELEMENTS = 250_000;
export const MAX_FIELD_WORK = 8_000_000;
export const FIELD_ATTRIBUTES = Object.freeze(['position', 'normal', 'index', 'tag']);
export const FIELD_OPERATOR_NAMES = Object.freeze([
  'add', 'mul', 'min', 'max', 'sub', 'div', 'mod', 'pow', 'atan2', 'clamp', 'mix', 'smoothstep',
  'neg', 'abs', 'sqrt', 'sin', 'cos', 'floor', 'ceil', 'round', 'fract', 'sign', 'saturate',
  'lt', 'lte', 'gt', 'gte', 'eq', 'and', 'or', 'not', 'if',
  'vec', 'dot', 'cross', 'distance', 'length', 'normalize', 'x', 'y', 'z',
  'rotate', 'align', 'transform',
  'attr', 'noise', 'random',
]);
export const INSTANCE_SOURCES = Object.freeze(['grid', 'scatter', 'surface', 'curve']);
export const MAX_INSTANCE_CANDIDATES = 2048;

// Imported GLB parts take the same edits. Skin weights, morph deltas and vertex colours of new geometry come from the
// nearest point of the original surface; an edit that reaches farther than this fraction of the part's bounds
// diagonal from that surface is rejected on a skinned or morphed part, because the transfer would be a guess.
export const IMPORTED_MESH_EDIT_LIMITS = Object.freeze({ maxTransferFraction: 0.25, maxEditedParts: 64 });
