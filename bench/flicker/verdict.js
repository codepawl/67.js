/**
 * Pass or fail for a probe run. With the flush pass on (the viewer's default, `offset` not 0) no trap may show a pixel with the
 * colour of a face behind the visible one. Runs with `offset=0` are the "before" numbers and are never judged.
 * `results` is the list `probe.mjs --traps` writes; the configuration label holds `offset0` when the flush pass was off.
 */
export function failingTraps(results) {
  return results
    .filter(result => !result.configuration.includes('offset0'))
    .filter(result => !result.truth || !Number.isFinite(result.truth.swapped) || result.truth.swapped > 0)
    .map(result => ({ trap: result.trap, configuration: result.configuration, swapped: result.truth ? result.truth.swapped : null }));
}
