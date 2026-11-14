# Render engines

A render job can ask for the native backend (`settings.renderer.backend: "native"`), which traces the scene with hardware ray queries on the GPU. Crucible does not contain that tracer. It is a render engine: a separate package that Crucible looks for when a job asks for it. The engine Crucible knows is Cook, `@codepawlhq/cook`.

If no engine is installed, nothing breaks. The job runs on the `gpu` backend (or `cpu` on a runtime without a GPU) and its report says why. The same happens when the engine has no built binary, when its pack format does not fit this Crucible, or when the machine has no Vulkan ray query adapter.

## Install Cook

```sh
npm install github:codepawl/cook
npm run build   # run inside the installed package; it compiles the binary with cargo
```

`npm run build` is a separate step, so installing never compiles anything. The built binary is optional too: without it the job falls back as described above.

## What an engine module exports

Crucible imports the module once per process and checks it (`requireRenderEngine` in `scripts/render-engine.mjs`). A module that fails the check gives one reason in the job report and the job falls back; nothing throws.

Always required:

- `describeEngine()` returns the description below as plain data. It must not load the binary.
- `findNativeAddon()` returns the path of the built binary, or `null` when it is not built.
- `traceNative(input, options)` traces one still.
- `traceNativeTexels(input, texels, options)` traces the texels of a recipe bake.

Required only when the description offers them:

- Sessions (`sessions` is set): `createNativeSession`, `planNativeSessionUpdate` and `prepareCyclesInput`, which let the frames of a sequence share one uploaded scene.
- The `atrous` denoiser: `denoiseAtrous`.
- The `oidn` denoiser: `createNativeOidnDenoiser`.

A time limit failure carries `error.code === "COOK_TIME_LIMIT"`.

## The description

```js
{
  name: 'cook',
  version: '0.1.0',
  packFormat: { version: 2, revision: 3, readsRevisions: [1, 3] },
  kernels: ['legacy', 'cycles'],
  defaultKernel: 'legacy',
  denoisers: ['none', 'atrous', 'oidn'],
  passes: [{ name: 'rgba', channels: 4 }],
  sessions: { kernels: ['cycles'], progressive: true, update: true },
  limits: { triangles: null, instances: null, pixels: 33554432, samples: 1048576 },
}
```

- `packFormat.revision` is the revision of the scene packer that ships with the engine. `readsRevisions` is the oldest and newest revision the engine reads. The scene packer used by Crucible comes from the same package, so its revision must sit inside that range; if it does not, the reason names both revisions.
- `limits` are the most the engine takes. `null` means no limit is declared and the card decides. Crucible has its own defaults for the triangle and instance counts of a job, and the job uses the lower of the two for every limit the engine declares (`clampLimitsByEngine`).

## Environment switches

| Variable | Effect |
| --- | --- |
| `COOK_PACKAGE_PATH` | A directory of a local Cook checkout. Its `index.mjs` is imported instead of the installed package. |
| `COOK_ADDON_PATH` | A binary built elsewhere. Cook reads it; a path that does not exist is an error. |
| `COOK_DISABLE=1` | Acts as if Cook is not installed. Tests, the job runner and the preview build all honour it. |
| `COOK_KERNEL` | The kernel a native job traces with. Cook falls back to `JS67_NATIVE_KERNEL` when it is not set. |
| `JS67_NATIVE_TRACER=off` | Keeps every job off the native backend whatever is installed. |

## When no engine is installed

- A native job runs on `gpu` or `cpu` and the report note says what is missing and how to install it.
- A preview page built without Cook has no scene packer. The packer calls throw "this build has no Cook scene packer; install @codepawlhq/cook and rebuild", and the job turns that into the same fallback note.
- Path traced stills and videos on the `cpu` and `gpu` backends (`renderPathTracedImage`) never use an engine, so they do not change.

## Updating the pinned Cook commit

Crucible installs Cook from one commit of its repository, named in `package.json` (`devDependencies["@codepawlhq/cook"]`). To move to a newer Cook, replace the commit after `#` with the full hash of the new one, run `npm install --package-lock-only --ignore-scripts` so `package-lock.json` follows, and open a pull request with both files. `.npmrc` sets `allow-git=root`, which npm 12 needs before it fetches a git dependency.
