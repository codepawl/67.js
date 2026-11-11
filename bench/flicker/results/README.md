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

`melbourne-drape-offray-1280x720.json` is the same exact run with `offRay` taken apart, at `hits=6` and `hits=32` (hits kept per ray in the
ray cast) with the flush pass on, and `hits=6` with it off. Summed over the 12 spots, flush pass on: `offRay` is 18,590 at both hit
counts, so no pixel hides in a stack deeper than 6 faces. It is not edge-only: 363 touch an owner change of the cast in their 3x3
neighbourhood (`offRayEdge`), 18,227 do not (`offRayInterior`). But the colour shown there is within 16 bytes of the colour expected
for 18,367 of the 18,590 (`offRayNearColour` 8,261 within 2, `offRaySmallGap` 10,106 within 3 to 16): consecutive triangle numbers are
consecutive colours, so a rounding step of the frame names an unrelated triangle. Only 215 interior pixels are further off
(`offRayUnexplained`), so the true flips are at most `flipUpperBound` = 8 + 215 = 223 of 5.9 million contested pixels. With the
flush pass off the same bound is 129,361. Reproduce with `probe.mjs --configs "reversed=1,facets=2,shadows=0,hits=6;reversed=1,facets=2,shadows=0,hits=32;reversed=1,facets=2,shadows=0,offset=0,hits=6"`.

`melbourne-drape-single-sample-1280x720.json` is the same 12 spots with 4 samples (`samples=4`) and with 1 sample (the default of `facets=2`
since #751), flush pass on, and 1 sample with the pass off (`offset=0`). The 18,590 `offRay` pixels of the 4-sample frame were the MSAA
resolve: a pixel shared by two faces resolves to the average of their ids, and ids of neighbouring triangles are neighbouring numbers, so
the average names a third, valid triangle (a pixel that the ray through its centre cannot match). `viewer.js` `colourStepDetails()` shows
it: the wrong pixels differ from the expected id in one or two channels, never three, by a few bytes, in runs along thin faces. With
1 sample the same frames hold 8 wrong pixels in 5.9 million contested ones, no swapped pixel and no true flip (`flipUpperBound` 1); the
8 "true flips" of the 4-sample frame were blends too. With the flush pass off the 1-sample frame still shows 119,404 flipped pixels, so the
probe still sees fighting. Reproduce with `probe.mjs --configs "reversed=1,facets=2,shadows=0,samples=4;reversed=1,facets=2,shadows=0;reversed=1,facets=2,shadows=0,offset=0"`.

`effects-melbourne-drape-1280x720.json` is `effects-probe.mjs` on the Melbourne drape at the same 12 spots (per-part colours, `ids=1`, shadows
off, reversed-Z float, 4 samples, D3D11): AO, line art and DOF through the stacked scene with the flush pass on, against the same scene with the
pass off. `spurious` counts the pixels an effect changes where the plain frame has no colour edge within 2 px. On a real city AO and DOF
change many such pixels by design (real occlusion, a blur of a shaded gradient), so the absolute counts say nothing; the two sides are
the comparison. Summed over 12 spots, flush on / off: AO 2,066,622 / 2,052,039, DOF 822,357 / 824,561, line art 44,654 / 50,794.
