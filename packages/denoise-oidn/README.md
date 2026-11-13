# @codepawlhq/67js-denoise-oidn

Optional native denoiser for 67js path traced stills: [Intel Open Image Denoise](https://github.com/RenderKit/oidn) (Apache-2.0) 2.5.1, called through its official `oidnDenoise` tool with the colour, albedo and normal images the tracer already writes. It is not part of the core `67js` archive.

```sh
npm install @codepawlhq/67js-denoise-oidn
npm run fetch --prefix node_modules/@codepawlhq/67js-denoise-oidn   # downloads the release for this platform into ./vendor after a SHA-256 check
```

Then ask a render job for it: `settings.renderer: { type: "pathTracer", denoise: "oidn" }`. Samples default to 16 for `oidn`. If the package or its binary is missing, the job uses the wavelet filter (the GPU a-trous filter of the native tracer on `backend: "native"`) and says so in `metrics.pathTracer.denoiserNote`. `OIDN_DENOISE_PATH` points at an `oidnDenoise` you installed yourself.

A render job on `backend: "native"` keeps one OIDN device and filter alive in the Cook addon, so the second and later frames skip the process start, the device creation, the weights load and the PFM files. It needs the shared library from the same release (`findOidnLibrary()` looks next to the tool, in `OIDN_LIBRARY_PATH` and in ./vendor) and a built addon; without either, the job runs the `oidnDenoise` tool as before and `metrics.pathTracer.denoiserNote` says why. The report's `oidnMode` is `"in-process"` or `"cli"`.

```js
import { createNativeOidnDenoiser } from '@codepawlhq/cook';
import { createOidnDenoiser } from '@codepawlhq/67js-denoise-oidn';

const denoiser = createOidnDenoiser({ createNative: createNativeOidnDenoiser, device: 'cuda' }); // throws, with what to install, when the library or addon is missing
const filtered = await denoiser.denoise({ width, height, color, albedo, normal }); // the first call commits the filter; a changed size recommits
denoiser.lastTimings; // { recommitted, commitSeconds, writeSeconds, executeSeconds, readSeconds } of the last call
denoiser.close();
```

`denoiseWithOidn({ width, height, color, albedo, normal })` takes row-major `Float32Array`s with three floats per pixel and returns the filtered colour. It runs on the CPU by default, so the GPU stays free and the result does not depend on a graphics driver. On one machine the same input gave the same bytes twice (measured).
