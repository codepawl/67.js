import { invalidField } from './field-error.js';
import { createCrowd } from './retarget.js';
import { bakeCrowdPalette, createCrowdParts, createCrowdRig } from './crowd-skinning.js';
import { jsonMaterial, materialOutput, registerCrowdModule } from './agent-scene-assets.js';

// Recipe crowd field: an asset placement with a `crowd` field turns one catalog character and one of its clips into
// `count` walking instances that share a few instanced batches (src/crowd-skinning.js). The result travels the
// placed-asset channel of agent-scene.js: generated geometries (type "asset"), materials (assetSource) and part nodes
// (assetPart), so exports and edits already skip them. The pose of every instance is a pure function of the scene
// time, the seed and the recipe camera, so a seek equals playing.

export const CROWD_LIMITS = Object.freeze({ maxInstances: 1000, maxCachedCrowds: 4 });
const CROWD_FIELDS = ['clip', 'count', 'seed', 'layout', 'spacing', 'columns', 'size', 'rateJitter', 'randomYaw', 'speed', 'frameRate', 'morphs', 'lods', 'farDistance', 'farRate'];

function numberWithin(value, minimum, maximum, label) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidField(`crowd.${label}`, value, `a number from ${minimum} to ${maximum}, such as ${Math.min(Math.max(1, minimum), maximum)}`);
  }
  return value;
}

/** Validate the `crowd` field of an asset placement. Returns the canonical form kept in the recipe. */
export function normalizeCrowd(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidField('crowd', value, 'an object such as { "count": 50, "layout": "grid" }', TypeError);
  for (const key of Object.keys(value)) {
    if (!CROWD_FIELDS.includes(key)) throw invalidField(`crowd.${key}`, value[key], `a known field, one of ${CROWD_FIELDS.join(', ')}`, TypeError);
  }
  if (!Number.isInteger(value.count) || value.count < 1 || value.count > CROWD_LIMITS.maxInstances) {
    throw invalidField('crowd.count', value.count, `an integer from 1 to ${CROWD_LIMITS.maxInstances}, such as 50`);
  }
  const layout = value.layout ?? 'grid';
  if (layout !== 'grid' && layout !== 'scatter') throw invalidField('crowd.layout', layout, 'one of grid or scatter');
  const clip = value.clip ?? 0;
  if (!Number.isInteger(clip) || clip < 0) throw invalidField('crowd.clip', clip, 'a clip index of 0 or more, such as 0');
  const result = {
    clip,
    count: value.count,
    seed: numberWithin(value.seed ?? 1, -2147483648, 2147483647, 'seed'),
    layout,
    spacing: numberWithin(value.spacing ?? 1.5, 0.05, 1000, 'spacing'),
    rateJitter: numberWithin(value.rateJitter ?? 0.15, 0, 0.9, 'rateJitter'),
    speed: numberWithin(value.speed ?? 1, 0.05, 16, 'speed'),
    frameRate: numberWithin(value.frameRate ?? 30, 4, 60, 'frameRate'),
  };
  if (value.columns !== undefined) result.columns = Math.round(numberWithin(value.columns, 1, CROWD_LIMITS.maxInstances, 'columns'));
  if (value.size !== undefined) result.size = numberWithin(value.size, 0.1, 100_000, 'size');
  for (const flag of ['randomYaw', 'morphs', 'lods']) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') throw invalidField(`crowd.${flag}`, value[flag], 'true or false', TypeError);
  }
  result.randomYaw = value.randomYaw ?? false;
  result.morphs = value.morphs ?? false;
  result.lods = value.lods ?? true;
  if ((value.farDistance === undefined) !== (value.farRate === undefined)) throw invalidField(value.farDistance === undefined ? 'crowd.farDistance' : 'crowd.farRate', undefined, 'both farDistance and farRate, or neither, such as { "farDistance": 40, "farRate": 8 }', TypeError);
  if (value.farDistance !== undefined) {
    result.farDistance = numberWithin(value.farDistance, 0.1, 100_000, 'farDistance');
    result.farRate = numberWithin(value.farRate, 1, 60, 'farRate');
  }
  return result;
}

function buildCrowd(asset, assetId, settings) {
  const source = asset.animations[settings.clip];
  const rig = createCrowdRig(asset.parts, { morphs: settings.morphs });
  const poseAt = seconds => asset.stagePose({ animation: { clip: settings.clip, time: seconds }, nodeOverrides: [] }).commit();
  const palette = bakeCrowdPalette(rig, poseAt, { duration: source.duration, frameRate: settings.frameRate });
  const crowd = createCrowd({
    count: settings.count, clip: { duration: source.duration, tracks: [] }, seed: settings.seed, layout: settings.layout,
    spacing: settings.spacing, columns: settings.columns, size: settings.size, rateJitter: settings.rateJitter, randomYaw: settings.randomYaw,
  });
  const farPose = settings.farDistance ? { distance: settings.farDistance, rate: settings.farRate } : null;
  const set = createCrowdParts({ rig, palette, instances: crowd.instances, lods: settings.lods, farPose, name: assetId.slice(0, 12) });
  const materialOutputs = rig.parts.map(rigPart => materialOutput(rigPart.material, {}));
  return { asset, rig, palette, crowd, set, materialOutputs, clipName: source.name ?? `clip ${settings.clip}`, duration: source.duration };
}

/**
 * Generate the geometries, materials and part nodes of one crowd placement into a normalized recipe, in place.
 * `cache` (the scene's asset output map) keeps the baked palette and the instance list across edits, so a camera or
 * unrelated edit does not bake again and the parts of the last stage stay reusable. `asset` is the decoded copy
 * reserved for this placement, which the bake poses. Returns the nodes to add and the placement record.
 */
export function expandCrowd(recipe, node, asset, copy, cache, runtime, limits) {
  const { id: assetId, crowd: settings } = node.asset;
  if (!asset.animations[settings.clip]) {
    throw invalidField(`nodes.${node.id}.asset.crowd.clip`, settings.clip, `a clip index from 0 to ${asset.animations.length - 1} (asset ${assetId.slice(0, 12)} has ${asset.animations.length} clips)`);
  }
  const key = `crowd:${node.id}:${assetId}:${copy}:${JSON.stringify(settings)}`;
  if (cache.get(key)?.asset !== asset) {
    const stale = [...cache.keys()].filter(candidate => candidate.startsWith('crowd:'));
    if (stale.length >= CROWD_LIMITS.maxCachedCrowds) cache.delete(stale[0]);
    try {
      cache.set(key, buildCrowd(asset, assetId, settings));
    } catch (error) {
      error.message = `Node ${node.id} crowd: ${error.message}`;
      throw error;
    }
  }
  const built = cache.get(key);
  const rigPartCount = built.rig.parts.length;
  if (recipe.nodes.length + settings.count * rigPartCount > limits.maxNodes) {
    throw invalidField(`nodes.${node.id}.asset.crowd.count`, settings.count, `a count whose part nodes (${rigPartCount} per instance) fit in maxNodes ${limits.maxNodes} beside the ${recipe.nodes.length} authored nodes, so at most ${Math.max(0, Math.floor((limits.maxNodes - recipe.nodes.length) / rigPartCount))}`);
  }
  const prefix = `crowd:${assetId.slice(0, 12)}:${copy}`;
  const materialIds = built.rig.parts.map((rigPart, index) => {
    const id = `${prefix}:${index}`;
    runtime.materialOutputs.set(id, built.materialOutputs[index]);
    recipe.materials.push({ id, ...jsonMaterial(rigPart.material), assetSource: true });
    runtime.geometryParts.set(id, rigPart.geometry);
    recipe.geometries.push({ id, type: 'asset', assetId, copy, part: index });
    return id;
  });
  const nodes = [];
  const partNodeIds = [];
  built.set.parts.forEach((part, index) => {
    const instance = Math.floor(index / rigPartCount);
    const rigIndex = index % rigPartCount;
    const id = `${node.id}/${instance}/${rigIndex}`;
    partNodeIds.push(id);
    nodes.push({
      id, parent: node.id, label: `${built.clipName} ${instance}`,
      translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      geometry: `${prefix}:${rigIndex}`, material: materialIds[rigIndex],
      assetPart: { placement: node.id, index: instance, matrix: Array.from(part.matrix) },
    });
    runtime.partExtras.set(id, { crowd: part.crowd, assembly: part.assembly, ...(part.lods ? { lods: part.lods } : {}), ...(part.morph ? { morph: part.morph } : {}) });
  });
  const eye = recipe.camera?.eye ?? null;
  const record = {
    node: node.id, assetId, copy, asset, partNodeIds, clip: null, drive: null, drivePose: null,
    crowd: {
      /** The pose at a scene time, applied on commit: only frame offsets change, so nothing here can fail. */
      stage(time) {
        const seconds = time * settings.speed;
        return {
          commit: () => built.set.setTimes(index => built.crowd.clipTime(index, seconds), eye),
          discard() {},
        };
      },
      describe() {
        return {
          node: node.id, assetId, kind: 'crowd', instances: settings.count, parts: partNodeIds.length,
          batches: rigPartCount, clip: { index: settings.clip, name: built.clipName, duration: built.duration },
          frames: built.palette.frameCount, paletteBytes: built.palette.data.byteLength, boundsRadius: built.palette.bounds.radius,
          lods: settings.lods, morphs: built.rig.parts.filter(part => part.morph).length,
          ...(settings.farDistance ? { farPose: { distance: settings.farDistance, rate: settings.farRate } } : {}),
        };
      },
    },
  };
  return { nodes, record };
}

registerCrowdModule({ normalizeCrowd, expandCrowd });
