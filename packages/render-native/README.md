# @codepawlhq/67js-render-native

Optional. Traces a 67js scene on the GPU with hardware ray queries (wgpu, Vulkan) instead of the browser's software BVH walk. It uses the same WGSL path tracer as the browser kernel, so one seed gives the same picture. It is not a root dependency and no render job calls it yet.

Needs Rust (stable) and a Vulkan GPU with ray queries. On Windows build for MSVC; the default GNU toolchain crashes any wgpu 30 program. The DX12 backend does not report ray queries, so the addon uses Vulkan only.

```sh
npm run build   # cargo build --release, copies build/render-native.node
```

```js
import { buildNativeInput, traceNative } from '@codepawlhq/67js-render-native';
import * as pack from '<engine>/src/path-tracer-gpu-pack.js';

const options = { width: 1920, height: 1080, samples: 64, bounces: 8, seed: 0 };
const input = buildNativeInput(traceScene, camera, options, pack);
const { rgba, adapter, tracedSeconds } = traceNative(input, options);
```

`rgba` is linear float RGBA, rows from the top, averaged over the samples. `bench/native-tracer` compares it with the browser kernel.
