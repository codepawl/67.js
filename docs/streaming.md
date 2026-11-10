# Streaming: load and free assets while a game plays

`67js/addons/streaming` is a [runtime](runtime.md) system. It loads assets when the player gets near or the game asks, keeps the bytes in use under a budget, frees low priority assets and swaps detail levels. It loads only when imported and adds no dependency. The GLB loader imports the glTF parser on first use.

```js
import { createRuntime } from '67js/addons/runtime';
import { createStreaming } from '67js/addons/streaming';

const streaming = createStreaming({
  budgetBytes: 256 * 1024 * 1024,
  focus: () => player.position,
  assets: [
    { id: 'town', format: 'glb', position: [0, 0, 0], loadDistance: 150,
      levels: [{ source: '/town-high.glb', estimatedBytes: 12e6, maximumDistance: 60 },
               { source: '/town-low.glb', estimatedBytes: 2e6 }] },
  ],
});
const runtime = createRuntime(renderer, { systems: [input, physics, streaming] });
```

## What decides a load

- **Distance.** An asset is wanted once the focus is within `loadDistance` of its `position`, and stays wanted until the focus is `loadDistance * (1 + hysteresis)` away.
- **Request.** `request(id)` wants an asset wherever the focus is, and `release(id)` lets it go. A requested asset is never evicted.
- Loads start in order of distance, nearest first, then by id. At most `maximumConcurrentLoads` (default 2, up to 16) run at once. The order is a function of the focus path only, so a scripted walk streams the same way every run.

## Memory budget

`budgetBytes` caps loaded bytes plus the `estimatedBytes` of loads in flight. Before a load starts, assets nobody wants are freed until it fits. The order is lowest `priority` first (a number from -100 to 100, default 0, set on the asset), then by `evictionOrder`: `"recency"` (the default, unchanged from before) frees the least recently used first and breaks ties by distance; `"distance"` frees the farthest from the focus first and breaks ties by recency. Last comes the id, so the same walk always frees the same assets. Reading an asset with `getAsset(id)` or keeping it wanted counts as a use. If nothing can be freed, the load waits and update tries again. When a loader reports more bytes than estimated, the system frees unwanted assets to get back under the budget. Wanted and requested assets are never freed, so a budget smaller than what the player needs shows as waiting loads in `stats`.

## Detail levels

`levels` runs from the finest to the coarsest. Each level except the last has a `maximumDistance`. A level coarsens once the distance passes its end by `hysteresis` (default 0.1, a fraction) and refines once the distance is short of the finer level's end by the same fraction, so a focus standing on a boundary does not reload back and forth. When the wanted level is loaded, the other levels of that asset are freed. Until then `getAsset` returns the level still resident, so nothing disappears. `selectDetailLevel(maximumDistances, distance, currentLevel, hysteresis)` is the same rule as a function.

## Loader plugins

```js
streaming.registerLoader('terrain-tile', {
  async load({ id, source, level, signal }) {
    const bytes = await (await fetch(source, { signal })).arrayBuffer();
    return { asset: decodeTile(bytes), bytes: bytes.byteLength };
  },
  dispose(asset) { asset.free(); },
});
```

A loader is `{ load(request), dispose(asset) }`. `load` returns `{ asset, bytes }` and gets an `AbortSignal` that fires when the system is disposed. The format name is lowercase letters, digits and hyphens, and each can be registered once (`createStreaming({ loaders: { 'terrain-tile': loader } })` does the same). `glb` is registered by default through `createGlbLoader({ options, fetchBytes })`; `options` go to `parseGltf`, so its limits and decoders apply. `createWorkerLoader({ createWorker, dispose })` decodes off the main thread: it starts a worker for each load, posts `{ id, format, source, level }`, expects `{ asset, bytes }` or `{ error }` back, fails the load when the worker throws, cannot clone the source or sends a reply that cannot be read, and terminates the worker when the load ends or the system is disposed, so workers never outnumber `maximumConcurrentLoads`. Splats, point clouds, audio and compressed textures are loaders of their own.

## Reading the state

`getState(id)` returns `{ state, level, bytes, failure }`, with `state` one of `idle`, `pending`, `loaded`, `evicted` or `failed`. A failed asset stays failed until `request(id)` retries it. `stats` has the count of each state plus `bytesInUse`, `budgetBytes`, `activeLoads` and `assets`. `events` is the last 256 events (`load-start`, `loaded`, `evict`, `failed`), each with the update count (`tick`), and `onEvent` receives them as they happen. `settled()` resolves when no load is in flight, for a loading screen.

## Limits

At most 4096 assets, 8 levels per asset and 32 loaders. `budgetBytes` is at least 1. Bad input throws an error that says what to pass instead.

## Crossing a large world

`npm run benchmark:streaming` crosses a seeded world of 576 terrain tiles (480 by 480 units, three detail levels, tiles built in workers with `createWorkerLoader`) on a scripted path through the runtime, in headless Chrome. It records frame time, long tasks over 50 ms, `replaceParts` time and resident bytes for the whole crossing, and writes `crossing-<label>.json` and a contact sheet to `--out`. `--cpu` uses SwiftShader and `--speed` sets the player speed in world units per second (above 0, at most 1000; anything else stops with a message before a browser starts). The run fails with a message if the crossing takes more than the path length over the speed plus 120 s. The world and its generator are in `bench/streaming-crossing/world.js`. `tests/streaming-crossing.test.js` runs the same crossing in Node and asserts that bytes in use never pass the budget (the budget does force evictions), that no loader starts inside a frame and that on every frame after the loading screen the tile under the player (found by column and row, as the benchmark does) is resident.

Pick a budget above what the focus wants at once: the tiles inside `loadDistance`, each at its level. A budget below that leaves loads waiting and the ground missing under the player; `stats.pending` and the events show it. Measured on the benchmark world with a budget too large to bind: the crossing holds at most 16,098,432 bytes (15.35 MiB) in use at once, counting in-flight reservations and both levels of a tile during a level switch. The default is 20 MiB, about 30 percent above that peak; three GPU crossings at 16 or 20 MiB peaked at 15.8 to 16.2 MB with 0 frames without ground. A budget that sits just above the peak leaves little room for load timing to shift which tiles are resident, so keep headroom. A renderer that draws the resident tiles should call `replaceParts(parts, { retainedUnchanged: true })` when the resident set changes, so batches that did not change are not synced again.

Not yet: culling for instanced groups, and a run on a mid laptop (#776).
