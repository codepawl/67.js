// Checks on the state of an exported scene recipe: camera, lights, materials, sky and timeline tracks. They read the
// recipe's own fields, so they grade what the agent left behind and never how it got there. Keyframe checks look at the
// keyed values themselves, not at what an interpolation does between them.

const round = value => Number(value.toFixed(2));
const distance = (first, second) => Math.hypot(...first.map((value, axis) => value - second[axis]));
const inRange = (value, [lowest, highest]) => value >= lowest && value <= highest;

function tracksOf(recipe, kind, property) {
  return (recipe.motion?.tracks ?? []).filter(track => track.kind === kind && track.property === property);
}

function keyedValues(track) {
  return track.keyframes.map(keyframe => keyframe.value);
}

function lastTime(track) {
  return track.keyframes.reduce((latest, keyframe) => Math.max(latest, keyframe.time), 0);
}

function cameraAims(check, recipe) {
  const { camera } = recipe;
  const node = recipe.nodes.find(candidate => candidate.id === check.node);
  if (!camera || !node) return { pass: false, detail: 'no camera or no such node in the recipe' };
  const centre = node.translation ?? [0, 0, 0];
  const toCentre = centre.map((value, axis) => value - camera.eye[axis]);
  const toTarget = camera.target.map((value, axis) => value - camera.eye[axis]);
  const along = toCentre.reduce((total, value, axis) => total + value * toTarget[axis], 0) / Math.hypot(...toTarget);
  const miss = Math.sqrt(Math.max(0, Math.hypot(...toCentre) ** 2 - along ** 2));
  const eyeDistance = Math.hypot(...toCentre);
  const fov = camera.fov ?? 45;
  const problems = [];
  if (along <= 0 || miss > check.maxMiss) problems.push(`sight line misses the node by ${round(miss)} m`);
  if (!inRange(eyeDistance, check.distance)) problems.push(`eye ${round(eyeDistance)} m away`);
  if (!inRange(fov, check.fov)) problems.push(`fov ${fov}`);
  return { pass: problems.length === 0, detail: problems.join('; ') || `miss ${round(miss)} m, ${round(eyeDistance)} m away, fov ${fov}` };
}

function cameraOrbit(check, recipe) {
  const [eyeTrack] = tracksOf(recipe, 'camera', 'eye');
  const [targetTrack] = tracksOf(recipe, 'camera', 'target');
  if (!eyeTrack || !targetTrack) return { pass: false, detail: 'the camera eye and target are not both keyed' };
  const problems = [];
  const duration = lastTime(eyeTrack);
  if (!inRange(duration, check.duration)) problems.push(`eye track lasts ${round(duration)} s`);
  const eyes = keyedValues(eyeTrack);
  const radii = eyes.map(eye => Math.hypot(eye[0] - check.around[0], eye[2] - check.around[2]));
  if (!radii.every(radius => inRange(radius, check.radius))) problems.push(`radius ${round(Math.min(...radii))} to ${round(Math.max(...radii))} m`);
  if (!eyes.every(eye => inRange(eye[1], check.height))) problems.push('eye leaves the height range');
  let sweep = 0;
  for (let index = 1; index < eyes.length; index++) {
    const before = Math.atan2(eyes[index - 1][2] - check.around[2], eyes[index - 1][0] - check.around[0]);
    const after = Math.atan2(eyes[index][2] - check.around[2], eyes[index][0] - check.around[0]);
    let step = after - before;
    while (step > Math.PI) step -= 2 * Math.PI;
    while (step < -Math.PI) step += 2 * Math.PI;
    sweep += step;
  }
  const degrees = Math.abs(sweep) * 180 / Math.PI;
  if (degrees < check.sweepDegrees) problems.push(`sweeps ${Math.round(degrees)} degrees`);
  if (!keyedValues(targetTrack).every(target => distance(target, check.around) <= 0.4)) problems.push('camera target leaves the statue');
  return { pass: problems.length === 0, detail: problems.join('; ') || `sweeps ${Math.round(degrees)} degrees at ${round(Math.min(...radii))} to ${round(Math.max(...radii))} m` };
}

function cameraDolly(check, recipe) {
  const [eyeTrack] = tracksOf(recipe, 'camera', 'eye');
  const [targetTrack] = tracksOf(recipe, 'camera', 'target');
  if (!eyeTrack || !targetTrack) return { pass: false, detail: 'the camera eye and target are not both keyed' };
  const problems = [];
  const duration = lastTime(eyeTrack);
  if (!inRange(duration, check.duration)) problems.push(`eye track lasts ${round(duration)} s`);
  const eyes = keyedValues(eyeTrack);
  const start = distance(eyes[0], check.toward);
  const end = distance(eyes.at(-1), check.toward);
  if (!inRange(start, check.startDistance)) problems.push(`starts ${round(start)} m away`);
  if (!inRange(end, check.endDistance)) problems.push(`ends ${round(end)} m away`);
  if (!keyedValues(targetTrack).every(target => distance(target, check.toward) <= 0.4)) problems.push('camera target leaves the statue');
  return { pass: problems.length === 0, detail: problems.join('; ') || `dolly from ${round(start)} m to ${round(end)} m in ${round(duration)} s` };
}

function lights(check, recipe) {
  const list = recipe.environment?.[check.field] ?? [];
  const problems = [];
  if (list.length < check.min || list.length > check.max) problems.push(`${list.length} ${check.field}`);
  for (const light of list) {
    if (check.castShadow && light.castShadow !== true) problems.push('a light has shadows off');
    if (check.cool && !(light.color && light.color[2] > light.color[0])) problems.push('a light is not cool (blue above red)');
    if (check.minX !== undefined && light.position[0] < check.minX) problems.push(`a light sits at x ${light.position[0]}`);
    if (check.minHeight !== undefined && light.position[1] < check.minHeight) problems.push(`a light is only ${light.position[1]} m high`);
    if (check.aimAt) {
      const toTarget = check.aimAt.position.map((value, axis) => value - light.position[axis]);
      const length = Math.hypot(...toTarget);
      const directionLength = Math.hypot(...light.direction);
      const cosine = toTarget.reduce((total, value, axis) => total + value * light.direction[axis], 0) / (length * directionLength);
      const miss = length * Math.sqrt(Math.max(0, 1 - cosine ** 2));
      if (cosine <= 0 || miss > check.aimAt.maxMiss) problems.push(`a light misses its target by ${round(miss)} m`);
    }
  }
  return { pass: problems.length === 0, detail: problems.join('; ') || `${list.length} ${check.field} as asked` };
}

function sunLight(check, recipe) {
  const { keyColor = [1, 1, 1], keyIntensity = 0 } = recipe.environment ?? {};
  const problems = [];
  if (keyIntensity < check.minIntensity) problems.push(`sun intensity ${keyIntensity}`);
  if (check.warm && !(keyColor[0] > keyColor[2] * 1.2)) problems.push(`sun colour ${keyColor.map(round)} is not warm`);
  return { pass: problems.length === 0, detail: problems.join('; ') || `sun ${keyColor.map(round)} at ${keyIntensity}` };
}

// A scaled unit box rests on the ground or on a top face when its underside is within 3 cm of that height.
function restsOnSupport(check, recipe) {
  const node = recipe.nodes.find(candidate => candidate.id === check.node);
  if (!node) return { pass: false, detail: `no node ${check.node}` };
  const underside = (node.translation?.[1] ?? 0) - (node.scale?.[1] ?? 1) / 2;
  const supportHeights = check.supports.map(supportId => {
    const support = recipe.nodes.find(candidate => candidate.id === supportId);
    return (support.translation?.[1] ?? 0) + (support.scale?.[1] ?? 1) / 2;
  });
  const gap = Math.min(...supportHeights.map(height => Math.abs(underside - height)));
  return { pass: gap <= 0.03, detail: `${check.node} underside is ${round(gap)} m from the nearest support` };
}

// Key light times exposure is what reaches the sensor; too much clips the frame to white, too little leaves it black.
function litRange(check, recipe) {
  const strength = (recipe.environment?.keyIntensity ?? 0.8) * (recipe.effects?.exposure ?? 1);
  return { pass: inRange(strength, check.range), detail: `key intensity times exposure is ${round(strength)}` };
}

function materialOf(check, recipe) {
  const node = recipe.nodes.find(candidate => candidate.id === check.node);
  const material = recipe.materials.find(candidate => candidate.id === node?.material);
  if (!material) return { pass: false, detail: `node ${check.node} has no material` };
  const { color = [1, 1, 1], metallic = 0, roughness = 1 } = material;
  const problems = [];
  if (check.metallic && !inRange(metallic, check.metallic)) problems.push(`metallic ${metallic}`);
  if (check.roughness && !inRange(roughness, check.roughness)) problems.push(`roughness ${roughness}`);
  if (check.warm && !(color[0] > color[2])) problems.push('colour is not warm');
  return { pass: problems.length === 0, detail: problems.join('; ') || `metallic ${metallic}, roughness ${roughness}` };
}

function fieldValue(check, source, name) {
  const value = source?.[check.field];
  if (value === undefined || value === null) return { pass: false, detail: `${name}.${check.field} is not set` };
  if (check.range) return { pass: inRange(value, check.range), detail: `${check.field} ${value}` };
  const channelsOk = value.every(channel => channel >= 0.5 && channel <= 0.9);
  return { pass: Boolean(channelsOk && value[2] >= value[0]), detail: `${check.field} ${value.map(round)}` };
}

function track(check, recipe) {
  const [found] = tracksOf(recipe, check.trackKind, check.property);
  if (!found) return { pass: false, detail: `no ${check.trackKind} ${check.property} track` };
  const duration = lastTime(found);
  const values = keyedValues(found);
  const span = typeof values[0] === 'number'
    ? Math.max(...values) - Math.min(...values)
    : Math.max(...values[0].map((_, axis) => Math.max(...values.map(value => value[axis])) - Math.min(...values.map(value => value[axis]))));
  const problems = [];
  if (!inRange(duration, check.duration)) problems.push(`lasts ${round(duration)} s`);
  if (span < check.minSpan) problems.push(`values move only ${round(span)}`);
  return { pass: problems.length === 0, detail: problems.join('; ') || `${round(duration)} s, values move ${round(span)}` };
}

function trackRedder(check, recipe) {
  const [found] = tracksOf(recipe, check.trackKind, check.property);
  if (!found) return { pass: false, detail: `no ${check.trackKind} ${check.property} track` };
  const [first] = keyedValues(found);
  const last = keyedValues(found).at(-1);
  const ratio = colour => colour[0] / Math.max(colour[2], 0.001);
  return { pass: ratio(last) > ratio(first) * 1.3, detail: `red over blue ${round(ratio(first))} to ${round(ratio(last))}` };
}

function trackLower(check, recipe) {
  const [found] = tracksOf(recipe, check.trackKind, check.property);
  if (!found) return { pass: false, detail: `no ${check.trackKind} ${check.property} track` };
  const slope = vector => Math.abs(vector[check.component]) / Math.hypot(...vector);
  const [first] = keyedValues(found);
  const last = keyedValues(found).at(-1);
  return { pass: slope(last) < slope(first) * 0.6, detail: `steepness ${round(slope(first))} to ${round(slope(last))}` };
}

const SCENE_CHECKS = { cameraAims, cameraOrbit, cameraDolly, lights, sunLight, restsOnSupport, litRange, materialOf, track, trackRedder, trackLower,
  environmentValue: (check, recipe) => fieldValue(check, recipe.environment, 'environment'),
  effectsValue: (check, recipe) => fieldValue(check, recipe.effects, 'effects') };

export const isSceneCheck = kind => kind in SCENE_CHECKS;

export function checkSceneState(check, recipe) {
  return SCENE_CHECKS[check.kind](check, recipe);
}
