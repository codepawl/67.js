// The time inside a looping animation clip for a world that has been drawn for `seconds`. A clip that is only clamped stops on
// its last pose once the world stays on screen longer than the clip (a next world still building, a link that is slow), and every
// engineer and vehicle freezes. A clip made to loop (its last pose equals its first) is played with its time modulo its length.
export function loopedClipTime(seconds, clipDuration) {
  if (!(clipDuration > 0) || !Number.isFinite(seconds)) return 0;
  return seconds % clipDuration;
}
