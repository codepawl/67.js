# Runtime: a live game loop

`67js/addons/runtime` drives a renderer live. Films do not use it: a film renders every frame as a pure function of time and stays deterministic. The runtime is for a browser game, where a player, a script or a network message changes the next frame.

It loads only when imported, adds no dependency, and does not touch the film path.

```js
import { Renderer67 } from '67js';
import { createRuntime } from '67js/addons/runtime';

const renderer = new Renderer67(canvas, parts);
const runtime = createRuntime(renderer, {
  mode: 'both',
  fixedRate: 60,
  frame: context => ({ eye: [0, 3, 8], target: [0, 1, 0], time: context.elapsedSeconds }),
  systems: [inputSystem, physicsSystem, gameSystem],
});
runtime.start();
```

A runnable sample is `bench/runtime-loop/index.html` (`npm run dev`, then open `/bench/runtime-loop/`). It switches between the three modes and shows the frame-time readout.

## Update modes

| `mode` | Calls per frame | `context.alpha` |
| --- | --- | --- |
| `'fixed'` | `fixedUpdate(step)` as many times as whole steps fit in the elapsed time | `1` |
| `'variable'` | `update(deltaSeconds)` once | `1` |
| `'both'` (default) | `fixedUpdate` for the whole steps, then `update(deltaSeconds)` once | leftover time divided by the step, from 0 to 1 |

Fixed steps use an accumulator. A frame that takes 25 ms at `fixedRate: 100` runs two steps and keeps 5 ms for the next frame. In `'both'` mode, draw the state between the last two fixed steps with `alpha`: `drawn = previous + (current - previous) * alpha`. That keeps a 20 Hz simulation smooth on a 144 Hz screen.

Two guards stop a slow frame from spiralling. A frame longer than `maximumFrameSeconds` (default 0.25) counts as that long, and one frame runs at most `maximumStepsPerFrame` fixed steps (default 8). Time beyond that is dropped and shows up in `stats.droppedSeconds`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `'both'` | `'fixed'`, `'variable'` or `'both'` |
| `fixedStepSeconds` or `fixedRate` | `1/60` s | The fixed step, from 1/1000 to 1 s. Pass one of the two. |
| `maximumFrameSeconds` | `0.25` | Longest frame time the simulation accepts |
| `maximumStepsPerFrame` | `8` | Cap on fixed steps in one frame, up to 1000 |
| `systems` | `[]` | System objects, in the order they run |
| `frame` | `context => ({ time })` | Returns the object passed to `target.render`. Move parts with `renderer.updateParts` here. |
| `pauseWhenHidden` | `true` | Stop frames while the tab is hidden |
| `scheduler`, `clock`, `visibility` | browser | `{ request(callback), cancel(handle) }`, `() => milliseconds` and `{ hidden, subscribe(callback) }`, injected by tests and headless runs |

The first argument is any object with `render(frame)`, such as `Renderer67`.

## Runtime methods

- `start()` initialises the systems once and schedules frames. `stop()` ends the loop and drops the partial step; systems stay initialised, so `start()` continues the same world.
- `pause()` and `resume()` hold and release the loop. The time spent paused is never simulated. A hidden tab pauses the same way and resumes when it shows again.
- `step(milliseconds)` runs one frame without a scheduler, for tests and for stepping while paused.
- `addSystem(system, index)`, `replaceSystem(name, system)`, `removeSystem(name)`, `getSystem(name)` and `systems` (the names, in order). A system added to a started runtime is initialised at once; a replaced or removed one is disposed.
- `dispose()` stops the loop and disposes every system in reverse order. The runtime cannot start again.
- `stats` is the frame-time readout: `frames`, `frameMilliseconds` (last), `averageFrameMilliseconds` and `maximumFrameMilliseconds` (last 120 frames), `framesPerSecond`, `updateMilliseconds` and `renderMilliseconds` (the last frame's split; the renderer call returns when it has submitted its work, so GPU time needs a timer query), `fixedSteps`, `lastFixedSteps`, `droppedSeconds`, `alpha` and `elapsedSeconds`.

## System interface

Physics, input, player, animation graph, audio and game code plug in as systems. A system is a plain object. Only `name` is required; leave out any hook it does not need.

```js
const system = {
  name: 'physics',               // unique string
  init(context) {},              // once, when the loop first starts (or when added to a started runtime)
  fixedUpdate(step, context) {}, // each fixed step; step is in seconds
  update(delta, context) {},     // each frame in 'variable' and 'both' mode; delta is in seconds
  dispose(context) {},           // when removed, replaced or the runtime is disposed
};
```

Rules a system can rely on:

- Systems run in array order for every hook, and dispose in reverse order. Put input first, then physics, animation, audio and game code.
- Hooks run on the page's main thread inside the frame. Keep them short; the cost shows in `stats.updateMilliseconds`.
- The `context` is one shared object, read only: `runtime`, `target`, `mode`, `fixedStepSeconds`, `deltaSeconds`, `elapsedSeconds` and `alpha`. Do not keep a copy; read it when needed.
- A hook that throws stops the loop and rethrows the error with the system and hook name in its message.
- A system does not touch the film path, so the same scene still renders a deterministic film.

Errors from the runtime name the option and say what to pass, for example `createRuntime mode must be one of fixed, variable, both`.
