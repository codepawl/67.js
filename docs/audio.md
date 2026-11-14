# Audio: spatial sound for a live game

`crucible/addons/audio` plays sounds tied to what happens in the world: a ball hits the floor, a clip reaches a footstep marker, the player presses a key, a vehicle drives past. It is a [runtime](runtime.md) system on Web Audio. It loads only when imported and adds no dependency.

```js
import { createRuntime } from 'crucible/addons/runtime';
import { createInput } from 'crucible/addons/input';
import { createAudio } from 'crucible/addons/audio';

const audio = createAudio({
  input,                                   // from createInput; optional
  listener: () => cameraFrame,             // { eye, target, up }: the listener follows the camera
});
await audio.load('thud', '/sounds/thud.ogg', { spatial: { referenceDistance: 2 } });
await audio.load('hop', '/sounds/hop.ogg');
audio.bindEvent('contact', 'thud', { volume: data => Math.min(1, data.impulse / 20) });
audio.bindAction('jump', 'hop');

createRuntime(renderer, { systems: [input, audio, game] }).start(); // audio after input
```

Browsers keep audio silent until the page has had a user gesture. The audio starts on the first `pointerdown`, `keydown` or `touchend`; call `audio.unlock()` yourself if your own button starts the game.

## Sounds

`defineSound(name, { buffer, bus, volume, pitch, pitchVariance, loop, maximumInstances, spatial })` takes a decoded `AudioBuffer`. `await load(name, source, definition)` decodes a URL, an `ArrayBuffer` or an `AudioBuffer` first. `volume` is 0 to 4, `pitch` is a playback-rate multiplier from 0.1 to 4, and `pitchVariance` (0 to 1) varies the pitch of each play from a seeded generator (`createAudio({ seed })`), so a replay sounds the same. `maximumInstances` (default 8) stops the oldest copy of a sound when it plays again.

A sound without `spatial` is flat, like music or a menu click. `spatial: true` or `{ referenceDistance, maximumDistance, rolloff, model, occlusion }` places it in the world with HRTF panning. `model` is `'inverse'` (default), `'linear'` or `'exponential'`, as in the Web Audio specification. `rolloff` is 0 to 20, or 0 to 1 for `'linear'`. A voice whose node function stops returning a position is stopped, and a bad occlusion result is clamped to 0 to 1.

## Playing

- `play(name, { position, node, volume, pitch, loop })` starts a sound. A spatial sound needs `position: [x, y, z]` or a `node`. It returns a handle `{ stop(), playing, level }`, or `null` when the voice limit is full of louder sounds.
- A node is `{ position }`, `{ matrix }` (4x4, column-major, so a part's matrix works) or a function returning either. `attach(node, name)` is `play` with `loop: true` on a node: the sound follows the node every frame until `stop()`.
- `stopAll(name?)`, `activeVoices()` (name, bus, volume, pitch, position and `level` of every playing voice).
- At most `maximumVoices` sounds play at once (default 32, up to 64). A new sound quieter than all of them is dropped; a louder one replaces the quietest.

## Triggers

`bindEvent(event, sound, { volume, pitch, position, node })` plays the sound whenever `emit(event, data)` runs. `volume`, `pitch` and `position` are a value or a function of the event data, which is how an impact sets the loudness. `bindEvent` returns a function that removes the binding. Game code calls `emit` itself; the helpers below cover the common sources.

| Source | Call | Event fired |
| --- | --- | --- |
| Input action | `bindAction('jump', 'hop')`; the system checks `input.wasPressed` each fixed step, or each frame when the runtime mode is `'variable'` | `input:jump`, once per press |
| Physics contacts | `emitContacts(scene.contactEvents, { position })` | `contact` or `sensor` for each started event, plus `contact:<collider>` for both colliders |
| Animation markers | `emitMarkers(markers, previousTime, currentTime, { loop, duration, data })` | `marker:<name>` for each `{ time, name }` crossed |

`markersCrossed(markers, from, to, { loop, duration })` is the pure function behind `emitMarkers`. A marker fires once when the clip time passes it, and a loop wrap fires the markers at both ends. Pass `data: { position }` so the sound comes from the character, or bind with `position: data => ...`.

## Listener, distance and occlusion

The listener follows the camera: pass `listener: () => frame` to `createAudio` (the same `{ eye, target, up }` your runtime `frame` returns), or call `setListener(frame)` yourself. Distance falloff is the Web Audio distance model, and the predicted level (`handle.level`) uses the same formula (`distanceGain`), so a test can check it.

Occlusion is opt in. Pass `occlusion: (listenerPosition, sourcePosition) => 0..1` to `createAudio` (for example a ray cast against your walls from [scene query](scene-query.md)) and set `spatial: { occlusion: true }` on the sounds that should use it. An occluded sound loses up to 70% of its level and is muffled by a low-pass filter that falls to 400 Hz.

## Buses and the limiter

Every sound plays on a bus: `music`, `effects` (the default) or `voice`; `createBus(name, volume)` adds more (16 at most). `setBusVolume(name, volume)` sets one, and `'master'` scales all of them. The graph ends in a compressor set as a limiter (ratio 20, threshold -1 dB), so a pile of loud sounds does not clip.

## Another backend

The system talks only to a backend object: `init`, `dispose`, `unlock`, `decode`, `createBus`, `setBusVolume`, `setListener` and `startVoice(options)` which returns `{ update(change), stop() }`. `createAudio({ backend })` takes any such object, so a native or middleware backend can replace Web Audio without touching game code. `webAudioBackend({ createContext, gestureTarget, fetch })` is the default; tests pass a fake `AudioContext` through `createContext`.

## Limits

256 sounds, 256 bindings, 16 buses, 64 voices, 512 markers per call (`AUDIO_LIMITS`). Errors name the field and say what to pass.

A runnable sample is `bench/runtime-loop/index.html`: the ball's bounce is a contact sound (louder when it lands harder), the cube ticks at each half turn from an animation marker, and Space plays a hop through an input action.
