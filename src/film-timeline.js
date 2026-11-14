// A recipe timeline: shots played one after another over the recipe's motion clock. Plain data and plain functions with
// no engine imports, so the MCP server (render jobs) and the scene (recipe validation) share one definition.
// Not a video sequence editor: no layers, no overlaps and no clip trimming. Shots cut, or dip through black.

export const FILM_TIMELINE_LIMITS = Object.freeze({
  maxShots: 64, maxTotalSeconds: 60, minShotSeconds: 0.1, maxShotSeconds: 30, maxDipSeconds: 4, maxMotionStart: 3600,
});

const SHOT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,24}$/;
// A running sum of shot lengths can overshoot the motion by float rounding, as agent-motion-bake.js allows.
const MOTION_END_TOLERANCE = 1e-9;
const SHOT_FIELDS = ['name', 'duration', 'motionStart', 'camera', 'dip', 'focusDistance', 'blur'];
const MAX_FOCUS_DISTANCE = 100000;

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object.`);
  }
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label} has unsupported field ${JSON.stringify(key.slice(0, 48))}.`);
  }
}

function numberBetween(value, minimum, maximum, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a number from ${minimum} to ${maximum}.`);
  }
  return value;
}

function hasAnimatedScene(recipe) {
  return Boolean(recipe?.motion || recipe?.physics || recipe?.cloth || recipe?.environment?.localVolumes?.some(volume => volume?.frames));
}

/**
 * Validates and copies a timeline against its recipe. `checkCamera(cameraOverrides)` lets the caller reject camera
 * fields with the engine's own rules and return the cleaned copy; without it the camera is only checked for shape.
 */
export function normalizeFilmTimeline(timeline, recipe, { checkCamera } = {}) {
  plainObject(timeline, 'timeline');
  rejectUnknownKeys(timeline, ['shots'], 'timeline');
  const { shots } = timeline;
  if (!Array.isArray(shots) || shots.length < 1 || shots.length > FILM_TIMELINE_LIMITS.maxShots) {
    throw new RangeError(`timeline.shots must list 1 to ${FILM_TIMELINE_LIMITS.maxShots} shots.`);
  }
  const animated = hasAnimatedScene(recipe);
  const seenNames = new Set();
  let startSeconds = 0;
  const normalized = shots.map((shot, index) => {
    plainObject(shot, `Shot ${index}`);
    rejectUnknownKeys(shot, SHOT_FIELDS, `Shot ${index}`);
    if (typeof shot.name !== 'string' || !SHOT_NAME_PATTERN.test(shot.name)) {
      throw new TypeError(`Shot ${index} name must be 1 to 24 letters, digits, - or _.`);
    }
    if (seenNames.has(shot.name)) throw new RangeError(`Shot name ${shot.name} is used twice.`);
    seenNames.add(shot.name);
    const duration = numberBetween(shot.duration, FILM_TIMELINE_LIMITS.minShotSeconds, FILM_TIMELINE_LIMITS.maxShotSeconds, `Shot ${shot.name} duration`);
    const result = { name: shot.name, duration };
    if (shot.motionStart !== undefined) {
      if (!animated) throw new RangeError(`Shot ${shot.name} sets motionStart but the recipe has no motion, physics or cloth.`);
      result.motionStart = numberBetween(shot.motionStart, 0, FILM_TIMELINE_LIMITS.maxMotionStart, `Shot ${shot.name} motionStart`);
    }
    if (animated && recipe.motion && !recipe.motion.loop) {
      const motionStart = result.motionStart ?? startSeconds;
      if (motionStart + duration > recipe.motion.duration + MOTION_END_TOLERANCE) {
        throw new RangeError(`Shot ${shot.name} reads motion up to ${motionStart + duration} s but the motion lasts ${recipe.motion.duration} s. Set motionStart, or make the motion loop.`);
      }
    }
    if (shot.dip !== undefined) {
      result.dip = numberBetween(shot.dip, 0.05, FILM_TIMELINE_LIMITS.maxDipSeconds, `Shot ${shot.name} dip`);
      const previousDuration = index === 0 ? Infinity : shots[index - 1].duration;
      if (result.dip / 2 > duration || result.dip / 2 > previousDuration) {
        throw new RangeError(`Shot ${shot.name} dip is longer than twice the shots on either side of the cut.`);
      }
    }
    if (shot.camera !== undefined) {
      plainObject(shot.camera, `Shot ${shot.name} camera`);
      result.camera = checkCamera ? checkCamera(shot.camera) : { ...shot.camera };
    }
    if (shot.focusDistance !== undefined) {
      result.focusDistance = numberBetween(shot.focusDistance, 0.01, MAX_FOCUS_DISTANCE, `Shot ${shot.name} focusDistance`);
    }
    if (shot.blur !== undefined) {
      result.blur = numberBetween(shot.blur, 0, 1, `Shot ${shot.name} blur`);
    }
    startSeconds += duration;
    return result;
  });
  if (startSeconds > FILM_TIMELINE_LIMITS.maxTotalSeconds) {
    throw new RangeError(`The timeline lasts ${startSeconds} s; the most is ${FILM_TIMELINE_LIMITS.maxTotalSeconds} s.`);
  }
  return { shots: normalized };
}

export function filmTimelineDuration(timeline) {
  let total = 0;
  for (const shot of timeline.shots) total += shot.duration;
  return total;
}

/** Shots with their start times, summed in order so the same time always lands in the same shot. */
export function filmTimelineShotStarts(timeline) {
  let startSeconds = 0;
  return timeline.shots.map(shot => {
    const entry = { name: shot.name, start: startSeconds, duration: shot.duration };
    startSeconds += shot.duration;
    return entry;
  });
}

function brightnessAt(timeline, starts, index, shotTime) {
  let brightness = 1;
  const shot = timeline.shots[index];
  if (shot.dip !== undefined) brightness = Math.min(brightness, shotTime / (shot.dip / 2));
  const next = timeline.shots[index + 1];
  if (next?.dip !== undefined) {
    const remaining = starts[index].duration - shotTime;
    brightness = Math.min(brightness, remaining / (next.dip / 2));
  }
  return Math.max(0, Math.min(1, brightness));
}

function depthOfFieldOverrides(shot) {
  const overrides = {};
  if (shot.focusDistance !== undefined) overrides.focusDistance = shot.focusDistance;
  if (shot.blur !== undefined) overrides.blur = shot.blur;
  return Object.keys(overrides).length > 0 ? overrides : null;
}

/**
 * Everything one frame needs at timeline time `time`: the shot, the motion clock (null for a static recipe), the
 * camera overrides, the depth of field overrides (null keeps the recipe's) and the brightness of a dip through black. It keeps no state, so any seek gives the same answer.
 */
export function sampleFilmTimeline(timeline, recipe, time) {
  const starts = filmTimelineShotStarts(timeline);
  const total = filmTimelineDuration(timeline);
  if (!Number.isFinite(time) || time < 0 || time > total) {
    throw new RangeError(`Timeline time ${time} is outside 0 to ${total} s.`);
  }
  let index = starts.length - 1;
  for (let candidate = 0; candidate < starts.length; candidate++) {
    if (time < starts[candidate].start + starts[candidate].duration) {
      index = candidate;
      break;
    }
  }
  const shot = timeline.shots[index];
  const shotTime = time - starts[index].start;
  const motionTime = hasAnimatedScene(recipe) ? (shot.motionStart ?? starts[index].start) + shotTime : null;
  return {
    shotIndex: index, shotName: shot.name, shotTime, motionTime,
    camera: shot.camera ?? null, depthOfField: depthOfFieldOverrides(shot), brightness: brightnessAt(timeline, starts, index, shotTime),
  };
}
