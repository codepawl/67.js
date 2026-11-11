# Flicker probe results

`traps-1280x720.json` is the ground-truth output of `node bench/flicker/probe.mjs --traps --viewport 1280x720 --assert` with
configs `reversed=1;reversed=0;reversed=1,offset=0;reversed=0,offset=0` (reversed-Z float depth and 24-bit depth, flush pass on and
off). It needs a GPU browser, so it is a local run, not part of CI; rerun it after a change to the flush pass or the depth path.
`--assert` exits 1 if any trap shows a swapped pixel with the flush pass on.

`melbourne-drape-1280x720.json` is the exact ground truth (`facets=2`, see `probe.mjs`) of the Melbourne drape GLB at 12 camera
spots (roofs, bridge, river, overview and 8 glass spots), with the flush pass on and off (`offset=0`), reversed-Z float depth, shadows off.
Summed over the 12 spots: 8 true visibility flips (`flipped`) with the flush pass on against 109,522 with it off. The 8 are single
pixels on a triangle edge, where the ray cast and the rasteriser disagree about the pixel centre, not coplanar fights. `offRay` (pixels
showing a face the pixel-centre ray misses) is the rasteriser and the ray cast differing at edges and is not depth fighting. A render
pass (albedo, object ID) cannot stand in for this: its target has a 24-bit depth buffer, which fights far more than the beauty path.
