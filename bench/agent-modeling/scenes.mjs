// Scene, look, light, camera and film tasks for the agent bench. Each starts from a small recipe given in the prompt and
// asks for a change to the camera, the lights, a material, the sky or a timeline. The grader reads the exported recipe
// (scene-checks.mjs), so it grades the state the agent left and never the calls it made.

const SCENE_NODES = [
  { id: 'floor', geometry: 'block', material: 'stone', scale: [8, 0.1, 8], translation: [0, -0.05, 0] },
  { id: 'plinth', geometry: 'block', material: 'stone', scale: [0.8, 0.6, 0.8], translation: [0, 0.3, 0] },
  { id: 'statue', geometry: 'block', material: 'bronze', scale: [0.4, 1, 0.3], translation: [0, 1.1, 0] },
];
const STATUE_CENTRE = [0, 1.1, 0];

function stageRecipe(extra = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0.01 }],
    materials: [{ id: 'stone', color: [0.7, 0.68, 0.64] }, { id: 'bronze', color: [0.45, 0.3, 0.2] }],
    nodes: structuredClone(SCENE_NODES),
    camera: { target: [0, 1, 0], eye: [6, 4, 8], up: [0, 1, 0], fov: 50, near: 0.1, far: 60 },
    ...extra,
  };
}

const STAGE = 'The stage scene below has a floor, a plinth and a statue (node "statue", centred at [0, 1.1, 0], about 1 m tall).';
const FINISH = 'When it is finished, call scene_export_recipe once: the exported recipe is what gets graded.';
const PLAIN_PREAMBLE = 'You are working with the Crucible MCP tools. Units are metres and Y is up.';

const CLOSEUP_CHECKS = [
  { kind: 'lint' },
  { kind: 'parts', min: 3, max: 3 },
  { kind: 'cameraAims', node: 'statue', maxMiss: 0.3, distance: [1.5, 3.5], fov: [20, 50] },
];

const ORBIT_CHECKS = [
  { kind: 'lint' },
  { kind: 'cameraOrbit', around: STATUE_CENTRE, duration: [5.5, 6.5], radius: [2.5, 6], height: [0.8, 3], sweepDegrees: 180 },
];

const KEY_FILL_CHECKS = [
  { kind: 'lint' },
  { kind: 'parts', min: 3, max: 3 },
  { kind: 'sunLight', warm: true, minIntensity: 1, label: 'warm key sun' },
  { kind: 'lights', field: 'pointLights', min: 1, max: 2, cool: true, minX: 0.5, label: 'cool point fill on the right' },
];

const SPOT_CHECKS = [
  { kind: 'lint' },
  { kind: 'lights', field: 'spotLights', min: 1, max: 1, castShadow: true, aimAt: { position: STATUE_CENTRE, maxMiss: 0.3 }, minHeight: 2.5, label: 'one shadow spot above, aimed at the statue' },
  { kind: 'centreAt', node: 'statue', position: STATUE_CENTRE },
];

const METAL_CHECKS = [
  { kind: 'lint' },
  { kind: 'materialOf', node: 'statue', metallic: [0.85, 1], roughness: [0.15, 0.5], warm: true, label: 'polished gold on the statue' },
  { kind: 'materialOf', node: 'plinth', metallic: [0, 0.2], label: 'plinth stays stone' },
  { kind: 'centreAt', node: 'statue', position: STATUE_CENTRE },
];

const FOG_CHECKS = [
  { kind: 'lint' },
  { kind: 'environmentValue', field: 'fogDensity', range: [0.03, 0.3], label: 'thin fog' },
  { kind: 'environmentValue', field: 'fogColor', cool: true, label: 'cool grey fog' },
  { kind: 'effectsValue', field: 'exposure', range: [0.8, 1.6], label: 'exposure stays readable' },
  { kind: 'parts', min: 3, max: 3 },
];

const SUNSET_CHECKS = [
  { kind: 'lint' },
  { kind: 'track', trackKind: 'sun', property: 'direction', duration: [3.5, 4.5], minSpan: 3.5, label: 'sun direction moves over 4 s' },
  { kind: 'trackRedder', trackKind: 'sun', property: 'color', label: 'sun colour gets warmer' },
  { kind: 'trackLower', trackKind: 'sun', property: 'direction', component: 1, label: 'sun sinks' },
];

const FILM_CHECKS = [
  { kind: 'lint' },
  { kind: 'parts', min: 3, max: 3 },
  { kind: 'cameraDolly', toward: STATUE_CENTRE, duration: [5.5, 6.5], startDistance: [6, 14], endDistance: [1.5, 3.5] },
  { kind: 'track', trackKind: 'effects', property: 'exposure', duration: [5.5, 6.5], minSpan: 0.2, label: 'exposure fades up' },
  { kind: 'track', trackKind: 'camera', property: 'target', duration: [5.5, 6.5], minSpan: 0, label: 'camera target keyed' },
];

const FINDINGS_CHECKS = [
  { kind: 'lint' },
  { kind: 'parts', min: 4, max: 4 },
  { kind: 'restsOnSupport', node: 'crate', supports: ['floor', 'plinth'], label: 'the crate rests on the floor or the plinth' },
  { kind: 'litRange', range: [0.2, 5], label: 'key light is neither blown out nor black' },
  { kind: 'centreAt', node: 'statue', position: STATUE_CENTRE },
];

export const SCENE_TASKS = [
  {
    id: 'camera-closeup',
    startRecipe: stageRecipe(),
    ownPreamble: true,
    prompt: `${PLAIN_PREAMBLE} ${STAGE} Set the camera for a close-up of the statue: the camera looks at the statue (within 0.3 m of its centre),
the eye is 1.5 to 3.5 m from the statue and the field of view is between 20 and 50 degrees. Do not move or change the objects. ${FINISH}`,
    checks: CLOSEUP_CHECKS,
  },
  {
    id: 'camera-orbit',
    startRecipe: stageRecipe(),
    ownPreamble: true,
    prompt: `${PLAIN_PREAMBLE} ${STAGE} Add a 6 second camera move: the camera circles the statue by at least half a turn (180 degrees seen from above),
keeping 2.5 to 6 m from the statue's vertical axis and between 0.8 and 3 m above the ground, and always looking at the statue's centre. Key the camera eye and target. ${FINISH}`,
    checks: ORBIT_CHECKS,
  },
  {
    id: 'light-key-fill',
    startRecipe: stageRecipe(),
    ownPreamble: true,
    prompt: `${PLAIN_PREAMBLE} ${STAGE} Light it as a portrait: a warm key light (the sun: intensity at least 1, red clearly above blue in its colour) plus one cool point light as a fill (blue above red) at least 0.5 m to the right of the statue (x of 0.5 or more). Do not change the objects. ${FINISH}`,
    checks: KEY_FILL_CHECKS,
  },
  {
    id: 'light-spot-shadow',
    startRecipe: stageRecipe(),
    ownPreamble: true,
    prompt: `${PLAIN_PREAMBLE} ${STAGE} Add exactly one spotlight with shadows on, at least 2.5 m above the ground, aimed at the statue's centre (within 0.3 m).
Do not change the objects. ${FINISH}`,
    checks: SPOT_CHECKS,
  },
  {
    id: 'look-metal',
    startRecipe: stageRecipe(),
    ownPreamble: true,
    prompt: `${PLAIN_PREAMBLE} ${STAGE} Make the statue polished gold: metallic at least 0.85, roughness between 0.15 and 0.5, and a warm colour (red above blue).
The plinth and floor stay as they are. ${FINISH}`,
    checks: METAL_CHECKS,
  },
  {
    id: 'look-fog',
    startRecipe: stageRecipe(),
    ownPreamble: true,
    prompt: `${PLAIN_PREAMBLE} ${STAGE} Give it a foggy morning look: fog density between 0.03 and 0.3 with a cool grey fog colour (blue at least as high as red,
all channels between 0.5 and 0.9), and keep the exposure between 0.8 and 1.6 so it stays readable. Do not change the objects. ${FINISH}`,
    checks: FOG_CHECKS,
  },
  {
    id: 'findings-fix',
    startRecipe: stageRecipe({
      materials: [{ id: 'stone', color: [0.7, 0.68, 0.64] }, { id: 'bronze', color: [0.45, 0.3, 0.2] }, { id: 'wood', color: [0.6, 0.4, 0.2] }],
      nodes: [...structuredClone(SCENE_NODES), { id: 'crate', geometry: 'block', material: 'wood', scale: [0.5, 0.5, 0.5], translation: [1.6, 0.9, 0.4] }],
      camera: { target: [0, 0.8, 0], eye: [4, 2.5, 5], up: [0, 1, 0], fov: 50, near: 0.1, far: 60 },
      environment: { keyIntensity: 40 },
    }),
    ownPreamble: true,
    prompt: `${PLAIN_PREAMBLE} The stage scene below has a floor, a plinth, a statue and a crate, and it renders wrongly: one object is placed wrongly and the lighting is badly set. Look at the scene with scene_look, find what is wrong and fix both problems. Leave the floor, plinth and statue where they are, and change only what is wrong. ${FINISH}`,
    checks: FINDINGS_CHECKS,
  },
  {
    id: 'sunset-timelapse',
    startRecipe: stageRecipe({ environment: { lightDirection: [-1, -4, -1], keyColor: [3, 2.8, 2.5], keyIntensity: 3 } }),
    ownPreamble: true,
    prompt: `${PLAIN_PREAMBLE} ${STAGE} Add a 4 second sunset: key the sun direction so it sinks (its downward component shrinks toward the horizon) and key the sun
colour so it turns warmer (red up, blue down) between time 0 and time 4. ${FINISH}`,
    checks: SUNSET_CHECKS,
  },
  {
    id: 'film-reveal',
    startRecipe: stageRecipe(),
    ownPreamble: true,
    prompt: `${PLAIN_PREAMBLE} ${STAGE} Make a 6 second reveal shot: the camera starts 6 to 14 m from the statue and dollies in to 1.5 to 3.5 m from it, looking at the
statue's centre the whole way (key the camera eye and target), while the exposure fades up by at least 0.2 over the same 6 seconds (key effects exposure). ${FINISH}`,
    checks: FILM_CHECKS,
  },
];

function trackOf(kind, property, keyframes, extra = {}) {
  return { kind, property, interpolation: 'LINEAR', keyframes: keyframes.map(([time, value]) => ({ time, value })), ...extra };
}

function orbitKeyframes(radius, height, steps, seconds) {
  return Array.from({ length: steps + 1 }, (_, step) => {
    const angle = Math.PI * 1.2 * (step / steps);
    return [seconds * step / steps, [Number((radius * Math.cos(angle)).toFixed(3)), height, Number((radius * Math.sin(angle)).toFixed(3))]];
  });
}

export const SCENE_REFERENCES = {
  'findings-fix': stageRecipe({
    materials: [{ id: 'stone', color: [0.7, 0.68, 0.64] }, { id: 'bronze', color: [0.45, 0.3, 0.2] }, { id: 'wood', color: [0.6, 0.4, 0.2] }],
    nodes: [...structuredClone(SCENE_NODES), { id: 'crate', geometry: 'block', material: 'wood', scale: [0.5, 0.5, 0.5], translation: [1.6, 0.25, 0.4] }],
    camera: { target: [0, 0.8, 0], eye: [4, 2.5, 5], up: [0, 1, 0], fov: 50, near: 0.1, far: 60 },
    environment: { keyIntensity: 1 },
  }),
  'camera-closeup': stageRecipe({ camera: { target: [0, 1.1, 0], eye: [0, 1.4, 2.5], up: [0, 1, 0], fov: 35, near: 0.1, far: 60 } }),
  'camera-orbit': stageRecipe({
    motion: {
      duration: 6,
      tracks: [
        trackOf('camera', 'eye', orbitKeyframes(4, 2, 12, 6)),
        trackOf('camera', 'target', [[0, STATUE_CENTRE], [6, STATUE_CENTRE]]),
      ],
    },
  }),
  'light-key-fill': stageRecipe({
    environment: {
      lightDirection: [0.6, -0.5, -0.6], keyColor: [1, 0.75, 0.5], keyIntensity: 2.5,
      pointLights: [{ position: [2, 1.5, 2], color: [0.5, 0.65, 1], intensity: 6 }],
    },
  }),
  'light-spot-shadow': stageRecipe({
    environment: { spotLights: [{ position: [1, 4, 1.5], direction: [-0.2857, -0.8286, -0.4286], angle: 0.5, intensity: 40, castShadow: true }] },
  }),
  'look-metal': (() => {
    const recipe = stageRecipe();
    recipe.materials = recipe.materials.map(material => (material.id === 'bronze' ? { id: 'bronze', color: [1, 0.78, 0.34], metallic: 1, roughness: 0.3 } : material));
    return recipe;
  })(),
  'look-fog': stageRecipe({ environment: { fogDensity: 0.1, fogColor: [0.72, 0.75, 0.8] }, effects: { exposure: 1.1 } }),
  'sunset-timelapse': stageRecipe({
    environment: { lightDirection: [-1, -4, -1], keyColor: [3, 2.8, 2.5], keyIntensity: 3 },
    motion: {
      duration: 4,
      tracks: [
        trackOf('sun', 'direction', [[0, [-1, -4, -1]], [4, [-4, -0.3, -1]]]),
        trackOf('sun', 'color', [[0, [3, 2.8, 2.5]], [4, [3.4, 1.4, 0.6]]]),
      ],
    },
  }),
  'film-reveal': stageRecipe({
    motion: {
      duration: 6,
      tracks: [
        trackOf('camera', 'eye', [[0, [0, 3, 10]], [6, [0, 1.5, 2.5]]]),
        trackOf('camera', 'target', [[0, STATUE_CENTRE], [6, STATUE_CENTRE]]),
        trackOf('effects', 'exposure', [[0, 0.6], [6, 1.2]]),
      ],
    },
  }),
};
