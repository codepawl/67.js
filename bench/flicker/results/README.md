# Flicker probe results

`traps-1280x720.json` is the ground-truth output of `node bench/flicker/probe.mjs --traps --viewport 1280x720 --assert` with
configs `reversed=1;reversed=0;reversed=1,offset=0;reversed=0,offset=0` (reversed-Z float depth and 24-bit depth, flush pass on and
off). It needs a GPU browser, so it is a local run, not part of CI; rerun it after a change to the flush pass or the depth path.
`--assert` exits 1 if any trap shows a swapped pixel with the flush pass on.
