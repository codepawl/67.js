# Install

This page makes a new web project and adds 67js to it. At the end, you have a project that the first-scene tutorial builds on.

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

## 2. Add 67js

Install the package with the name `67js`:

```sh install
npm install 67js@npm:@codepawlhq/67js
```

The package on npm is `@codepawlhq/67js`. The `67js@npm:` part gives it the shorter name `67js`, so your code writes `import { Renderer67 } from '67js'`. If you install it without that part, import from `@codepawlhq/67js` instead.

## 3. Check the install

Run this command in the project folder:

```sh
npm ls 67js
```

It prints the installed version:

```text
my-scene@0.0.0
`-- 67js@npm:@codepawlhq/67js@0.15.0
```

Your version can be newer. The [changelog](/changelog.html) lists what each version adds.

## Use 67js without npm

A plain HTML page can import 67js from this site. Use the exact `module` URL from the [release metadata](/release.json). The URL contains the version, so a release does not change your page.

```html
<script type="importmap">
  { "imports": { "67js": "https://67js.codepawl.com/releases/0.15.0/67.module.js" } }
</script>
<script type="module">
  import { Renderer67, box } from '67js';
</script>
```

Serve the page over HTTP, for example with `npx serve`. A page opened from a `file://` path cannot import modules. This file has the core only. Addons such as `67js/addons/gltf` need the npm package.

## Good to know

> **Note:** 67js is plain JavaScript and has no TypeScript types. In a strict TypeScript project, add the line `declare module '67js';` to a `.d.ts` file. The imports then have the type `any`.

> **Tip:** Addons are separate imports, such as `67js/addons/gltf` for GLB models. You only download the addons that you import.

```cards
Next: your first scene | #first-scene | Draw, color, place and animate shapes step by step.
```
