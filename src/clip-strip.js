// A clip strip places a clip on the motion's timeline the way an animation editor's strip does: where it starts, how
// stretched and repeated it is, how it fades in and out, and what it does before and after. The compiled strip is two
// pure functions of time, so a seek equals playing.

export const STRIP_EXTENDS = Object.freeze(['nothing', 'hold', 'holdForward']);
export const STRIP_BLENDS = Object.freeze(['replace', 'add']);

/** The seconds a normalized strip covers: the clip length stretched by `scale` and repeated `repeat` times. */
export function stripLength(strip, clipDuration) {
  return clipDuration * strip.scale * strip.repeat;
}

function ramp(distance, blend) {
  return blend > 0 ? Math.min(1, Math.max(0, distance / blend)) : 1;
}

/**
 * `strip`: `{ start, scale, repeat, blendIn, blendOut, extend }`, already validated. Returns `weight(time)`, the fade
 * envelope from 0 to 1, and `clipTime(time)`, the time inside the clip. Each repeat plays the clip from 0 to its
 * duration; the end of a cycle reads the clip's last pose, the start of the next reads its first.
 */
export function compileClipStrip(strip, clipDuration) {
  const length = stripLength(strip, clipDuration);
  const end = strip.start + length;
  const playedSpan = clipDuration * strip.repeat;

  function weight(time) {
    if (time < strip.start) return strip.extend === 'hold' ? ramp(0, strip.blendIn) : 0;
    if (time > end) return strip.extend === 'nothing' ? 0 : ramp(0, strip.blendOut);
    return Math.min(ramp(time - strip.start, strip.blendIn), ramp(end - time, strip.blendOut));
  }

  function clipTime(time) {
    const played = Math.min(playedSpan, Math.max(0, (time - strip.start) / strip.scale));
    if (played === 0) return 0;
    return played - clipDuration * (Math.ceil(played / clipDuration) - 1);
  }

  return { weight, clipTime, end };
}
