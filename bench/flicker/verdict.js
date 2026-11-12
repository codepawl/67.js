/**
 * Pass or fail for a probe run. With the flush pass on (the viewer's default, `offset` not 0) no trap may show a pixel with the
 * colour of a face behind the visible one. Runs with `offset=0` are the "before" numbers and are never judged.
 * `results` is the list `probe.mjs --traps` writes; the configuration label holds `offset0` when the flush pass was off.
 * An exact run (`facets=2`) carries `flipped`, the true visibility flips: a face the flush pass deliberately lifts over a nearer one
 * is a `swapped` pixel but stable and not a flip, so the exact count is the one judged. Other runs are judged on `swapped`.
 */
export function failingTraps(results) {
  return results
    .filter(result => !result.configuration.includes('offset0'))
    .map(result => ({ result, judged: judgedCount(result.truth) }))
    .filter(({ judged }) => !Number.isFinite(judged) || judged > 0)
    .map(({ result, judged }) => ({ trap: result.trap, configuration: result.configuration, swapped: result.truth ? result.truth.swapped : null, ...(Number.isFinite(result.truth?.flipped) ? { flipped: judged } : {}) }));
}

function judgedCount(truth) {
  if (!truth) return NaN;
  return Number.isFinite(truth.flipped) ? truth.flipped : truth.swapped;
}
