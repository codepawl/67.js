# Images and films

67js turns a scene into a PNG or an MP4 from the repository checkout. The exporter renders in headless Chrome, plans the render size against a memory budget and sends each frame to FFmpeg. The commands run from a source checkout, not from an installed npm package.

## Plan a render before you run it

`planRenderSize` is the same budget planner that the exporter uses. Pick a preset, change the samples or turn on HDR and bloom, and watch the frame shrink when the estimated memory passes the budget. The console prints the plan. This example draws on a 2D canvas, so it costs no WebGL context.

```js live poster=films-budget
import { RENDER_PRESETS, planRenderSize, estimateFrameBytes } from '67js';

const canvas = document.querySelector('#scene');
const context = canvas.getContext('2d');
const state = { preset: 'balanced', samples: 4, hdr: false, bloom: false, pixelRatio: 1 };
const mebibyte = 1024 * 1024;

function plan() {
  const preset = RENDER_PRESETS[state.preset];
  return planRenderSize({
    width: preset.width,
    height: preset.height,
    pixelRatio: state.pixelRatio,
    samples: state.samples,
    memoryBudgetMiB: preset.memoryBudgetMiB,
    hdr: state.hdr,
    bloom: state.bloom,
  });
}

function draw() {
  const result = plan();
  const preset = RENDER_PRESETS[state.preset];
  const ratio = devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * ratio);
  canvas.height = Math.round(canvas.clientHeight * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  context.fillStyle = '#101014';
  context.fillRect(0, 0, width, height);
  const scale = Math.min((width - 40) / (preset.width * state.pixelRatio), (height - 90) / (preset.height * state.pixelRatio));
  const requestedWidth = preset.width * state.pixelRatio * scale;
  const requestedHeight = preset.height * state.pixelRatio * scale;
  context.strokeStyle = '#667';
  context.setLineDash([5, 4]);
  context.strokeRect(20, 20, requestedWidth, requestedHeight);
  context.setLineDash([]);
  context.fillStyle = result.reduced ? '#d98a4a' : '#4aa3d9';
  context.fillRect(20, 20, result.width * scale, result.height * scale);
  context.fillStyle = '#fff';
  context.font = '13px system-ui';
  context.fillText(`${result.width} x ${result.height}${result.reduced ? ' (reduced)' : ''}`, 30, 40);
  const used = result.estimatedBytes / mebibyte;
  context.fillText(`${used.toFixed(1)} of ${result.memoryBudgetMiB} MiB`, 30, 60);
  context.fillStyle = '#334';
  context.fillRect(20, height - 40, width - 40, 10);
  context.fillStyle = used > result.memoryBudgetMiB * 0.95 ? '#d98a4a' : '#4aa3d9';
  context.fillRect(20, height - 40, (width - 40) * Math.min(1, used / result.memoryBudgetMiB), 10);
}

function report() {
  const result = plan();
  console.log(`${state.preset}, ${state.samples} samples, hdr ${state.hdr}, bloom ${state.bloom}`);
  console.log(result);
  console.log('frame targets only, MiB:', estimateFrameBytes(result.width, result.height, state.samples, 2048, { hdr: state.hdr, bloom: state.bloom }) / mebibyte);
}

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
for (const name of Object.keys(RENDER_PRESETS)) {
  const button = document.createElement('button');
  button.textContent = name;
  button.addEventListener('click', () => { state.preset = name; draw(); report(); });
  bar.append(button);
}
const samples = document.createElement('input');
samples.type = 'range';
samples.min = 1;
samples.max = 8;
samples.step = 1;
samples.value = state.samples;
samples.addEventListener('input', () => { state.samples = Number(samples.value); draw(); });
samples.addEventListener('change', report);
bar.append('samples', samples);
for (const key of ['hdr', 'bloom', 'doubleResolution']) {
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.addEventListener('change', () => { state[key] = box.checked; if (key === 'doubleResolution') state.pixelRatio = box.checked ? 2 : 1; draw(); report(); });
  label.append(box, key);
  bar.append(label);
}
document.body.append(bar);
new ResizeObserver(draw).observe(canvas);
draw();
report();
```

The planner counts geometry, textures and mipmaps, shadows, MSAA, HDR, bloom and one capture staging frame, and it reduces the render dimensions when it must. This is an estimated allocation budget, not a hard process RAM or VRAM cap. Driver and browser allocations can still fail, and sampled browser JS heap and Node RSS do not measure total graphics memory.

## Render from the command line

```sh
npm run render -- --scene motion --kind image --backend gpu --time 3 --output artifacts/frame.png
npm run render -- --scene motion --kind video --backend gpu --encoder cpu --preset balanced --duration 12 --fps 24 --memory 384 --output artifacts/film.mp4
npm run render -- --scene motion --kind video --backend cpu --preset cpu --aspect portrait --duration 2 --output artifacts/cpu-trial.mp4
```

Install the checkout's dependencies and provide Chrome and FFmpeg. The exporter reports missing tools. On Windows it uses Chrome's standard install path and `~/.local/bin/ffmpeg.exe`.

| Option | Values | Meaning |
| --- | --- | --- |
| `--scene` | `object`, `nature`, `film`, `motion`, `view2d`, `assets` | The scene to render. `--asset path/model.glb` goes with `assets`. |
| `--kind` | `image`, `video` | A PNG or an MP4. |
| `--backend` | `gpu`, `cpu` | GPU rasterization or the CPU path. |
| `--encoder` | `gpu`, `cpu` | `gpu` needs NVENC. GPU rasterization and GPU encoding are independent. |
| `--preset` | `preview`, `balanced`, `high`, `cpu` | Dimensions, samples, fps and memory (table below). |
| `--aspect` | `landscape`, `portrait`, `square` | The frame shape. |
| `--width`, `--height` | numbers | Set dimensions. Video needs even values. |
| `--time`, `--duration`, `--fps`, `--start` | seconds, frames per second | One frame time, a video length and a range start. |
| `--memory` | MiB | The memory budget for the plan. |
| `--assembly 1` | 0 to 1 | Renders an exploded object for inspection. |
| `--audio` | file | Selects original film audio. Other scenes default to silent. |

The presets come from `RENDER_PRESETS`:

| Preset | Size | Samples | fps | Budget |
| --- | --- | --- | --- | --- |
| `preview` | 960 x 540 | 2 | 24 | 256 MiB |
| `balanced` | 1280 x 720 | 4 | 24 | 384 MiB |
| `high` | 1920 x 1080 | 4 | 24 | 512 MiB |
| `cpu` | 640 x 360 | 1 | 12 | 192 MiB |

The exporter keeps one pending capture and respects encoder backpressure, so memory does not grow with the length of a film.

Export one short trial before a full film. Inspect the output JSON and FFprobe for backend, dimensions, duration, frame count and audio.

## Common mistakes

- Running `npm run render` from an installed package. The commands live in the checkout.
- Odd video dimensions. Use even `--width` and `--height`.
- Asking for `--encoder gpu` on a machine without NVENC. Use `--encoder cpu`.
- Starting several GPU exports at once. They compete for the same card.
- Skipping the trial. Check a 2 second clip first, then render the full film.
