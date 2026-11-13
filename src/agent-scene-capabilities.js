import { VIEW_TRANSFORM_NAMES, LOOK_NAMES } from './view-transform-names.js';
import { BUNDLED_ENVIRONMENT_NAMES, BUNDLED_CUBE_LOOK_NAMES } from './look-catalog.js';
import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS } from './light-limits.js';
import {
  MESH_EDIT_OPERATIONS, MAX_MESH_EDITS, STACK_OPERATIONS, MAX_STACK_NODES,
  FIELD_OPERATOR_NAMES, FIELD_ATTRIBUTES, MAX_FIELD_NODES, MAX_FIELD_DEPTH, MAX_FIELD_ELEMENTS, INSTANCE_SOURCES, MAX_INSTANCE_CANDIDATES,
  IMPORTED_MESH_EDIT_LIMITS,
} from './mesh-operations.js';
import { MATERIAL_LAYER_FIELDS, MATERIAL_LAYER_SCALAR_RANGES, MATERIAL_LAYER_COLOR_RANGES } from './material-layers.js';

// What agent scenes support and their default limits, as plain data. The MCP server reads these without bundling
// the scene engine (geometry, three.js decoders, the mesh core), which runs in the preview page instead.

export const AGENT_SCENE_DEFAULT_LIMITS = Object.freeze({
  maxNodes: 4096, maxDepth: 256, maxGeometries: 256, maxMaterials: 256,
  maxVertices: 250_000, maxGeometryBytes: 32 * 1024 * 1024,
  maxOperations: 256, maxCheckpoints: 16, maxRecipeBytes: 1024 * 1024,
});

// The values of the water presets (src/world-material-shader.js holds the same numbers; a test keeps them in step), written out
// here so the capabilities do not pull the shader addon into every agent scene.
const WATER_PRESETS_SUMMARY = Object.freeze({
  lake: Object.freeze({ absorption: Object.freeze([0.35, 0.07, 0.04]), turbidity: 0.02 }),
  sea: Object.freeze({ absorption: Object.freeze([0.4, 0.06, 0.02]), turbidity: 0.1 }),
  river: Object.freeze({ absorption: Object.freeze([0.8, 0.9, 1.6]), turbidity: 0.75 }),
});

// What each recipe material layer does, beside its range; the MCP schema keeps one short line per field.
const MATERIAL_LAYER_NOTES = Object.freeze({
  clearcoat: 'Lacquer lobe over the base, surface tag.',
  clearcoatRoughness: 'Coat roughness.',
  transmission: 'Refracts the opaque scene behind it, surface or liquid tag; blended parts do not show through; no anisotropy, iridescence, sheen or coat.',
  thickness: 'Metres crossed; 0 does not bend the view.',
  ior: 'Glass 1.5, water 1.33, diamond 2.42; sets the base reflectance.',
  attenuationColor: 'Linear RGB kept after attenuationDistance.',
  attenuationDistance: 'Metres to reach attenuationColor; omit for none.',
  sheenColor: 'Linear RGB glow at grazing angles; black is off.',
  sheenRoughness: 'Glow width.',
  specular: 'Non-metal reflection, 1 is normal.',
  specularColor: 'Linear RGB tint.',
  anisotropy: 'Stretches highlights along the grain; the grain follows the UV direction, or rings the up axis without UVs.',
  anisotropyRotation: 'Turns the grain around the normal, radians.',
  iridescence: 'Thin-film colour shift on reflections.',
  iridescenceIor: 'Film index of refraction.',
  iridescenceThickness: 'Film nanometres; colours cycle as it grows.',
  toon: 'Light steps (toon); 0 off.',
});

export const MATERIAL_PATTERN_TYPES =Object.freeze(['noise', 'wood', 'planks', 'bricks', 'tiles', 'marble', 'stone', 'concrete', 'metal', 'rust', 'fabric']);
export const MAX_MATERIAL_PATTERNS = 16;
// A material graph bakes to textures on the CPU and never becomes shader text. Its node and depth limits are the field
// expression limits; maxWork is work units per pixel times pixels, so a costly graph needs a smaller texture.
export const MATERIAL_GRAPH_OUTPUTS = Object.freeze(['color', 'roughness', 'metallic', 'emission', 'height', 'opacity', 'clearcoat', 'transmission', 'aov']);
export const MATERIAL_GRAPH_OPERATORS = Object.freeze([
  'uv', 'coord', 'mapping', 'vec', 'ramp', 'image', 'noise', 'whiteNoise', 'brick', 'voronoi', 'wave', 'checker', 'gradient',
  'add', 'sub', 'mul', 'div', 'min', 'max', 'pow', 'abs', 'floor', 'fract', 'sqrt', 'invert', 'clamp', 'smoothstep', 'mix',
  'layer', 'hue', 'curve', 'fresnel',
]);
export const MATERIAL_GRAPH_LIMITS = Object.freeze({ maxNodes: MAX_FIELD_NODES, maxDepth: MAX_FIELD_DEPTH, maxStops: 8, maxWork: 30_000_000 });
// Curve and text geometry. A text geometry is bounded by vertices per curve segment: the bundled font stays under
// 640 per character and a registered font is held to 128 outline points per glyph (2400).
export const CURVE_TEXT_LIMITS = Object.freeze({
  maxCurvePoints: 1024, maxProfilePoints: 256, maxTextCharacters: 256, maxTextLines: 16,
  verticesPerCharacterSegment: 640, verticesPerCustomCharacterSegment: 2400, maxPointsPerGlyph: 128,
});
export const CURVE_TEXT_DETAILS = Object.freeze({
  curve: 'bends along path, 2-64 points [x,y,z] (Catmull-Rom); the coordinate along axis (x) is the distance from the path start, so model from 0.',
  splines: 'Geometry curve takes points (kind bezier|poly|nurbs, closed; nurbs also weights, order 2-8 default 4, and for open splines knotMode clamped|uniform or knots: point count plus order values that never decrease), or shape {type arc|spiral|star} (arc: radius, startAngle, sweep radians, segments; spiral: rotations, startRadius, endRadius, height, pointsPerRotation, reverse; star: points, innerRadius, outerRadius, innerTwist), or splines: up to 64 of those in one mesh. trim {start, end, length}: factors 0-1 of the arc length, or lengths when length is true; a trimmed curve is open. grow {name, steps 2-16, value}: morph targets of the curve grown step by step; animate with a motion track { kind: "morph", id: <name>, property: "weight", keyframes 0-1 } so a vine grows. See docs/modeling.md.',
  sdf: 'Geometry sdf: root is a tree meshed by surface nets, resolution 4-128 cells along the longest side (default 32). Primitive {shape sphere|box|roundBox|capsule|cylinder|torus, radius, size, height, tubeRadius, position, rotation (Euler radians), scale (uniform)}. Operation {op union|subtract|intersect, smooth (blend radius), children: 2-16} (subtract removes the rest from the first) or {op offset, distance, child}. At most 64 nodes, 8 levels. See docs/modeling.md.',
  text: 'Extruded text, baseline y=0 along +X, facing +Z. text (\n for lines), size (1), depth (0.2), align left|center|right, curveSegments, font. See docs/modeling.md.',
});
export const MATERIAL_MAPPINGS = Object.freeze(['box', 'uv']);
export const MATERIAL_GRAPH_NODES = Object.freeze({
  outputs: 'color (linear RGB; a number is grey), roughness, metallic, emission (defaults to 1), height (normal map), opacity (alpha), clearcoat, transmission (masks), aov (linear RGB or scalar).',
  textures: Object.freeze({
    noise: '{"noise":{"scale":8,"seed":1,"octaves":4}}',
    voronoi: '{"voronoi":{"scale":6,"output":"distance"|"edge"|"cell"}}',
    wave: '{"wave":{"frequency":4,"direction":"u"|"v"|"diagonal","shape":"sine"|"saw"|"triangle"}}',
    checker: '{"checker":{"count":8}} (even)',
    gradient: '{"gradient":{"type":"u"|"v"|"radial"}}',
    whiteNoise: '{"whiteNoise":{"scale":16,"seed":1,"output":"value"|"color"}} one random value per cell, tiles.',
    image: '{"image":{"asset":"<64 hex catalog image asset ID>","output":"color"|"alpha"}} bilinear, repeats; color is linear RGB, decoded from sRGB. The host decodes catalog images (scene_asset_catalog); no URLs.',
    brick: '{"brick":{"columns":8,"rows":4,"mortar":0.05,"offset":0.5,"seed":1,"output":"mortar"|"edge"|"cell"}} running bond; rows even.',
    note: 'Each takes "at", a vector such as {"uv":"both"}. Scales are whole numbers 1-64.',
  }),
  uv: '{"uv":"u"|"v"|"both"} coordinates.',
  coordinates: '{"coord":"generated"|"object"|"world"} vector of where the texel sits: generated is the unit tile, object and world are metres across the tile (u * size); the third axis is 0 because a baked texture is projected. {"mapping":{"vector":node,"scale":n|[x,y,z],"offset":[x,y,z],"rotate":radians}} scales, turns around Z and moves a vector (default: generated). Feed either to "at". Meshes without UVs use box mapping; vertex_color already multiplies the baked colour. In graphs: fresnel, only as an emission factor. Not in graphs: vertexGroup, AO, bevel, curvature (per-pixel data a bake lacks).',
  ramp: '{"ramp":{"value":node,"stops":[[0,[r,g,b]],[1,[r,g,b]]]}} 2-8 stops rising from 0 to 1.',
  fresnel: '{"fresnel":{"ior":1.5}} ior 1.01-3. View dependent, so only as a factor of emission, alone or {"mul":[node,{"fresnel":{...}}]}: emission rises toward grazing angles, rendered per pixel by the rasterizer and the CPU path tracer.',
  mixing: '{"layer":{"base","top","mask","edge","softness"}}; {"hue":{"color","shift","saturation","value"}}; {"curve":{"value","points":[[x,y]]}}.',
  maths: 'add sub mul div min max pow take [a,b]; abs floor fract sqrt invert take one node; clamp smoothstep mix take [a,b,c]; {"vec":[r,g,b]}.',
  mapping: 'box (default) projects along object axes, no UVs; uv follows geometry UVs. size and axis only apply to box.',
});

// Recipe textures are opaque patterns, so cutout masking has nothing to cut.
export const RECIPE_ALPHA_MODES = Object.freeze(['opaque', 'blend', 'add']);

// Named lighting setups (see lighting-setups.js) and the occlusion strength that recipes get when they set none.
export const LIGHTING_SETUP_NAMES = Object.freeze(['daylight', 'overcast', 'sunset', 'studio']);
export const DEFAULT_LIGHTING_SETUP = 'daylight';
export const DEFAULT_AMBIENT_OCCLUSION = 0;

// Render passes a render job can write next to the lit image (see RENDER_PASS_MODES in render-passes.js, which lists the same names, wireframe being drawn as its diffuse mode).
export const RENDER_PASS_NAMES = Object.freeze(['albedo', 'normal', 'emission', 'depth', 'objectId', 'diffuse', 'glossy', 'shadow', 'ao', 'mist', 'position', 'velocity', 'uv', 'transmission', 'volume', 'environment', 'cryptomatte', 'aov', 'wireframe']);
// Video encoders a render job can choose (nvenc is h264_nvenc and fails the job when the GPU or ffmpeg lacks it), the
// longest video, and the audio file names a job may mix in from the --audio folder: one path segment with a known
// extension, no drive or protocol syntax.
export const VIDEO_ENCODERS = Object.freeze(['cpu', 'nvenc']);
export const MAXIMUM_VIDEO_SECONDS = 60;
// File formats of an image or stills job (8-bit PNG by default, 16-bit PNG, OpenEXR) and the highest video frame rate.
export const RENDER_OUTPUT_FORMATS = Object.freeze(['png', 'png16', 'exr']);
export const MAXIMUM_JOB_FPS = 60;
/** Recipe bake presets and ranges. A bake inline on the page fails the edit after 20 s, before the 30 s page deadline; on a worker it has 90 s. */
export const BAKE_PRESETS = Object.freeze({
  draft: Object.freeze({ samples: 32, bounces: 1, texelsPerUnit: 3 }),
  standard: Object.freeze({ samples: 128, bounces: 3, texelsPerUnit: 6 }),
  // An alias of standard: measured on the five reference rooms, no samples and density mix within the 20 s limit scored better (bench/reference/README.md).
  fine: Object.freeze({ samples: 128, bounces: 3, texelsPerUnit: 6 }),
});
export const BAKE_RANGES = Object.freeze({ samples: [1, 256], bounces: [1, 8], texelsPerUnit: [1, 12] });
export const BAKE_MAXIMUM_SECONDS = 20;
/** The limit when the bake runs on a worker, which does not block the page: a busy machine still finishes a preset. */
export const BAKE_WORKER_MAXIMUM_SECONDS = 90;
/**
 * Path steps (texels x samples x bounces) a preset is scaled down to. Measured at 1.8 to 3.1
 * microseconds per path step on a closed 56 part room and the 57 node demo room, so this is 9 to 16 s, under the 20 s limit. The two rooms cost
 * the same per path step, so the budget does not depend on the number of lights.
 */
export const BAKE_PRESET_PATH_WORK = 5_000_000;
/**
 * The hard upper bound on path steps for explicit samples, bounces and texelsPerUnit: about 5 times the demo room at 96
 * samples, 2 bounces, texelsPerUnit 3. Below it the bake runs until BAKE_MAXIMUM_SECONDS, which fails cleanly and leaves
 * the scene unchanged.
 */
export const BAKE_EXPLICIT_PATH_WORK_LIMIT = 24_000_000;
/** Render job output: each side up to 1920 and never more pixels than 1920x1080 (portrait 1080x1920 fits). */
export const MAXIMUM_JOB_SIDE = 1920;
export const MAXIMUM_JOB_PIXELS = 1920 * 1080;
/**
 * Largest --memory value in MiB the MCP server accepts. Measured: a 1920x1080 frame needs about 175 MiB of targets
 * (planRenderSize estimate, 4 samples), Node RSS peaks under 180 MiB, so 384 leaves about 200 MiB for scene textures and geometry.
 */
export const MAXIMUM_MEMORY_MIB = 384;
export const AUDIO_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(wav|mp3|ogg|flac)$/;
// Metres that depth pass values 0 to 65535 span, measured from the camera.
export const RENDER_PASS_DEPTH_RANGE = 100;

// Fields and defaults of the whole-mesh modifiers, which the tool schemas leave out to stay small.
export const MESH_MODIFIER_NOTES = Object.freeze({
  weld: 'distance 0.001: merge closer vertices.',
  triangulate: 'minVertices 4: split faces with that many corners or more.',
  edge_split: 'angle 30: split edges bending more than this many degrees.',
  smooth: 'factor 0.5 (-2 to 2) steps toward the neighbour mean; iterations 1 to 64.',
  simple_deform: 'mode twist or bend use angle (45 degrees), taper or stretch use factor (0.5); axis x, y or z (z).',
  cast: 'sphere about the origin: factor 0 to 1 (0.5), size radius (0 = mean vertex distance).',
  screw: 'revolves every edge about axis x, y or z (z) through the origin, dropping faces: angle 360, steps 16 (1-256) and iterations 1-64, lift 0 per iteration. A whole number of turns with no lift closes the ring.',
  wireframe: 'rim of thickness 0.02 on each face: offset -1..1 (0) moves the strut inside..outside, evenOffset true, replace true drops the faces.',
  skin: 'closed square tube per edge: radius 0.1 or a scalar field per vertex (above 0). Simple: tubes overlap, no branch solver.',
  lattice: 'divisions [2,2,2] (2-8) control points over the mesh bounds; moves up to 64 of {point:[i,j,k], offset:[x,y,z]}; trilinear blend.',
  curve: 'bends the mesh along path, 2 to 64 points [x,y,z] through a Catmull-Rom spline. The coordinate along axis (x) is the distance from the path start, the other two become offsets in a twist-free frame; past the ends the mesh continues straight. Model the mesh along the axis starting at 0.',
  hook: 'vertices within radius 1 of center [0,0,0] move by translation [0,0,0] times strength 0-1 (1); falloff smooth, linear or constant.',
  wave: 'a gaussian ripple of height 0.5 along z (normal true: along the vertex normal) travelling from start [0,0] over axes xy (default), x or y; width 1.5, narrowness 0-50 (1.5), speed 0.25 per frame, time 0 (a frame), timeOffset 0, cyclic true repeats it. Matches Blender Wave.',
  weighted_normal: 'corner normals weighted by face area ^ (weight/50), weight 1-100 (50), smoothed across edges under angle 30 that are not sharp. Put it last in the stack.',
  smooth_by_angle: 'edges bending over angle 30 (0-180) become sharp, others smooth, over smoothAngle; ignoreSharp true also clears hand-made sharp edges.',
  bounding_box: 'becomes its axis-aligned box.',
  convex_hull: 'becomes its convex hull, up to 8192 vertices.',
  build: 'shows faces one by one as frame runs from start 0 over length 60 frames (frame 0; give the current frame, e.g. from your film clock): order index (default), random (seed 0) or axis (axis y, lowest centroid first); reverse true unbuilds. Unused vertices drop; while none shows, one zero-area triangle stays.',
  ocean: 'seeded sea: lifts axis (y) by waves of windSpeed 10 m/s (0-60) toward direction 0 deg, size 100 m (repeats), seed 0, time 0 s, resolution 8 (1-16); choppiness 1 (0-4) pulls points to crests. Writes group foam. wake {points up to 64 [x, z, strength, width], height 0.06} adds white foam and a small choppy displacement along a boat trail (physics float.boat.wake fills it).',
});

// Vertex colors and groups. Details stay here so the tool schemas stay small.
export const MESH_ATTRIBUTE_NOTES = Object.freeze({
  vertex_group: 'name (required) sets the weights 0-1 of the vertices of the selected faces; the rest keep theirs. One of weight (1), field, gradient { axis x|y|z, range [low, high], weights [atLow, atHigh] } or measure curvature (gain 0.1-16, 2; 0.5 flat, up convex), edge (angle 1-179 deg, 30; convex folds) or occlusion (rays 1-128, 32; distance m; seed). Max 32 groups. displace takes group: name and scales each move by the weight; cloth takes pinGroup. A stack node that rebuilds the mesh drops groups.',
  vertex_color: 'sets the corner colors (0-1, linear, white until set) of the selected faces. One of color [r, g, b], field (vector expression of the vertex) or gradient { axis, range [low, high], colors [[r,g,b] atLow, [r,g,b] atHigh] } or { group, colors } of 2 or 3 stops along the weights of a vertex group (edge wear: curvature group, colors [dirt, paint, metal]). Drawn, written as COLOR_0 in a GLB, and multiplies the material color.',
});

// UV projection and packing edits. Details stay here so the tool schemas stay small.
export const MESH_UV_NOTES = Object.freeze({
  uv_project: 'mode cube (each face by its dominant axis), cylinder (sides wrap around axis, caps flat) or sphere (longitude and latitude); axis x|y|z (y) for the last two, measured from the bounds centre; wrapped faces cut opposite the first radial axis. pack true (default) packs into 0..1 with one scale for every island so texel density is even; false leaves uv in mesh units for a later uv_pack. margin 0-0.2 (0.01); rotate true lays tall islands on their side. Reports islands. Texel density: cube exact, cylinder within about 15 percent, sphere stretches toward the poles.',
  uv_pack: 'repacks the islands already in uv (faces joined across edges whose two ends share uv) into 0..1 with one scale. margin 0-0.2 (0.01), rotate true. Needs uv from uv_unwrap or uv_project. Reports islands.',
});

// Shape keys on a recipe mesh. Details stay here so the tool schemas stay small.
export const MESH_SHAPE_KEY_NOTES = Object.freeze({
  shapeKeys: 'On a mesh geometry, at most 16: { name, offsets, value } or { name, edits, value }. offsets is a list of { select, offset: [x,y,z], falloff } moves like the translate edit; edits are vertex-moving mesh edits run after the stack. value (0, 0 to 1) is the weight without motion. Each key becomes a glTF morph target. Animate it with a motion track { kind: "morph", id: <key name>, property: "weight", keyframes }.',
});

// Organic shaping edits. Details stay here so the tool schemas stay small.
export const MESH_SCULPT_NOTES = Object.freeze({
  sculpt: 'strokes run in order on the vertices of the selected faces; a tag confines them. A stroke has type inflate (along the vertex normal), displace (along direction, needed) or smooth (strength 0-1), center and radius, strength in mesh units. Falloff is smooth to zero at the radius.',
  shrinkwrap: 'target is a primitive record placed by translation, rotation and scale. mode nearest (default) moves each selected vertex to the closest point; project moves it along direction (needed) to the first hit. offset (0) stands it off along the normal. maxDistance limits the search; onMiss error (default) or keep. For a decal, use enough grid cells, then solidify.',
});

// Boolean cutters on a recipe mesh. Details stay here so the tool schemas stay small.
export const MESH_BOOLEAN_NOTES = Object.freeze({
  cutter: 'A primitive or profile record such as { type: "cylinder" }, or { geometry: "<id>" } naming another recipe geometry (a mesh with its own edits and stack, or a primitive). Put translation, rotation and scale on the edit. References form a DAG: a cycle or an unknown ID fails with the chain; at most 4 cutter geometries deep and 250000 estimated cutter vertices per mesh. Editing the cutter geometry rebuilds only the meshes that name it. Imported-part edits take inline records only.',
});

export const AGENT_SCENE_CAPABILITIES = Object.freeze({
  format: '67js.scene', schemaVersion: 1,
  geometryTypes: Object.freeze(['box', 'cylinder', 'sphere', 'cone', 'icoSphere', 'torus', 'lathe', 'extrude', 'tube', 'curve', 'sdf', 'text', 'grid', 'plane', 'circle', 'line', 'terrain', 'mesh', 'fragment']),
  camera: 'eye, target, up, near, far, then fov (vertical degrees) or focalLength (mm, with sensorWidth mm, 36; not both). projection orthographic with orthoScale (view height in m, default 4). shift [x, y] moves the frame by a fraction of its size. fStop (0.7-64) turns on depth of field focused on target; 1.4 or lower is full blur; effects.depthOfField.blur must stay 0. Orthographic/shifted cameras use the rasterizer.',
  terrain: 'One mesh, x and z from -size/2 to size/2, hills about y = 0. size 40 m (1-2000), resolution 64 cells (2-256), seed 1, amplitude 1 m (0-200), holes up to 16 of {center:[x,z],radius}, no surface inside; radius a few cells or more.',
  placedAssets: 'Node field asset:{id,materials?,clip?,drive?} turns a group node into a catalog GLB (id from asset_catalog). Its transform places it. scene_apply add-node with an asset field places the first or any later instance, so a scene need not start with its assets. materials:[{name,color,metallic,roughness,opacity,emission,emissiveColor}] override source materials by name. clip:{index,start=0,speed=1,loop=true} plays that clip from scene time start; set-motion tracks move the node and scene time seeks the clip. drive:{path | legs, cruiseSpeed | speed, wheels, lights} drives a car along a path in the placement frame (docs/vehicle.md). Max 512 placements, 16 assets, 16 animated.',
  askUser: 'scene_ask_user opens the current view in their browser; they pin up to maxMarks (16) points, each with a note, and press Send. Ask when a change is hard to say in words ("warmer here", "this bit"), not for facts you can inspect. Each mark returns partId, point, normal, note, distance and material (null on sky), plus view.camera and a PNG with numbered pins. Apply the change the note names to that partId, then to similar parts (same material or name prefix) when the note says so. outcome cancelled or timeout returns no marks: ask in text. Edits made while they mark change revision; the result warns.',
  navigation: 'scene_inspect path:{ground,from:[x,z],to:[x,z]} returns a route over the ground node around its holes, steep slopes and the nodes in avoid:[ids] (box footprints), as keyframes [{time,value:[x,y,z]}] for a translation track with interpolation LINEAR. radius 0.3 m; maxSlope 40 degrees; cellSize defaults to radius; seconds or speed (1.4 m/s); lift adds y.',
  meshEdits: Object.freeze({ operations: Object.freeze(Object.keys(MESH_EDIT_OPERATIONS)), maxEdits: MAX_MESH_EDITS }),
  meshStack: Object.freeze({ operations: STACK_OPERATIONS, maxNodes: MAX_STACK_NODES }),
  meshModifiers: MESH_MODIFIER_NOTES,
  meshSculpt: MESH_SCULPT_NOTES,
  meshAttributes: MESH_ATTRIBUTE_NOTES,
  meshUv: MESH_UV_NOTES,
  meshBoolean: MESH_BOOLEAN_NOTES,
  meshShapeKeys: MESH_SHAPE_KEY_NOTES,
  fieldExpressions: Object.freeze({
    operators: FIELD_OPERATOR_NAMES, attributes: FIELD_ATTRIBUTES,
    maxNodes: MAX_FIELD_NODES, maxDepth: MAX_FIELD_DEPTH, maxElements: MAX_FIELD_ELEMENTS,
    rotation: 'rotate [v, axis, rad]; align [dir]: Euler of +Y to dir; transform [p, move, euler, size].',
    meshShape: 'faceArea {}; edgeAngle {} (radians, 0 on a border); island {}; neighbors {read edges|faces}. Over points faceArea is the mean of the faces around. A point set has no mesh and rejects them.',
    wholeDomain: 'accumulate {value, group}; statistic {value, mode min|max|mean|sum|range, group}; blur {value, iterations 1-32, weight 0-1}; sampleIndex {value, index} (clamped); rank {value, descending} (Sort Elements index). value and group are number expressions.',
    surfaces: 'nearest {surface, at, read distance|point|normal}; raycast {surface, at, direction, read hit|distance|point|normal, miss}. at defaults to position; rays go forward. surface: geometry id (instances where) or record (mesh edits). attr group + name reads a vertex group.',
  }),
  instancing: Object.freeze({
    sources: INSTANCE_SOURCES, maxCandidatePoints: MAX_INSTANCE_CANDIDATES,
    place: 'place {at vertices|faces, spacing, density 0-1, variants [id|{geometry, material}], variant, rotation Euler, size}; the last are fields.',
  }),
  operations: Object.freeze([
    'set-node', 'set-material', 'set-camera', 'add-node', 'remove-node',
    'add-geometry', 'remove-geometry', 'add-material', 'remove-material',
    'set-environment', 'set-effects', 'set-shadow', 'set-motion', 'set-armatures', 'set-physics', 'set-cloth', 'set-timeline', 'set-particles', 'set-bake', 'set-post-passes', 'set-game', 'edit-mesh', 'set-mesh-stack', 'bake-motion', 'fracture-node', 'settle',
  ]),
  materialTags: Object.freeze(['surface', 'unlit', 'liquid', 'foam', 'foliage', 'grass', 'water']),
  // A flat water sheet; the largest sets the level. A bed d metres down keeps exp(-absorption * d) per channel (RGB per metre).
  water: Object.freeze({ presets: WATER_PRESETS_SUMMARY, default: 'lake', note: 'absorption 0..20, turbidity 0..1 softens shadows below; opacity under 1 shows the bed.' }),
  materialLayers: Object.freeze(Object.fromEntries(MATERIAL_LAYER_FIELDS.map(field => [field, Object.freeze({
    range: MATERIAL_LAYER_SCALAR_RANGES[field] ?? MATERIAL_LAYER_COLOR_RANGES[field] ?? 'above 0',
    note: MATERIAL_LAYER_NOTES[field],
  })]))),
  materialSubsurface: 'material.subsurface { weight, radius, scale, color } as Blender Principled BSDF Subsurface; surface tag, rasterizer only. Ranges in scene_create.',
  materialWear: 'material.wear { mask, threshold 0.5, softness 0.25, metal { color, metallic 1, roughness 0.3 }, dirt { mask, threshold, softness, color, roughness 0.9 } }: the material own color, metallic and roughness are the paint; per pixel it turns to the metal layer where the vertex group mask is high, then to dirt (no metal, rougher) where the dirt group is high. Masks are vertex groups of the node mesh (vertex_group measure edge, curvature or occlusion), so a mesh with no UVs works. Rasterizer only; not with baked sky visibility.',
  alphaModes: RECIPE_ALPHA_MODES,
  materialPatterns: MATERIAL_PATTERN_TYPES, maxMaterialPatterns: MAX_MATERIAL_PATTERNS,
  materialMappings: MATERIAL_MAPPINGS,
  renderPasses: Object.freeze({ names: RENDER_PASS_NAMES, files: 'render-<pass>.png/.exr or frame-N-<pass>.png/.exr (multilayer: true packs all into render.exr)', depth: `16 bits in red and green over ${RENDER_PASS_DEPTH_RANGE} m`, objectId: '24 bits in RGB; metrics.objectNames lists parts', cryptomatte: 'R object hash, G material hash, B coverage; metrics.cryptomatte holds manifests', aov: 'material.aov or pattern.graph.aov linear RGB', wireframe: 'polygon edges over diffuse; open orange, non-manifold red, flipped cyan, degenerate magenta; metrics.wireframe' }),
  // Recipe timeline (src/film-timeline.js), rendered with settings.timeline; the rest is in docs/agent-render-jobs.md.
  filmTimeline: Object.freeze({
    maxShots: 64, maxTotalSeconds: 60, maxShotSeconds: 30,
    shot: 'name (unique), duration, motionStart (default: the shot start, so non-looping motion must cover it), camera (partial: eye target up fov near far), focusDistance (m) and blur (0 to 1) for the depth of field of the shot, dip (s; fades through black at the cut into this shot).',
    notSupported: 'layers, overlaps, crossfades, markers, events, imported assets',
  }),
  curveText: Object.freeze({
    maxCurvePoints: CURVE_TEXT_LIMITS.maxCurvePoints, maxProfilePoints: CURVE_TEXT_LIMITS.maxProfilePoints,
    maxTextCharacters: CURVE_TEXT_LIMITS.maxTextCharacters, maxTextLines: CURVE_TEXT_LIMITS.maxTextLines,
    verticesPerCharacterSegment: CURVE_TEXT_LIMITS.verticesPerCharacterSegment,
    details: CURVE_TEXT_DETAILS,
  }),
  materialGraph: Object.freeze({ outputs: MATERIAL_GRAPH_OUTPUTS, operators: MATERIAL_GRAPH_OPERATORS, ...MATERIAL_GRAPH_LIMITS, nodes: MATERIAL_GRAPH_NODES }),
  // mesh_edit on an imported GLB part (geometry mesh-<n>, listed by scene_inspect). Edits run in the part's local space
  // (mesh_inspect gives localToWorldScale and localAxesInWorld) on a welded mesh with axis tags and a material tag.
  importedMeshEdits: Object.freeze({
    ...IMPORTED_MESH_EDIT_LIMITS,
    transfer: 'New vertices take skin weights, morph deltas and colours from the nearest original surface point; faces without UVs read the nearest UV island. Unsupported: mesh_stack, relations, instancing.',
    rejects: 'Skinned or morphed part: an edit farther than maxTransferFraction of the bounds diagonal from the original surface; booleans on open parts (fill_holes first).',
  }),
  fixedResources: false, dynamicTopology: true, checkpoints: true, positiveScaleOnly: true,
  gltfImport: 'Optional extensions and line primitives load with a warning; unlit and punctual lights are read.',
  authoredLook: true, maxPointLights: MAX_POINT_LIGHTS,
  catalogLooks: Object.freeze({ hdri: 'environment.hdri', hdris: BUNDLED_ENVIRONMENT_NAMES, cubeLooks: BUNDLED_CUBE_LOOK_NAMES, look: 'environment.look', catalogId: '64-hex ID of a .hdr or .cube in scene_asset_catalog', note: 'environmentIntensity and environmentRotation apply; keyIntensity 0 if the HDRI has a sun' }),
  physicalSky: 'environment.sky {type:physical, preset: golden-hour|sunset|blue-hour, sunElevation, sunRotation, turbidity, groundAlbedo, aerialPerspective} drives key, sky, fog; a low sun warms them',
  lightingSetups: LIGHTING_SETUP_NAMES,defaultLightingSetup: DEFAULT_LIGHTING_SETUP,
  ambientOcclusion: Object.freeze({ default: DEFAULT_AMBIENT_OCCLUSION, defaultRadius: 0.5, off: 0 }),
  // Local lights: spot and rectangular area lights. Shadows share one 2048 x 3072 depth atlas of 24 tiles; a shadowed
  // point light uses 6 tiles and a shadowed spot light 1. Area lights cast no shadow. Recipes reach light linking and cascaded sun shadows through lightLinking and shadowCascades below.
  maxSpotLights: MAX_SPOT_LIGHTS, maxAreaLights: MAX_AREA_LIGHTS,
  localShadows: Object.freeze({ lights: Object.freeze(['pointLights', 'spotLights']), atlasTiles: 24, pointLightTiles: 6, spotLightTiles: 1, tileSize: 512 }),
  lightLinking: Object.freeze({ fields: Object.freeze(['environment.keyAffects', 'pointLights[].affects', 'spotLights[].affects', 'areaLights[].affects']), unlisted: 'a light without affects lights every node', unknownNode: 'rejected', bake: 'honoured', pathTracer: 'ignored, named in report.ignored' }),
  localVolumes: Object.freeze({ field: 'environment.localVolumes', maximum: 8, shapes: Object.freeze(['box', 'sphere', 'mesh', 'grid']), fields: 'shape, center, size (box) or radius (sphere) or part + fit bounds|mesh (mesh: the named part, bounds by default; fit mesh fills a closed part, ignoring falloff, noise and steps), density 0-100 (1), falloff 0-1 (0.5), absorption rgb 0-1 (1,1,1), emission rgb 0-1, emissionStrength 0-1000 (1), scatter 0-1 (0; lit by the key light and the sky, not with fit mesh), blur 0-1 (1; softens the light behind it by optical depth, max 24 px at 540 rows), noiseAmount 0-1 (0; also ripples the faded edge, so use falloff 0.8 to 0.9 for a round cloud), noiseScale (1), steps 4-32 (16); grid: center, size (taken from the grid file when omitted), grid (a name.67vg in the grid folder or a registered name; scripts/vdb-to-grid.py makes it from a VDB), density scales the grid density, emission and emissionStrength light the flame channel, temperatureScale kelvin per grid unit (1), blackbodyIntensity 0-1 (0; lights the temperature channel), anisotropy -0.9-0.9 (0), steps 4-128 (64); one grid per scene, no falloff or noise', note: 'Absorb and emit; scatter above 0 lights the volume with the key light (shadow map, own depth toward the sun) and the sky term, 0 draws as before; density is extinction per metre times absorption, light behind = exp(-density * absorption * metres): about 0.3 is a thin haze (half shows through), 3 is thick smoke (under 3 percent); needs hdr and depth like volumeFog; noise is the same field in the rasterizer and the CPU path tracer; path tracer: backend cpu only (gpu, webgpu and native throw); a bake leaves them out, so an emissive volume lights no baked surface (bake report: skippedLocalVolumes, warnings).' }),
  shadowCascades: Object.freeze({ field: 'environment.shadowCascades', counts: Object.freeze([0, 1, 2, 3, 4]), zero: 'one shadow map', automatic: 'three cascades when shadow.extent is above 40 and the field is unset', maximumDistance: 150, note: 'volume fog and water read the single map' }),
  lineArt: Object.freeze({ field: 'environment.lines', fields: 'width px 0.25-16 (1.5), color, boundaries, creaseAngle deg (35), depthJump (0.08), toon steps 0-8, polylines [{points [x,y,z] 2-256, color, width, depthTest, closed}] max 64; {} turns on, null clears; material toon 0-8', note: 'docs/line-art.md' }),
  viewTransform: Object.freeze({
    field: 'environment.viewTransform', names: VIEW_TRANSFORM_NAMES, default: 'aces', look: 'environment.look', looks: LOOK_NAMES,
    choose: 'agx for lit scenes and Blender comparisons, neutral for product and brand colour, aces for contrast; needs loadAgentSceneModules',
  }),
  // Flush surfaces flicker (z-fighting). They are ranked at draw time by default; coplanar-overlap warns about what is left.
  renderFlags: Object.freeze({ nodeFields: Object.freeze(['visible', 'castShadow', 'receiveShadow', 'holdout', 'shadowCatcher', 'shadowOnly']), motion: 'node track property visible: 1 or 0, STEP', note: 'visible:false hides a node and children; holdout and shadowCatcher need a transparent canvas (Renderer67 transparent:true); flags split batches. Blended and transmissive parts cast a sun shadow weighted by opacity and tinted by colour (1024 map, one extra draw of those parts only); shadowOnly:true casts a shadow and is not drawn (gobo); castShadow:false turns it off, and cascades or splat/3-layer-map receivers skip the tint.' }),
  depthBias: Object.freeze({ nodeFields: Object.freeze(['decal', 'depthLayer']), maxDepthLayer: 4, environment: 'environment.resolveCoplanar', modes: Object.freeze(['offset', false]), default: 'offset', warning: 'coplanar-overlap', note: 'Automatic: flush or near-flush faces, inside one mesh or across parts, are ranked per triangle at draw time, the front face wins, geometry never moves; no field needed. resolveCoplanar false opts out. decal wins over the surface below; depthLayer stacks decals. scene_inspect flush.ranked counts ranked parts. A coplanar-overlap warning carries reason rank-overflow (over 15 stacked faces: remove duplicates), double-sided-gap, unchecked or collapsed-node.' }),
  proceduralMotion: true,
  motionIk: Object.freeze(['two-bone', 'aim', 'chain', 'spline']),
  // Authored rigs: armatures expand into bone nodes, and a node `skin` binds a mesh with automatic weights (four influences).
  // Node relations place a mesh node against other mesh nodes (world bounds), solved again after every edit.
  relations: Object.freeze({
    maxPerNode: 8, maxNodes: 256, sides: Object.freeze(['+x', '-x', '+y', '-y', '+z', '-z']),
    kinds: Object.freeze({
      attach: 'to, side, offset: touch the target face on side and centre on the other axes; offset is distance, negative sinks in',
      gap: 'to, side, offset: as attach on that axis only',
      flush: 'to, side, offset: own face on side level with the same face of the target',
      align: 'to, axis, at (min, center, max), offset: anchor on one axis',
      centered: 'to, axes (default x, y, z): centre on those axes',
    }),
    notes: 'Region (mesh tag): target faces only. One relation per axis, no loops, mesh nodes only. A relation sets translation on its axes. set-node with relations [] removes them.',
  }),
  rigging: Object.freeze({ presets: Object.freeze(['humanoid', 'quadruped']), maxArmatures: 16, maxBones: 128, maxInfluences: 4, weights: 'bone-distance' }),
  motionConstraints: Object.freeze(['copy_location', 'copy_rotation', 'copy_scale', 'limit_location', 'limit_rotation', 'track_to', 'child_of', 'floor', 'copy_transforms', 'limit_distance', 'limit_scale', 'stretch_to', 'locked_track', 'transformation', 'action', 'maintain_volume', 'damped_track', 'pivot', 'follow_path', 'clamp_to', 'shrinkwrap', 'armature']),
  motionDrivers: Object.freeze({ maxDrivers: 32, maxConstraints: 32, maxProperties: 32, maxPropertyKeys: 16, targets: Object.freeze(['node', 'material', 'light', 'morph', 'camera']), variables: Object.freeze(['time', 'node', 'custom', 'distance', 'rotationDifference']), maxExpressionParts: 64, maxExpressionDepth: 8 }),
  // Recipe physics: Rapier (an optional peer) bakes bodies on nodes offline; playback is a seek into the bake.
  physics: Object.freeze({
    bodyTypes: Object.freeze(['dynamic', 'fixed', 'kinematic']),
    shapes: Object.freeze(['box', 'ball', 'capsule', 'convex', 'trimesh']),
    jointTypes: Object.freeze(['spherical', 'revolute', 'prismatic', 'fixed']),
    sensors: true, collisionLayers: 16,
    breakableJoints: 'fixed joint breakImpulse (N s): breaks when a body takes a contact impulse (force x 1/60 s) over it in one step; scene_inspect lists jointBreaks. scene_apply fracture-node { node, cells 2-64, strength N s, seed 1, impact [x,y,z] in geometry space, impactRadius, density 1, friction }: replaces a convex root node by cells nodes NAME-frag-i (fragment geometries) with convex bodies and one breakable fixed joint NAME-glue-a-b per neighbour pair; send it after the set-physics that holds the floor, ball and duration (set-physics replaces the section). docs/physics.md.',
    ragdoll: 'physics.ragdoll {armature}: limp capsule per bone; needs a floor',
    film: 'render motion {start 0} plays this bake, cloth and particles with no bake-motion; video duration defaults to the bake.',
    limits: Object.freeze({ maxBodies: 128, maxJoints: 512, maxDuration: 10, framesPerSecond: 60, maxTrimeshTriangles: 20000, maxHullPoints: 2048 }),
  }),
  // Recipe cloth: a position-based solver (no peer dependency) records any root mesh node as a deformable sheet.
  cloth: Object.freeze({
    sheetGeometry: 'grid { segments 1-64 }: unit sheet in XY facing +Z, sized by node scale; any triangle mesh works',
    defaults: Object.freeze({ stiffness: 0.9, bend: 0.1, density: 0.2, damping: 0.3, friction: 0.3, thickness: 0.01, colliderShape: 'box' }),
    notes: 'density kg/m2, damping 1/s, thickness m, wind m/s steady. Colliders { node, shape ball|box } fit geometry bounds; like sheets they are root nodes without a motion track or body. Moving: { attach, shape ball|capsule, radius, offset, to, toOffset } or { armature, radiusFraction, exclude }. Sheet pinGroup: a vertex group whose vertices (weight 0.5 or more) are held. Sheet pinTo { node, weight } rides pinned edges on a node. Sheet stiffnessGroup: vertex group whose weights scale stiffness (floor 0.05). Sheet softBody { shape 0-1 (0.2), pressure 0-3 (1), bounce 0-1 (0) }: shape matching plus a volume term; pressure needs a closed mesh, a node with an open mesh fails and says to set pressure 0. bounce is the share of its landing speed the body keeps when it turns around; lower shape or sheet stiffness makes a softer, deeper dent. Sheet bendModel distance (default) or dihedral: dihedral holds the angle between neighbouring triangles, so a fine sheet folds in many soft ripples instead of one crease; set bend about 0.15 with it. Sheet bendYield (radians, dihedral only, off by default) lets a fold keep its crease: past that bend angle the rest angle follows the cloth by bendSet (0-1, 0.1) of the excess each substep, so a crumpled sheet stays crumpled. Sheet pinTo.releaseAt (seconds, optional) lets the pinned edges go at that time and fall with the rest. Sheet staticFriction (0-1, 0) holds cloth still on a collider when its sideways travel is under that multiple of the contact depth, so it rests on a slope below its friction angle. Sheet selfCollision true: particles of the sheet push apart (radius 0.9 of half the shortest edge, or the sheet thickness when set, up to 5000 particles); cloth does not collide with other sheets.',
    limits: Object.freeze({ maxSheets: 8, maxColliders: 16, maxMovingColliders: 64, maxDuration: 10, maxParticles: 5000, framesPerSecond: 60, substeps: 4, iterations: 8 }),
  }),
  // Recipe particles: closed-form from seeded launch values, so any time is computed directly and a seek never replays.
  particles: Object.freeze({
    emitter: 'System node geometry is the particle shape; its transform does not move them. Fields (defaults): node, seed (1), count (100), rate (per second; omit: burst at 0), lifetime, speed, size (number or [min, max]; 1, 1, 0.05), direction ([0,1,0]), spread (cone degrees, 30), emitter { shape point|box|sphere|disc|mesh, position, halfExtents, radius; mesh: mesh node, group (vertex group weighting surface, vertices or edges), from surface (area weighted)|vertices|edges (length weighted)|volume (closed mesh), sharpAngle (degrees, edges only: keep open or bent edges), normalSpeed m/s along the normal }, instances [node ids, up to 8: each particle draws one], orient none|random|normal (mesh surface, vertices or edges), scale constant|shrink|grow, drag (1/s, 0), floor (world y they land on).',
    hair: 'type hair grows strands from a read-only root surface node into node (its own geometry is ignored). Fields (defaults): surface, seed, count, length (m, number or [min, max], 0.1), segments (1-8, 4), width (m, 0.004), droop (0.5), lean (0.2), sway (tip travel m, off), swayRate (Hz, 0.5). Tapering tubes, no UVs.',
    sectionFields: 'systems, gravity ([0,-9.81,0]), wind (m/s; moves emitter particles only with drag > 0, and sets the hair sway direction), fields (also cloth; wind, turbulence, vortex, drag, magnet: docs/physics.md)',
    collision: 'colliders [node ids], bounce 0-1 (0.3 with colliders), friction 0-1 (0.5), spin deg/s, color [[r,g,b] birth, [r,g,b] death], alpha [birth, death].',
    notes: 'Pure function of seed, index and time; raising count keeps earlier ones. No hair collision.',
    limits: Object.freeze({ maxSystems: 4, maxParticlesPerSystem: 2000, maxParticles: 4000, maxVertices: 100000, maxLifetime: 60 }),
  }),
  // Recipe bake: bounced light written into lightmaps at build time (src/light-bake.js, loaded on demand).
  bake: Object.freeze({
    fields: 'preset, or samples (1-256), bounces (1-8), texelsPerUnit (1-12) over it; irradianceGrid true or 8-48 nodes: baked bounced diffuse light in place of lightmaps (opt in, static); gridFog true adds the fog (sunlit closed rooms); probes room by default, false for none, or up to 4 {position, radius?}; rebake true bakes each sampled pose (4 kept).',
    presets: BAKE_PRESETS,
    notes: 'Bounced light from point, spot, area and key lights. Skips alpha, skin, morph, hair, cloth (bake.skipped). A preset shrinks to fit (bake.used, bake.reduction); explicit settings fail over maxPathWork or past maxSeconds. No environment map or specular; probes are specular, not in glTF.',
    limits: Object.freeze({ maxSeconds: BAKE_MAXIMUM_SECONDS, workerMaxSeconds: BAKE_WORKER_MAXIMUM_SECONDS, maxPathWork: BAKE_EXPLICIT_PATH_WORK_LIMIT, maxPointLights: MAX_POINT_LIGHTS }),
  }),
  motionLook: Object.freeze({
    light: 'id point:N, spot:N or area:N (index in its list): position, color, intensity; direction on spot and area',
    sun: 'direction, color, intensity (lightDirection, keyColor, keyIntensity)',
    environment: 'skyTop, skyBottom, fogColor, fogDensity, volumeFogDensity, ambientIntensity, fillIntensity, environmentIntensity, environmentRotation',
    effects: 'exposure, focusDistance (needs effects.depthOfField.blur above 0; an fStop camera focuses on its target)',
    note: 'Same keyframes and easing as other tracks. After sampleMotion, scene.environment and scene.effects hold the sampled values.',
  }),
  motionModifiers: 'Track extrapolation constant|linear; modifiers [{type: cycles|stepped|noise|generator|limits|envelope, ...}], 8 at most; cycles and stepped remap time first.',
  motionLimits: Object.freeze({ maxTracks: 128, maxKeyframesPerTrack: 64, maxKeyframes: 2048, maxDuration: 30 }),
  motionBake: 'scene_apply bake-motion { nodes (32 at most), start 0, end (motion or physics duration), step 1/30 (512 samples), tolerance { position m, angle deg, scale } }: samples tracks, IK, constraints, drivers and physics into LINEAR tracks and removes those sources (an IK solver or the physics world only when all its nodes are baked). tolerance drops keys within it; without it a track keeps every sample, 64 keys at most. Procedural scenes only.',
  springBones: 'motion.springs { chains: [{ bones: [node IDs root to tip, each the child of the one before, 16 per chain, 64 in all], stiffness 0-4 (1), dragForce 0-1 (0.4), gravityPower 0-2 (0), gravityDir [0,-1,0], hitRadius (0.02), tipLength (0.07), colliders: [ids] }] (16 at most), colliders: [{ id, bone, type sphere|capsule, offset, radius, tail }] }: VRM spring bones for hair and tails; fixed 1/60 s steps, sample times in increasing order; bake-motion bakes whole chains; needs loadAgentSceneModules.',
});

/** Degrees between faces above which a mesh geometry keeps a hard edge, as Blender's auto smooth does. */
export const MESH_SMOOTH_ANGLE_DEFAULT = 30;
