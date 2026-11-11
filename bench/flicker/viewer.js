// Flicker viewer (issue #751): fly or orbit through a GLB and see which pixels still change owner between two frames that differ
// by a sub-pixel camera jitter. Open /bench/flicker/index.html?asset=/path/to/file.glb, or drop a GLB on the page.
import { vec3 } from 'gl-matrix';
import { Renderer67 } from '../../src/index.js';
import { parseGltf } from '../../src/gltf.js';
import { resolveFlushParts } from '../../src/coplanar-overlap.js';
import { flushOrderOf } from '../../src/depth-layer.js';
import { TRAPS } from './traps.js';
import { collectWorldTriangles, castPixelOwners, compareWithGroundTruth } from './ground-truth.js';

// One flat colour per part, no textures, so a pixel's colour says which part owns it and a changed colour is a changed owner.
function paintPartsByOwner(parts) {
  parts.forEach((part, index) => {
    const hue = ((index * 0.618034) % 1) * 0.72;
    const channel = offset => 0.5 + 0.5 * Math.cos(2 * Math.PI * (hue + offset));
    const { map, ...material } = part.material;
    part.material = { ...material, color: [channel(0), channel(1 / 3), channel(2 / 3)], metallic: 0, roughness: 1 };
  });
}

// An unlit surface leaves the renderer as pow(colour, 1 / 2.2) when the frame is not HDR.
const DISPLAY_GAMMA = 2.2;

// facets=1: one colour per triangle instead of per part. Two faces of one part that meet at a crease then differ in colour, so the
// probe reads the crease as an edge and stops counting its ordinary anti-aliasing as flicker. Fighting triangles still differ.
function paintTrianglesApart(parts) {
  let triangleNumber = 0;
  for (const part of parts) {
    const { positions, normals, indices } = part.geometry;
    const triangleCount = indices.length / 3;
    const flatPositions = new Float32Array(triangleCount * 9);
    const flatNormals = new Float32Array(triangleCount * 9);
    const colors = new Float32Array(triangleCount * 9);
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      triangleNumber++;
      const hue = ((triangleNumber * 0.618034) % 1);
      const colour = options.triangleIds
        ? [triangleNumber & 255, (triangleNumber >> 8) & 255, (triangleNumber >> 16) & 255].map(byte => (byte / 255) ** DISPLAY_GAMMA)
        : [0, 1 / 3, 2 / 3].map(offset => 0.35 + 0.65 * (0.5 + 0.5 * Math.cos(2 * Math.PI * (hue + offset))));
      for (let corner = 0; corner < 3; corner++) {
        const source = indices[triangle * 3 + corner] * 3;
        const target = (triangle * 3 + corner) * 3;
        flatPositions.set(positions.subarray(source, source + 3), target);
        flatNormals.set(normals.subarray(source, source + 3), target);
        colors.set(colour, target);
      }
    }
    part.geometry = { positions: flatPositions, normals: flatNormals, colors, indices: Uint32Array.from({ length: triangleCount * 3 }, (_, index) => index) };
    const { map, ...material } = part.material;
    part.material = { ...material, color: [1, 1, 1], metallic: 0, roughness: 1, ...(options.triangleIds ? { tag: 'unlit' } : {}) };
  }
}

function measureBounds(parts) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const point = vec3.create();
  for (const part of parts) {
    const positions = part.geometry.positions;
    for (let index = 0; index < positions.length; index += 3) {
      vec3.transformMat4(point, positions.subarray(index, index + 3), part.matrix);
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis], point[axis]);
        maximum[axis] = Math.max(maximum[axis], point[axis]);
      }
    }
  }
  return { minimum, maximum };
}

const JITTER_PIXELS = 0.125;
const CHANGE_THRESHOLD = 24;
const EDGE_THRESHOLD = 48;
const OPEN_THRESHOLD = 10;
const FIELD_OF_VIEW = 45;

const canvas = document.querySelector('#viewport');
const overlay = document.querySelector('#overlay');
const readout = document.querySelector('#readout');
const status = document.querySelector('#status');
const parameters = new URLSearchParams(location.search);

const ICONS = {
  ok: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M5 8.3l2 2 4-4.6"/></svg>',
  bad: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8l6.5 11.7h-13z"/><path d="M8 6.5v3"/><path d="M8 11.8v.1"/></svg>',
  wait: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>',
};

const options = {
  reversed: parameters.get('reversed') !== '0',
  nearFit: parameters.get('nearFit') !== '0',
  offset: parameters.get('offset') !== '0',
  ids: parameters.get('ids') === '1',
  // shadows=0 turns off casting and receiving, to tell shadow-edge aliasing apart from depth fighting.
  shadows: parameters.get('shadows') !== '0',
  facets: parameters.get('facets') === '1' || parameters.get('facets') === '2',
  // facets=2: the colour of every triangle is its own number, drawn unlit, so the frame tells exactly which face is shown at a pixel.
  triangleIds: parameters.get('facets') === '2',
};
const trapName = parameters.get('trap');

// The trap name comes from the URL, so only the table's own entries count, never an inherited method such as toString.
function trapBuilder() {
  if (!Object.hasOwn(TRAPS, trapName)) throw new Error(`Unknown trap ${trapName}. Use one of: ${Object.keys(TRAPS).join(', ')}.`);
  return TRAPS[trapName];
}
const camera = { pivot: [0, 0, 0], yaw: 0.8, pitch: -0.5, distance: 10 };
let mode = 'orbit';
let glbBytes = null;
let assetName = '';
let renderer = null;
let bounds = null;
let extent = 1;
let dirty = true;
let lastProbe = null;
const keys = new Set();

function setStatus(kind, text) {
  status.className = `status ${kind}`;
  status.innerHTML = `${ICONS[kind]}<span></span>`;
  status.querySelector('span').textContent = text;
}

function viewDirection() {
  const cosPitch = Math.cos(camera.pitch);
  return [Math.sin(camera.yaw) * cosPitch, Math.sin(camera.pitch), -Math.cos(camera.yaw) * cosPitch];
}

function eyePosition() {
  const direction = viewDirection();
  return camera.pivot.map((value, axis) => value - direction[axis] * camera.distance);
}

function setCamera({ eye, target }) {
  const delta = vec3.sub(vec3.create(), target, eye);
  camera.distance = Math.max(vec3.length(delta), 0.01);
  vec3.normalize(delta, delta);
  camera.pitch = Math.asin(delta[1]);
  camera.yaw = Math.atan2(delta[0], -delta[2]);
  camera.pivot = [...target];
  markDirty();
}

function markDirty() {
  dirty = true;
  const context = overlay.getContext('2d');
  context.clearRect(0, 0, overlay.width, overlay.height);
}

function frameFor(jitterPixels = 0) {
  const frame = { eye: eyePosition(), target: camera.pivot, up: [0, 1, 0], fov: FIELD_OF_VIEW, far: Math.max(extent * 2.5, 100, camera.distance * 2 + extent) };
  if (!options.nearFit) frame.near = 0.1;
  if (jitterPixels) frame.shift = [jitterPixels / canvas.width, 0];
  return frame;
}

// A trap scene (traps.js) brings its own colour per face and its own camera.
async function loadScene() {
  if (!trapName) {
    const loaded = await parseGltf(glbBytes.slice(0));
    if (options.ids) paintPartsByOwner(loaded.parts);
    if (options.facets) paintTrianglesApart(loaded.parts);
    if (!options.shadows) for (const part of loaded.parts) Object.assign(part, { castShadow: false, receiveShadow: false });
    return loaded;
  }
  const buildTrap = trapBuilder();
  options.ids = true;
  return buildTrap();
}

// What the flush pass did to the scene: how long it took, what it could not settle and how much it cut.
let flushReport = null;
function resolveAndReport(parts) {
  const started = performance.now();
  const resolved = resolveFlushParts(parts);
  const cutParts = parts.filter(part => flushOrderOf(part)?.geometry);
  const count = (geometry, field, size) => geometry[field].length / size;
  flushReport = {
    milliseconds: Math.round(performance.now() - started),
    ranked: resolved.ranked,
    leftovers: resolved.leftovers,
    cutParts: cutParts.length,
    trianglesBefore: cutParts.reduce((sum, part) => sum + count(part.geometry, 'indices', 3), 0),
    trianglesAfter: cutParts.reduce((sum, part) => sum + count(flushOrderOf(part).geometry, 'indices', 3), 0),
    verticesAdded: cutParts.reduce((sum, part) => sum + count(flushOrderOf(part).geometry, 'positions', 3) - count(part.geometry, 'positions', 3), 0),
  };
  return resolved;
}

async function build() {
  if (!glbBytes && !trapName) return;
  setStatus('wait', 'Building the scene');
  renderer?.dispose();
  renderer = null;
  const loaded = await loadScene();
  bounds = measureBounds(loaded.parts);
  const size = bounds.maximum.map((value, axis) => value - bounds.minimum[axis]);
  extent = Math.max(...size);
  renderer = new Renderer67(canvas, loaded.parts, {
    ground: false, hdr: !options.triangleIds, samples: 4, pixelRatio: Math.min(devicePixelRatio, 1.5), memoryBudgetMiB: 1024,
    reversedDepth: options.reversed ? 'auto' : false,
    resolveCoplanar: options.offset ? resolveAndReport : false,
  });
  window.flickerRenderer = renderer;
  window.flickerParts = loaded.parts;
  document.querySelector('#drop').hidden = true;
  setStatus('ok', `${assetName} loaded`);
  markDirty();
}

function nearAndFar() {
  const matrix = renderer.projection;
  const near = matrix[14] / (matrix[10] - 1);
  const far = matrix[14] / (matrix[10] + 1);
  return { near, far };
}

function depthModeLabel() {
  if (!renderer) return 'none';
  return renderer.reversedDepth ? 'reversed-Z, 32-bit float' : '24-bit, standard';
}

function updateReadout() {
  if (!renderer) return;
  const { near, far } = nearAndFar();
  const lines = [
    `depth   ${depthModeLabel()}`,
    `near    ${near.toFixed(3)} m   far ${far.toFixed(0)} m`,
    `ratio   ${(far / near).toFixed(0)}:1`,
    `speed   ${speed().toFixed(1)} m/s`,
  ];
  if (lastProbe) lines.push(`probe   ${lastProbe.changed} px flicker, ${lastProbe.totalChanged} px moved`);
  readout.textContent = lines.join('\n');
}

function speed() {
  return 10 ** Number(document.querySelector('#speed').value) * Math.max(extent / 200, 0.05);
}

function readFrame(context) {
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

// Two frames with a sub-pixel jitter, drawn with one flat colour per part. A pixel is flicker when its owner changes while the first
// frame is the same colour on all four sides of it: a silhouette moves by the jitter at its own edge, which that test leaves out.
// `totalChanged` counts every pixel whose owner changed, edges included. `clearOfEdges` is stricter than `changed`: an anti-aliased
// edge blends two owners into a colour that is close to both, which the four-neighbour test reads as no edge, so this count also
// leaves out pixels with a colour step anywhere within two pixels.
// The bytes an unlit face of this colour shows: the triangle number that painted it, back from the gamma curve.
const shownByte = colour => colour.map(channel => Math.round(255 * channel ** (1 / DISPLAY_GAMMA)));

// The ground-truth probe (ground-truth.js): one frame, compared with a float64 ray cast that cannot z-fight. Needs flat colours
// per part (ids=1) or per triangle (facets=1); the trap scenes bring their own. Returns the counts of compareWithGroundTruth
// and the milliseconds the ray cast took.
async function truth() {
  if (!renderer) return null;
  const { width, height } = canvas;
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const context = scratch.getContext('2d', { willReadFrequently: true });
  renderer.render(frameFor(0));
  const pixels = new Uint8ClampedArray(readFrame(context));
  const started = performance.now();
  const world = collectWorldTriangles(window.flickerParts, flushOrderOf);
  const cast = castPixelOwners(world, frameFor(0), width, height);
  const { mismatchMask, ...counts } = compareWithGroundTruth({ pixels, world, cast, width, height, exact: options.triangleIds ? shownByte : null });
  renderer.render(frameFor(0));
  return { ...counts, triangles: world.count, castMilliseconds: Math.round(performance.now() - started), width, height };
}

// The triangles of another colour key that lie under the centre of triangle `target` within a decimetre of its plane, as
// `{ triangle, offset, rank, key, facing }` with `offset` how far the target stands in front of it along the target's normal.
function trianglesBehind(world, target) {
  const corners = world.corners;
  const point = index => [corners[index * 9], corners[index * 9 + 1], corners[index * 9 + 2]];
  const centre = [0, 1, 2].map(axis => (corners[target * 9 + axis] + corners[target * 9 + 3 + axis] + corners[target * 9 + 6 + axis]) / 3);
  const edgeOne = [0, 1, 2].map(axis => corners[target * 9 + 3 + axis] - point(target)[axis]);
  const edgeTwo = [0, 1, 2].map(axis => corners[target * 9 + 6 + axis] - point(target)[axis]);
  const normal = [edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1], edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2], edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]];
  const length = Math.hypot(...normal);
  const unit = normal.map(value => value / length);
  const found = [];
  for (let other = 0; other < world.count; other++) {
    if (other === target || world.keyOf[other] === world.keyOf[target]) continue;
    const first = point(other);
    const second = [0, 1, 2].map(axis => corners[other * 9 + 3 + axis]);
    const third = [0, 1, 2].map(axis => corners[other * 9 + 6 + axis]);
    const side = [0, 1, 2].map(axis => second[axis] - first[axis]);
    const back = [0, 1, 2].map(axis => third[axis] - first[axis]);
    const otherNormal = [side[1] * back[2] - side[2] * back[1], side[2] * back[0] - side[0] * back[2], side[0] * back[1] - side[1] * back[0]];
    const otherLength = Math.hypot(...otherNormal);
    const alignment = (otherNormal[0] * unit[0] + otherNormal[1] * unit[1] + otherNormal[2] * unit[2]) / otherLength;
    if (Math.abs(alignment) < 0.99) continue;
    const offset = unit.reduce((sum, value, axis) => sum + value * (first[axis] - centre[axis]), 0);
    if (Math.abs(offset) > 0.1) continue;
    const projected = centre.map((value, axis) => value + unit[axis] * offset);
    const signs = [[first, second], [second, third], [third, first]].map(([from, to]) => {
      const edge = to.map((value, axis) => value - from[axis]);
      const toPoint = projected.map((value, axis) => value - from[axis]);
      const turn = [edge[1] * toPoint[2] - edge[2] * toPoint[1], edge[2] * toPoint[0] - edge[0] * toPoint[2], edge[0] * toPoint[1] - edge[1] * toPoint[0]];
      return turn[0] * otherNormal[0] + turn[1] * otherNormal[1] + turn[2] * otherNormal[2];
    });
    if (signs.every(sign => sign >= 0)) found.push({ triangle: other, offset: -offset, rank: world.ranks[other], key: world.keyOf[other], facing: alignment > 0 ? 'same' : 'opposite' });
  }
  return found.slice(0, 6);
}

// The swapped pixels of the current frame grouped by the triangle that should be visible there: its part, rank and corners in
// world space, the pixel count and the median distance. Lists the 'limit' largest groups; this is how a swap is traced to a face.
function swapDetails(limit = 12) {
  const { width, height } = canvas;
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const context = scratch.getContext('2d', { willReadFrequently: true });
  renderer.render(frameFor(0));
  const pixels = new Uint8ClampedArray(readFrame(context));
  const world = collectWorldTriangles(window.flickerParts, flushOrderOf);
  const cast = castPixelOwners(world, frameFor(0), width, height);
  const { mismatchMask } = compareWithGroundTruth({ pixels, world, cast, width, height, exact: options.triangleIds ? shownByte : null });
  const groups = new Map();
  for (let pixel = 0; pixel < mismatchMask.length; pixel++) {
    if (mismatchMask[pixel] !== 2) continue;
    const group = groups.get(cast.owner[pixel]) ?? { triangle: cast.owner[pixel], pixels: 0, distances: [], sample: pixel };
    group.pixels++;
    const neighbours = [-1, 1, -width, width, -width - 1, -width + 1, width - 1, width + 1];
    if (neighbours.some(step => cast.owner[pixel + step] !== cast.owner[pixel])) group.onTriangleEdge = (group.onTriangleEdge ?? 0) + 1;
    group.distances.push(cast.distance[pixel]);
    groups.set(cast.owner[pixel], group);
  }
  renderer.render(frameFor(0));
  return [...groups.values()].sort((first, second) => second.pixels - first.pixels).slice(0, limit).map(group => ({
    triangle: group.triangle, pixels: group.pixels, onTriangleEdge: group.onTriangleEdge ?? 0, rank: world.ranks[group.triangle], key: world.keyOf[group.triangle],
    behind: trianglesBehind(world, group.triangle),
    distance: group.distances.sort((first, second) => first - second)[group.distances.length >> 1],
    corners: Array.from(world.corners.subarray(group.triangle * 9, group.triangle * 9 + 9)),
    sample: {
      x: group.sample % width, y: Math.floor(group.sample / width),
      drawnColour: [...pixels.subarray(group.sample * 4, group.sample * 4 + 3)],
      hits: Array.from({ length: cast.hitsPerPixel }, (_, slot) => cast.hitTriangles[group.sample * cast.hitsPerPixel + slot]).filter(triangle => triangle >= 0)
        .map((triangle, slot) => ({ triangle, distance: cast.hitDistances[group.sample * cast.hitsPerPixel + slot], rank: world.ranks[triangle], colour: world.keyColours[world.keyOf[triangle]] })),
    },
  }));
}

async function probe() {
  if (!renderer) return null;
  if (!options.ids) {
    options.ids = true;
    document.querySelector('[data-toggle="ids"]').setAttribute('aria-pressed', 'true');
    await build();
  }
  const { width, height } = canvas;
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const context = scratch.getContext('2d', { willReadFrequently: true });
  renderer.render(frameFor(0));
  const first = new Uint8ClampedArray(readFrame(context));
  renderer.render(frameFor(JITTER_PIXELS));
  const second = readFrame(context);
  overlay.width = width;
  overlay.height = height;
  const paint = overlay.getContext('2d');
  const image = paint.createImageData(width, height);
  let changed = 0;
  let totalChanged = 0;
  let clearOfEdges = 0;
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const index = (y * width + x) * 4;
      if (colourDistance(first, second, index) <= CHANGE_THRESHOLD) continue;
      totalChanged++;
      if (hasEdgeAround(first, width, index)) continue;
      changed++;
      if (!hasEdgeNearby(first, width, index)) clearOfEdges++;
      image.data.set([255, 0, 255, 255], index);
    }
  }
  paint.putImageData(image, 0, 0);
  renderer.render(frameFor(0));
  lastProbe = { changed, clearOfEdges, totalChanged, total: width * height, fraction: changed / (width * height), width, height };
  if (trapName && trapBuilder()().countOpen) lastProbe.open = countOpenPixels(first, width, height);
  setStatus(changed === 0 ? 'ok' : 'bad', changed === 0 ? 'No flicker in this view' : `${changed} pixels flicker`);
  updateReadout();
  return lastProbe;
}

// Pixels that let the backdrop through a seam: a channel is brighter or darker than in all eight pixels around it. A face is
// lit smoothly and an anti-aliased edge lies between the colours on its two sides, so neither stands out like that.
function countOpenPixels(data, width, height) {
  let open = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = (y * width + x) * 4;
      const neighbours = [-1, 0, 1].flatMap(row => [-1, 0, 1].map(column => index + (row * width + column) * 4)).filter(neighbour => neighbour !== index);
      const standsOut = [0, 1, 2].some(channel => {
        const values = neighbours.map(neighbour => data[neighbour + channel]);
        return data[index + channel] > Math.max(...values) + OPEN_THRESHOLD || data[index + channel] < Math.min(...values) - OPEN_THRESHOLD;
      });
      if (standsOut) open++;
    }
  }
  return open;
}

function colourDistance(a, b, index, otherIndex = index) {
  return Math.max(Math.abs(a[index] - b[otherIndex]), Math.abs(a[index + 1] - b[otherIndex + 1]), Math.abs(a[index + 2] - b[otherIndex + 2]));
}

function hasEdgeAround(data, width, index) {
  const neighbours = [index - 4, index + 4, index - width * 4, index + width * 4];
  return neighbours.some(neighbour => colourDistance(data, data, index, neighbour) > EDGE_THRESHOLD);
}

// Whether the first frame has a colour step between any two of the pixels up to two away on a row or a column through this one.
function hasEdgeNearby(data, width, index) {
  for (const step of [4, width * 4]) {
    const line = [index - 2 * step, index - step, index, index + step, index + 2 * step];
    for (let first = 0; first < line.length; first++) {
      for (let second = first + 1; second < line.length; second++) {
        if (colourDistance(data, data, line[first], line[second]) > EDGE_THRESHOLD) return true;
      }
    }
  }
  return false;
}

function tick(timestamp) {
  requestAnimationFrame(tick);
  const seconds = Math.min((timestamp - (tick.last ?? timestamp)) / 1000, 0.1);
  tick.last = timestamp;
  if (keys.size && moveWithKeys(seconds)) dirty = true;
  if (!renderer || !dirty) return;
  dirty = false;
  renderer.render(frameFor(0));
  updateReadout();
}

function moveWithKeys(seconds) {
  const direction = viewDirection();
  const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), direction, [0, 1, 0]));
  const step = speed() * seconds * (keys.has('shift') ? 4 : 1);
  const move = [0, 0, 0];
  const add = (vector, scale) => vec3.scaleAndAdd(move, move, vector, scale);
  if (keys.has('w')) add(direction, 1);
  if (keys.has('s')) add(direction, -1);
  if (keys.has('d')) add(right, 1);
  if (keys.has('a')) add(right, -1);
  if (keys.has('e')) add([0, 1, 0], 1);
  if (keys.has('q')) add([0, 1, 0], -1);
  if (!vec3.length(move)) return false;
  camera.pivot = camera.pivot.map((value, axis) => value + move[axis] * step);
  markDirty();
  return true;
}

function bindControls() {
  let drag = null;
  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, pan: event.button === 2 || event.shiftKey };
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.pan) {
      const direction = viewDirection();
      const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), direction, [0, 1, 0]));
      const scale = camera.distance * 0.0015;
      camera.pivot = camera.pivot.map((value, axis) => value - right[axis] * dx * scale + (axis === 1 ? dy * scale : 0));
    } else {
      const eye = eyePosition();
      camera.yaw -= dx * 0.005;
      camera.pitch = Math.max(-1.5, Math.min(1.5, camera.pitch + dy * 0.005 * (mode === 'fly' ? 1 : -1)));
      if (mode === 'fly') {
        const direction = viewDirection();
        camera.pivot = eye.map((value, axis) => value + direction[axis] * camera.distance);
      }
    }
    markDirty();
  });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    camera.distance = Math.max(0.05, camera.distance * Math.exp(event.deltaY * 0.001));
    markDirty();
  }, { passive: false });
  window.addEventListener('keydown', (event) => { keys.add(event.key.toLowerCase()); });
  window.addEventListener('keyup', (event) => { keys.delete(event.key.toLowerCase()); });
  window.addEventListener('blur', () => keys.clear());
  window.addEventListener('resize', () => { renderer?.resize(); markDirty(); });
  document.querySelector('#speed').addEventListener('input', () => { updateReadout(); });
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.addEventListener('click', () => {
      mode = button.dataset.mode;
      for (const other of document.querySelectorAll('[data-mode]')) other.setAttribute('aria-pressed', String(other === button));
    });
  }
  for (const button of document.querySelectorAll('[data-toggle]')) {
    button.setAttribute('aria-pressed', String(options[button.dataset.toggle]));
    button.addEventListener('click', async () => {
      options[button.dataset.toggle] = !options[button.dataset.toggle];
      button.setAttribute('aria-pressed', String(options[button.dataset.toggle]));
      lastProbe = null;
      if (button.dataset.toggle === 'nearFit') markDirty();
      else await build();
    });
  }
  document.querySelector('#probe').addEventListener('click', probe);
  document.querySelector('#clear').addEventListener('click', () => { lastProbe = null; markDirty(); });
  window.addEventListener('dragover', event => event.preventDefault());
  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!file) return;
    glbBytes = await file.arrayBuffer();
    assetName = file.name;
    await build();
    frameWholeScene();
  });
}

function frameWholeScene() {
  if (!bounds) return;
  camera.pivot = bounds.minimum.map((value, axis) => (value + bounds.maximum[axis]) / 2);
  camera.distance = extent * 0.9;
  camera.yaw = 0.8;
  camera.pitch = -0.55;
  markDirty();
}

async function loadFromUrl(url) {
  setStatus('wait', 'Downloading the asset');
  // The URL comes from the query string, so only a path on this dev server is fetched, never another host.
  const resolved = new URL(url, location.href);
  if (resolved.origin !== location.origin) throw new Error(`The asset must be a path on this server, such as /@local/<folder>/<file>.glb. Got ${url}.`);
  const response = await fetch(`${resolved.pathname}${resolved.search}`);
  if (!response.ok) throw new Error(`The server answered ${response.status} for ${url}. Allow the folder with VITE_FS_ALLOW.`);
  glbBytes = await response.arrayBuffer();
  assetName = decodeURIComponent(url.split('/').pop());
  await build();
  frameWholeScene();
}

async function loadTrap() {
  assetName = trapName;
  await build();
  setCamera(trapBuilder()());
}

bindControls();
requestAnimationFrame(tick);
document.querySelector('#speedValue').textContent = '';
window.flicker = {
  setCamera, probe, truth, swapDetails, build, options, frameWholeScene,
  get info() { return { depthMode: depthModeLabel(), ...(renderer ? nearAndFar() : {}), extent, bounds, canvas: [canvas.width, canvas.height], memory: renderer?.memoryReport?.(), flush: flushReport }; },
  render: () => { markDirty(); renderer?.render(frameFor(0)); },
  traps: Object.keys(TRAPS),
  ready: trapName ? loadTrap().catch(error => setStatus('bad', error.message)) : parameters.get('asset')
    ? loadFromUrl(parameters.get('asset')).catch(error => setStatus('bad', error.message))
    : Promise.resolve(),
};
