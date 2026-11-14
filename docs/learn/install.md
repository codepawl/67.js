# Install

This page makes a new web project and adds Crucible to it. At the end, you have a project that the first-scene tutorial builds on.

## Before you start

You need these two things:

- **Node.js 20.19 or later.** Run `node --version` to see your version. Get Node.js from [nodejs.org](https://nodejs.org/).
- **A browser with WebGL2.** Current Chrome, Edge, Firefox and Safari have it.

```check webgl2
```

## 1. Make a project

Make a new project with Vite. Vite is a development server that loads npm packages in the browser.

```sh install
npm create vite@latest my-scene -- --template vanilla
```

Go into the folder and install its packages:

```sh
cd my-scene
npm install
```

The `my-scene` folder now has `index.html`, `package.json` and a `src` folder.

## 2. Add Crucible

Install the package with the name `crucible`:

```sh install
npm install crucible@npm:@codepawlhq/crucible
```

The package on npm is `@codepawlhq/crucible`. The `crucible@npm:` part gives it the shorter name `crucible`, so your code writes `import { CrucibleRenderer } from 'crucible'`. If you install it without that part, import from `@codepawlhq/crucible` instead.

## 3. Check the install

Run this command in the project folder:

```sh
npm ls Crucible
```

It prints the installed version:

```text
my-scene@0.0.0
`-- crucible@npm:@codepawlhq/crucible@0.15.0
```

Your version can be newer. The [changelog](/changelog.html) lists what each version adds.

## Use Crucible without npm

A plain HTML page can import Crucible from this site. Use the exact `module` URL from the [release metadata](/release.json). The URL contains the version, so a release does not change your page.

```html
<script type="importmap">
  { "imports": { "crucible": "https://crucible.codepawl.com/releases/0.15.0/67.module.js" } }
</script>
<script type="module">
  import { CrucibleRenderer, box } from 'crucible';
</script>
```

Serve the page over HTTP, for example with `npx serve`. A page opened from a `file://` path cannot import modules. This file has the core only. Addons such as `crucible/addons/gltf` need the npm package.

## Use Crucible from jsdelivr

From version 0.20.0 the npm package holds one self-contained module, `build/67.standalone.js`. It has no relative imports, so jsdelivr (and unpkg) serve it from one URL. Pin the version in the URL. This works in a plain HTML file and in a claude.ai artifact, which loads scripts only from cdnjs, jsdelivr and unpkg.

```html
<canvas id="view" width="640" height="400"></canvas>
<script type="module">
  import { CrucibleRenderer, box } from 'https://cdn.jsdelivr.net/npm/@codepawlhq/crucible@0.20.0/build/67.standalone.js';

  const parts = [{
    name: 'Cube',
    geometry: box(),
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    material: { color: [0.8, 0.3, 0.2], metallic: 0, roughness: 0.4, emission: 0 },
  }];
  const renderer = new CrucibleRenderer(document.querySelector('#view'), parts, { samples: 4 });
  renderer.render({ eye: [2.5, 2, 3.5], target: [0, 0, 0] });
</script>
```

The file has the core only. Addons such as `crucible/addons/gltf` need the npm package. Versions before 0.20.0 have no standalone file; their `build/67.module.js` also loads from jsdelivr, but it imports 16 chunk files.

## Good to know

> **Note:** Crucible is plain JavaScript and has no TypeScript types. In a strict TypeScript project, add the line `declare module 'crucible';` to a `.d.ts` file. The imports then have the type `any`.

> **Tip:** Addons are separate imports, such as `crucible/addons/gltf` for GLB models. You only download the addons that you import.

```cards
Next: your first scene | #first-scene | Draw, color, place and animate shapes step by step.
```
