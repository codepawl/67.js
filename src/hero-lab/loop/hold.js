// How a world that is still on its first view flies. The first view only holds the geometry the first FIRST_VIEW_COVERS_SECONDS of the
// flight can see, so the camera slows from HOLD_FROM_SECONDS and waits at the edge of that range until the full world has arrived.
export const HOLD_FROM_SECONDS = 2.5;
export const HOLD_RATE = 0.25;
export const HOLD_RAMP_PER_SECOND = 1.5;
export const FIRST_VIEW_COVERS_SECONDS = 5;

// The speed (1 is normal) the flight should have: 1 when the detail is not pending, HOLD_RATE inside the range the first view covers,
// and 0 once the camera reaches the end of that range.
export function holdTargetRate(flightPosition, detailState) {
  if (detailState !== 'pending' || flightPosition < HOLD_FROM_SECONDS) return 1;
  return flightPosition >= FIRST_VIEW_COVERS_SECONDS ? 0 : HOLD_RATE;
}

// Moves entry.rate toward its target (at most HOLD_RAMP_PER_SECOND per second) and adds the time the flight lost to entry.held.
export function advanceHold(entry, seconds, flightPosition, detailState) {
  const target = holdTargetRate(flightPosition, detailState);
  const step = HOLD_RAMP_PER_SECOND * seconds;
  entry.rate += Math.max(-step, Math.min(step, target - entry.rate));
  entry.held += seconds * (1 - entry.rate);
}
