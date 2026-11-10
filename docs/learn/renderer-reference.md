# Renderer reference

`new Renderer67(canvas, parts, options)` owns GPU geometry, texture and target allocations. Construct a new renderer for a new graph, and call `dispose()` to release the resources it owns.

## Constructor options

| Option | Default | Purpose |
| --- | --- | --- |
| `batching` | true | Share instance batches by geometry and map identity |
| `pixelRatio` | 1.5 | Render scale relative to CSS size. Not automatically devicePixelRatio |
| `ground` | true | Add the studio floor at y 0.019, or 2% up from the lowest point of a scene it would bury more than a tenth of (small objects, scenes below y 0). Disable for worlds, 2D and assets |
| `world` | false | Enable outdoor rendering and world clipping defaults |
| `samples` | 4 | Requested MSAA count. Negotiated against hardware |
| `hdr` | false | Request floating-point color targets |
| `depth` | false | Keep a resolved depth texture across frames. [Volume fog](#local-lights-and-volume-fog) needs it |
| (compact colour) | off | `useCompactColor(renderer)` from `@codepawlhq/67js/addons/compact-color` stores the HDR frame and its multisample colour as R11F_G11F_B10F instead of RGBA16F: 39.55 MB less at 1920 x 1080 with 4 samples (110.92 to 71.37 MB). The format has no alpha, so it needs `hdr: true` and an opaque canvas and throws otherwise; it also throws when the device does not support the renderer's sample count in that format. Mean FLIP against the default is 0.002 to 0.030 (median 0.021) over the 26 reference scenes. Without the call nothing changes. `renderer.memoryReport()` lists the formats |
| `memoryBudgetMiB` | sized to the scene | Estimated render allocation budget. Without it the renderer takes room for the scene and one full frame: at least 256 MiB, at most 1024 MiB on a device reporting 8 GiB of memory or more (512 MiB otherwise). A scene over the budget fails with an error that names the bytes and the `memoryBudgetMiB` that fits. |
| `environment` | {} | Sky, light and fog settings |
| `shadowBounds` | {} | Custom extent, eye and target for shadow framing |
| `benchmark` | false | Diagnostic flat shader. Not the appearance renderer |
| `shading` | 'full' | `'light'` is a cheaper picture for weak machines and software rendering: at most 2 MSAA samples, one shadow fetch, a fitted BRDF, the sky reflected by its blurred irradiance, no second order irradiance. `'full'` is unchanged |

## Try the options

Change an option and the example builds a new renderer with it, then prints what the renderer reports: the render size it planned, the estimated memory, the negotiated MSAA count and whether HDR was granted. This is the information to read before you trust a frame.

```js live poster=renderer-options
import { Renderer67, box, sphere, torus } from '67js';

function placeAt(x, y, z, size) {
  return new Float32Array([size, 0, 0, 0, 0, size, 0, 0, 0, 0, size, 0, x, y, z, 1]);
}

const parts = [
  { name: 'Block', geometry: box(0.08, 4), matrix: placeAt(-1.6, 0.5, 0, 1), material: { color: [0.3, 0.45, 0.7], metallic: 0, roughness: 0.5 } },
  { name: 'Ball', geometry: sphere(48, 30), matrix: placeAt(0, 0.5, 0, 0.5), material: { color: [0.9, 0.62, 0.2], metallic: 0.8, roughness: 0.25 } },
  { name: 'Ring', geometry: torus(0.14, 64, 20), matrix: placeAt(1.6, 0.6, 0, 0.5), material: { color: [0.8, 0.3, 0.3], metallic: 0, roughness: 0.4 } },
];

const canvas = document.querySelector('#scene');
const settings = { ground: true, hdr: false, samples: 4, pixelRatio: 1.5, shading: 'full' };
let renderer = null;

function build() {
  renderer?.dispose();
  renderer = new Renderer67(canvas, parts, { ...settings });
  renderer.resize();
  renderer.render({ eye: [0, 2.6, 6], target: [0, 0.4, 0], fov: 38 });
  const plan = renderer.memoryPlan;
  console.log(`options ${JSON.stringify(settings)}`);
  console.log(`  planned ${plan.width} x ${plan.height}, estimated ${(plan.estimatedBytes / 1048576).toFixed(1)} MiB of ${plan.memoryBudgetMiB} MiB, reduced ${plan.reduced}`);
  console.log(`  capabilities ${JSON.stringify(renderer.capabilities)}`);
  console.log(`  triangles ${renderer.triangles}, batches ${renderer.batches.length}, cpu ${renderer.cpuMilliseconds.toFixed(2)} ms`);
}

const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;left:12px;bottom:12px;display:grid;gap:6px;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
function addRow(label, control) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between';
  row.append(label, control);
  panel.append(row);
}
function checkbox(key) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = settings[key];
  input.addEventListener('change', () => {
    settings[key] = input.checked;
    build();
  });
  return input;
}
function choice(key, values) {
  const select = document.createElement('select');
  for (const value of values) select.add(new Option(String(value), String(value)));
  select.value = String(settings[key]);
  select.addEventListener('change', () => {
    settings[key] = typeof settings[key] === 'number' ? Number(select.value) : select.value;
    build();
  });
  return select;
}
addRow('ground', checkbox('ground'));
addRow('hdr', checkbox('hdr'));
addRow('samples', choice('samples', [1, 2, 4]));
addRow('pixelRatio', choice('pixelRatio', [0.5, 1, 1.5, 2]));
addRow('shading', choice('shading', ['full', 'light']));
document.body.append(panel);

new ResizeObserver(() => {
  renderer.resize();
  renderer.render({ eye: [0, 2.6, 6], target: [0, 0.4, 0], fov: 38 });
}).observe(canvas);
build();
```

Turn `ground` off and the studio floor and its shadows disappear. Lower `pixelRatio` and the planned width and height shrink with it, and so does the estimate. `hdr` asks for floating-point targets: read `capabilities.hdr`, because the request can be refused (`hdrFallbackReason` says why). `samples` is a request, and `capabilities.samples` is what the hardware gave. `shading: 'light'` caps MSAA at 2 samples.

## Memory budget

`memoryBudgetMiB` caps the estimate of the render allocation. When the frame at the requested size would pass the budget, the planner reduces the render width and height instead, and the plan says `reduced: true`. Drag the slider to see it happen.

```js live poster=renderer-budget
import { Renderer67, sphere } from '67js';

const parts = [{
  name: 'Ball',
  geometry: sphere(48, 30),
  matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  material: { color: [0.3, 0.55, 0.8], metallic: 0.2, roughness: 0.35 },
}];

const canvas = document.querySelector('#scene');
let renderer = null;
const draw = () => renderer.render({ eye: [0, 1, 3.5], target: [0, 0, 0], fov: 38 });

function build(budget) {
  renderer?.dispose();
  try {
    renderer = new Renderer67(canvas, parts, { ground: false, hdr: true, pixelRatio: 2, samples: 4, memoryBudgetMiB: budget });
  } catch (error) {
    console.log(`budget ${budget} MiB: ${error.message}`);
    return;
  }
  renderer.resize();
  draw();
  const plan = renderer.memoryPlan;
  console.log(`budget ${budget} MiB: planned ${plan.width} x ${plan.height}, estimated ${(plan.estimatedBytes / 1048576).toFixed(1)} MiB, reduced ${plan.reduced}`);
}

const row = document.createElement('label');
row.style.cssText = 'position:fixed;left:12px;bottom:12px;display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
const slider = document.createElement('input');
Object.assign(slider, { type: 'range', min: 16, max: 512, step: 16, value: 256 });
slider.addEventListener('change', () => build(Number(slider.value)));
row.append('memoryBudgetMiB', slider);
document.body.append(row);

new ResizeObserver(() => {
  renderer?.resize();
  if (renderer) draw();
}).observe(canvas);
build(256);
```

With a small budget the picture gets softer because the render targets are smaller than the canvas needs. A budget too small for even the scene's geometry throws an error that names the bytes and the `memoryBudgetMiB` that fits. Read `memoryPlan` for the actual `width`, `height`, `estimatedBytes` and `reduced` status.

## Methods and fields

`render(frame)` draws synchronously. `resize()` replans targets after CSS size or `pixelRatio` changes. `updateParts(parts, { shadows: true })` uploads changed matrices and materials using retained buffers. It does not add new part, geometry or texture identities.

`updateTexture(descriptor, { image?, region? })` pushes new pixels into a texture the renderer already uploaded, such as a live canvas or a simulation. Import `@codepawlhq/67js/addons/texture-update` first. `docs/material-maps.md` has the options.

Read these fields for diagnostics:

| Field | Meaning |
| --- | --- |
| `memoryPlan` | Actual `width`, `height`, `estimatedBytes` and `reduced` status. |
| `capabilities` | HDR and MSAA negotiation: `hdr`, `hdrRequested`, `hdrFallbackReason` and `samples`. |
| `triangles` | Triangles of the part list. |
| `batches.length` | Instance batches. Shared geometry keeps it small. |
| `cpuMilliseconds` | CPU submission time of the last `render`. It is not GPU frame time. |
| `diagnostics` | Warnings about the last frame, such as `coplanar-overlap` when [that check is installed](#contact-detection). |

## Common mistakes

- **Treating `pixelRatio` as `devicePixelRatio`.** The default is 1.5 and it is not copied from the device. Set it yourself.
- **Reading `cpuMilliseconds` as frame time.** It measures CPU submission only.
- **Asking for `hdr: true` and assuming it was granted.** Check `capabilities.hdr`. Features that need float targets, such as volume fog and environment maps, depend on it.
- **Reusing a renderer for a new graph.** Construct a new renderer, and `dispose()` the old one so its GPU allocations are released.
- **Expecting `updateParts` to add a part.** It uploads changed matrices and materials only.
- **Leaving the studio floor on in a world or an asset view.** Pass `ground: false` for worlds, 2D and assets.
- **Using `benchmark: true` to judge appearance.** It is a diagnostic flat shader, not the appearance renderer.
