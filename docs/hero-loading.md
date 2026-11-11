# How the home hero loads

The hero on the home page plays a flight over the Port showcase world. The world is 9.7 MB, so on a slow link the page loads a small copy first and replaces it with the full world when that has arrived.

## Order of the files

1. The poster image loads. Nothing else competes with it.
2. When the poster has settled (or after 5 s), `index.html` starts the first view: `scene.json`, `scene.first.glb` (about 2 MB) and `sky.preview.hdr` (256 by 128, 131 KB, a block average of the full `sky.hdr` at the same orientation; exposure, tone mapping, sun, fog and sky intensity come from the same `scene.json` for both, so only the sky's detail differs at the swap. Make it with `node scripts/downsample-hdr.mjs <sky.hdr> <sky.preview.hdr> 256 128`; the Fast 4G first frame budget keeps it under 150 KB).
3. When those have settled, it starts the full world: `scene.glb`, `scene.rest.glb` and `sky.hdr`.
4. `fetchWorld(url, { firstView: true })` in `src/hero-lab/loop/world.js` resolves as soon as the first view is in. It holds a `detail` promise for the full world.
5. The world is built from the first view and draws. `completeDetail` (`src/hero-lab/loop/detail.js`) then waits for `detail`, parses it and calls `world.upgrade(detail)`. The upgrade uploads the textures and the sky while the first view keeps drawing. Only the swap itself (the sky prefilter, one `replaceParts` and a prepared draw) holds the draws: about 140 ms on a desktop and a phone viewport (`swapHeldMs` of `scripts/measure-hero-load.mjs`, GPU shared with other jobs). Feeding `replaceParts` in slices was tried and doubled the hold (swap 0.8 s to 1.5 s) without shortening the longest gap between frames (about 110 ms either way).

A link faster than 20 Mbit/s (measured from the resource timing of the first view's own download) skips the first view and builds the full world straight away.

A first view that is missing, corrupt or fails to build is replaced by the full world (`fetchFirstViewFiles` in `world.js`, `buildWithFallback` in `detail.js`). A world that was never drawn, such as a page opened in a background tab, swaps without a prepared draw; its first real frame does that work.

A full world that fails to arrive or to build is asked for again after 4, 10 and 20 s; after that the first view stays. A world that is freed in the middle of a swap ends the swap quietly.

## The first view

`scripts/build-hero-first-view.mjs` builds `scene.first.glb` from `scene.glb` and `scene.rest.glb`:

- It samples 61 camera poses over the first 5 s of the flight and drops every triangle outside all of their frustums.
- It splits the rest into six distance bands (edges at 100, 170, 260, 400 and 650 m) and simplifies each band to a screen error of 3 px up to 400 m and 6 px beyond, locking the borders so the bands do not crack apart.
- Textures are 512 px for materials seen within 400 m and 128 px for the rest. Materials that are never seen are dropped.

The options (`--near-pixels`, `--far-pixels` and others) are read by `parseArguments` in the script. The geometry the first view lacks lies outside the first 5 s of the flight, so `src/hero-lab/loop/hold.js` slows the flight from 2.5 s while the full world is pending and stops it at 5 s, until the full world is in (or has been given up on). The cost is that on a very slow link the frame is almost still for most of the wait (at 1.6 Mbit/s the first view appears at about 14 s and the swap lands at about 64 s); the alternative is holes at the edges of the picture, and the page before this change showed nothing at all for that time.

## An animated world

The chip fab is the one world with an animation clip: engineers walk, hoist vehicles and pods ride the rails. `src/hero-lab/loop/world.js` plays the clip from the first frame the world draws, with its time modulo the clip length (`loopedClipTime`), so a world that stays on screen longer than the clip, because the next one is still building, keeps moving instead of stopping on the last pose. That only works for a clip whose last pose is its first. `node scripts/hero-clip-loop.mjs <in.glb> <out.glb> --walk-source <UAL1_Standard.glb> --walk-clip Walk_Loop --engineer-speed 0.83` turns the one-way clip into a 24 s patrol that goes out and back with a rounded turn, faces each engineer along its path and plays the Quaternius Walk_Loop (CC0) at the speed that keeps the planted foot still. `tests/hero-chipfab-animation.test.js` checks the loop seam, the facing, the step and the slide on the committed GLB.

## Measuring

```sh
npx vite build --outDir <folder>
node scripts/measure-hero-load.mjs --dist <folder> --label <name> --runs 3
node scripts/measure-hero-load.mjs --dist <folder> --stills <directory>
node scripts/measure-hero-load.mjs --dist <folder> --video <file.mp4>
```

It serves the folder with brotli and throttles through the DevTools protocol (Fast 4G, 1.6 Mbit/s with 150 ms round trip, unthrottled), on a desktop and a phone viewport. Network times do not depend on the GPU load; frame times do. `--stills` scores the first view against the full world at the same pose with PSNR.
