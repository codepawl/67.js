# Input: sources, actions and axes

`67js/addons/input` reads devices for a live game. Game logic asks for `jump` or `moveX`, never for `Space`. Any source can register, so a MIDI pad, a touch stick, a webcam tracker, a replay file or an agent plugs in the same way as a keyboard. Like the [runtime](runtime.md), it loads only when imported and adds no dependency.

```js
import { createRuntime } from '67js/addons/runtime';
import { createInput, keyboardSource, mouseSource, gamepadSource } from '67js/addons/input';

const input = createInput({
  sources: [keyboardSource(), mouseSource({ target: canvas }), gamepadSource()],
  actions: { jump: ['keyboard/Space', 'gamepad/0.button0'], shoot: ['mouse/button0'] },
  axes: {
    moveX: { bindings: ['keyboard/KeyD', { control: 'keyboard/KeyA', scale: -1 }, 'gamepad/0.axis0'], deadZone: 0.15 },
  },
});

const player = {
  name: 'player',
  fixedUpdate(step) {
    if (input.wasPressed('jump')) velocity = 6;
    x += input.getAxis('moveX') * speed * step;
  },
};
createRuntime(renderer, { systems: [input, player] }).start(); // input first, so game systems read this step's state
```

`input` is a runtime system. Put it first in `systems`. It attaches its sources in `init` and removes every listener in `dispose`.

## Controls and sampling

Every value has a control name, `<source>/<name>`: `keyboard/Space`, `mouse/button0`, `gamepad/0.axis1`. A button is 0 or 1; an axis is -1 to 1 (or any number, such as a pixel position). A control counts as down at `buttonThreshold` (default 0.5).

Events change the live state at any time, but game code reads a snapshot taken by `sample()`. The runtime calls it once per fixed step, so every system in that step sees the same state. When one frame runs several fixed steps, the first step sees the new press and release edges and later steps see none. A press and release between two samples still reports `wasPressed` and `wasReleased` once. In `'variable'` mode the input samples once per frame; in `'both'` mode `update` reads the last fixed-step snapshot.

| Call | Meaning |
| --- | --- |
| `isHeld(action)` | Any bound control is down |
| `wasPressed(action)`, `wasReleased(action)` | Went down or up since the previous sample |
| `getAxis(axis)` | Sum of `value * scale` over the bindings, clamped to -1 to 1, dead zone applied, then smoothing |

## Actions, axes and rebinding

`bindAction(name, controls)` and `bindAxis(name, { bindings, deadZone })` add or replace a mapping at any time, which is rebinding. A binding is a control name or `{ control, scale }`. `unbindAction` and `unbindAxis` remove one. `bindAxis` also takes `smoothing` from 0 (default, none) up to but not including 1: each sample the axis moves `1 - smoothing` of the way to its target, so `0.5` halves the gap per fixed step. It is per sample, so it stays deterministic for a replay. Rebinding resets it.

Reading a name that was never bound throws an error that shows the `bindAction` call to add.

## Built-in sources

- `keyboardSource({ target })`: `keyboard/<KeyboardEvent.code>`. Key repeat is ignored.
- `mouseSource({ target, pointerLockElement })`: `mouse/button0..`, `mouse/x`, `mouse/y` and `mouse/deltaX`, `mouse/deltaY`, which sum movement since the last sample. Pointer events cover touch and pen as `button0`. Pass `pointerLockElement` to request pointer lock on press.
- `gamepadSource({ getGamepads })`: polled each sample, `gamepad/<index>.button<n>` and `gamepad/<index>.axis<n>`. An unplugged pad reads 0.

- `touchSource({ target, sticks })`: virtual sticks and gestures from touch pointers (mouse and pen are ignored). A stick is `{ name, area: { x, y, width, height }, radius }`, the area as fractions of the target (`{ x: 0, y: 0, width: 0.5, height: 1 }` is the left half) and `radius` in pixels (default 60). The finger's first position is the centre; `touch/<name>X`, `touch/<name>Y` read -1 to 1 (down is +1) and `touch/<name>Active` is 1 while held. Touches outside every free stick are gestures: `touch/tap`, `touch/swipeLeft|Right|Up|Down` pulse for one sample, and `touch/pinch` sums the spread ratio change of two fingers since the last sample. Tune with `tapMaximumMilliseconds`, `tapMaximumDistance`, `swipeMinimumDistance`, `swipeMaximumMilliseconds`. Up to 4 sticks.
- `deviceMotionSource({ target })`: `motion/accelX|Y|Z` (m/s², with gravity), `motion/rotationAlpha|Beta|Gamma` (deg/s), `motion/alpha|beta|gamma` (degrees) and `motion/tiltX`, `motion/tiltY` (gamma and beta over 45°, clamped to -1 to 1). On iOS call `await source.requestPermission()` from a tap handler; it returns false when the user refuses.

Keyboard, mouse and touch release everything held when the window loses focus.

## Custom and scripted input

A source is `{ name, attach(emit), poll(emit), endSample(emit), dispose() }`; only `name` is required. Call `emit(controlName, value)` from your own listeners, or from `poll` each sample, and `emit.releaseAll()` to release the source's controls.

```js
input.registerSource({
  name: 'midi',
  attach(emit) { port.onmessage = message => emit(`note${message.note}`, message.velocity / 127); },
  dispose() { port.onmessage = null; },
});
input.bindAction('kick', ['midi/note36']);
```

Tests, replays and agents drive a game through the same path with `input.press('script/start')`, `input.release(...)` or `input.setControl(name, value)`.

## Recording and replay

`recordInput(input)` logs every control change with the sample number it belongs to. `stop()` returns plain JSON: `{ version: 1, samples, truncated, events: [[sample, "keyboard/Space", 1], ...] }`. `replaySource(recording, { loop })` writes those changes back during the same sample numbers under their original control names, so the game's bindings and code run unchanged, a press and release inside one sample included.

```js
const recorder = recordInput(input);        // while a player plays
const recording = recorder.stop();           // save with JSON.stringify
const replay = replaySource(recording);
const headless = createInput({ sources: [replay], actions, axes }); // same bindings, no live sources
// headless.fixedUpdate() each step; replay.finished turns true after the last sample
```

Use an input without live sources for the replay, or live devices mix in. A source that resets a pulse after a sample (a touch tap, a pinch, a mouse delta) is recorded so the reset belongs to the next sample, and replay gives the same pressed, held and released edges and axis values at every sample. When the recording ends, or the replay is unregistered, it releases and frees what it set; only a source that declares `writesAnyControl: true` may write controls under other sources' names. Control names must look like `source/name`, and a recording may touch up to 128 distinct controls. A recording holds up to 100000 events; past that `truncated` is true. Recording is only as deterministic as the game: it stores input, not game state.

`input.onControlChange(listener)` and `input.onSample(listener)` are the hooks it uses; each returns a function that removes the listener. A custom source can write any full control name with `emit.control("keyboard/Space", 1)`.

## Limits

16 sources, 512 controls, 128 actions, 64 axes, 16 bindings each (`INPUT_LIMITS`), 4 touch sticks and 100000 recorded events (`INPUT_SOURCE_LIMITS`). Errors name the field and say what to pass.

A runnable sample is `bench/runtime-loop/index.html`: A/D or the arrow keys slide the cube, Space kicks the ball.
